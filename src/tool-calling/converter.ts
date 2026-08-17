/**
 * Converts between OpenAI tool protocol and Claude Web text-based tool calling.
 *
 * Flow:
 * 1. buildPromptFromMessages: Converts OpenAI tools + messages into a single prompt
 * 2. parseToolResponse: Parses Claude's text response into OpenAI tool_calls format
 * 3. applyToolChoice: Enforces tool_choice semantics on both prompt and response
 */

import type {
	AssistantMessage,
	ChatMessage,
	ToolCallOutput,
	ToolChoice,
	ToolDefinition,
	ToolMessage,
} from "../openai/types.ts";
import { extractToolCalls, hasToolCall } from "./parser.ts";
import { buildToolPrompt, detectLanguage } from "./prompt.ts";

export interface ConvertedPrompt {
	prompt: string;
	/** Whether tools are active after applying tool_choice */
	hasTools: boolean;
}

function detectLang(messages: ChatMessage[]): "en" | "cn" {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : "";
			return detectLanguage(text);
		}
	}
	return "en";
}

function extractTextContent(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}

function formatAssistantMsg(msg: AssistantMessage): string | null {
	if (msg.tool_calls && msg.tool_calls.length > 0) {
		const calls = msg.tool_calls.map(
			(tc) =>
				`\`\`\`tool_json\n{"tool":"${tc.function.name}","parameters":${tc.function.arguments}}\n\`\`\``,
		);
		return `Assistant: [Called tools]\n${calls.join("\n")}`;
	}
	return msg.content ? `Assistant: ${msg.content}` : null;
}

function formatToolResult(msg: ToolMessage): string {
	return [`<tool_result tool_call_id="${msg.tool_call_id}">`, msg.content, "</tool_result>"].join(
		"\n",
	);
}

function formatMessage(msg: ChatMessage): string | null {
	switch (msg.role) {
		case "system":
		case "developer":
			return `System: ${msg.content}`;

		case "user":
			return `Human: ${extractTextContent(msg.content)}`;

		case "assistant":
			return formatAssistantMsg(msg as AssistantMessage);

		case "tool":
			return formatToolResult(msg as ToolMessage);

		// Legacy OpenAI "function" role → treat same as "tool"
		default: {
			const legacy = msg as any;
			if (legacy.role === "function" && typeof legacy.content === "string") {
				return formatToolResult({
					role: "tool",
					tool_call_id: legacy.name ?? "unknown",
					content: legacy.content,
				});
			}
			return null;
		}
	}
}

/**
 * Synthetic terminal tool. Web chat models tend to stop with plain text
 * mid-task; when the request is mid-task (last message is a tool result) we
 * append this tool and force tool use, so the model MUST keep calling tools
 * and can only end the turn by calling final_answer. The gateway intercepts
 * final_answer and converts it into a normal text response (finish=stop).
 */
export const FINAL_ANSWER_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "final_answer",
		description:
			"Call this ONLY when the entire task is fully complete and you are ready to deliver the final answer to the user. Provide the complete final answer in the 'answer' parameter.",
		parameters: {
			type: "object",
			properties: {
				answer: { type: "string", description: "The complete final answer for the user." },
			},
			required: ["answer"],
		},
	},
};

/** True when the conversation ends with a tool result — the agent is mid-task. */
export function isMidTask(messages: ChatMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last?.role === "tool" || (last as any)?.role === "function";
}

/**
 * Effective tools for a request: when mid-task, append the synthetic
 * final_answer tool so the model can terminate the loop explicitly.
 */
export function resolveRequestTools(
	tools: ToolDefinition[] | undefined,
	messages: ChatMessage[],
): ToolDefinition[] {
	if (!tools || tools.length === 0) return [];
	if (isMidTask(messages)) return [...tools, FINAL_ANSWER_TOOL];
	return tools;
}

/**
 * Convert provider-native tool calls (from StreamResult.toolCalls) into OpenAI
 * tool_calls, filtering to tools the client actually requested and intercepting
 * the synthetic final_answer tool (converted to a plain text stop response).
 * Returns finishReason "stop" with content when final_answer terminates.
 */
export function resolveNativeToolCalls(
	calls: { id?: string; name: string; arguments: string }[] | undefined,
	requestedTools: ToolDefinition[] | undefined,
): {
	content: string | null;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
} {
	if (!calls || calls.length === 0 || !requestedTools || requestedTools.length === 0) {
		return { content: null, toolCalls: undefined, finishReason: "stop" };
	}
	const validToolNames = new Set(requestedTools.map((t) => t.function.name));
	const valid = calls.filter((c) => validToolNames.has(c.name));
	if (valid.length === 0) {
		return { content: null, toolCalls: undefined, finishReason: "stop" };
	}
	const finalCall = valid.find((c) => c.name === "final_answer");
	const realCalls = valid.filter((c) => c.name !== "final_answer");
	if (finalCall && realCalls.length === 0) {
		let answer = "";
		try {
			const args = JSON.parse(finalCall.arguments) as { answer?: string };
			answer = typeof args?.answer === "string" ? args.answer : "";
		} catch {
			// fall through with empty answer
		}
		return { content: answer || null, toolCalls: undefined, finishReason: "stop" };
	}
	const toolCalls: ToolCallOutput[] = realCalls.map((tc) => ({
		id: tc.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
		type: "function" as const,
		function: { name: tc.name, arguments: tc.arguments },
	}));
	return { content: null, toolCalls, finishReason: "tool_calls" };
}

/**
 * Resolve effective tools list based on tool_choice.
 *
 * - "none" → no tools (empty list)
 * - "auto" / undefined → all tools
 * - "required" → all tools + force hint
 * - { function: { name } } → single specified tool only
 */
export function resolveEffectiveTools(
	tools: ToolDefinition[] | undefined,
	toolChoice: ToolChoice | undefined,
): { tools: ToolDefinition[]; forceUse: boolean } {
	if (!tools || tools.length === 0) return { tools: [], forceUse: false };

	if (toolChoice === "none") return { tools: [], forceUse: false };

	if (toolChoice === "required") return { tools, forceUse: true };

	if (typeof toolChoice === "object" && toolChoice.type === "function") {
		const target = toolChoice.function.name;
		const filtered = tools.filter((t) => t.function.name === target);
		return { tools: filtered, forceUse: filtered.length > 0 };
	}

	// "auto" or undefined
	return { tools, forceUse: false };
}

/**
 * Build a single prompt string from OpenAI messages + tools for Claude Web.
 */
export function buildPromptFromMessages(
	messages: ChatMessage[],
	tools?: ToolDefinition[],
	toolChoice?: ToolChoice,
	injectFinalAnswer = true,
): ConvertedPrompt {
	const midTask = injectFinalAnswer && isMidTask(messages);
	const requestTools = injectFinalAnswer ? resolveRequestTools(tools, messages) : (tools ?? []);
	const effective = resolveEffectiveTools(requestTools, toolChoice);
	// Mid-task: the agent must keep working — force a tool call (a real tool,
	// or final_answer when the model judges the task complete).
	const forceUse = effective.forceUse || (midTask && effective.tools.length > 0);
	const hasTools = effective.tools.length > 0;
	const parts: string[] = [];
	const lang = detectLang(messages);

	if (hasTools) {
		parts.push(buildToolPrompt(effective.tools, lang, forceUse));
	}

	for (const msg of messages) {
		const formatted = formatMessage(msg);
		if (formatted) parts.push(formatted);
	}

	// When the last message contains tool results, add a continuation hint.
	// On the prompt-injection path (midTask) the hint must push the agent
	// FORWARD (next tool call or final_answer), never tell it to stop and
	// answer. Native providers keep the neutral answer hint.
	const lastMsg = messages[messages.length - 1];
	const endsWithToolResult = lastMsg?.role === "tool" || (lastMsg as any)?.role === "function";
	if (endsWithToolResult) {
		parts.push(
			midTask
				? lang === "cn"
					? "任务尚未完成。继续执行：调用下一个工具推进任务；只有全部步骤真正完成时才调用 final_answer 并给出最终答案。"
					: "The task is not complete. Continue working: make the next tool call to advance the task; call final_answer with the complete final answer ONLY when every step is genuinely done."
				: lang === "cn"
					? "请根据以上工具执行结果回答用户的问题。"
					: "Please answer the user's question based on the tool results above.",
		);
	}

	return { prompt: parts.join("\n\n"), hasTools };
}

/**
 * Parse Claude's text response and detect tool calls.
 * Returns either tool_calls or plain text content.
 *
 * When tool_calls are detected, content is set to null per OpenAI standard
 * (GPT-4 returns content: null when making tool calls).
 */
export function parseToolResponse(
	text: string,
	requestedTools?: ToolDefinition[],
): {
	content: string | null;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
} {
	if (!requestedTools || requestedTools.length === 0 || !hasToolCall(text)) {
		return { content: text, toolCalls: undefined, finishReason: "stop" };
	}

	const validToolNames = new Set(requestedTools.map((t) => t.function.name));
	const parsed = extractToolCalls(text);
	const validCalls = parsed.filter((c) => validToolNames.has(c.name));

	if (validCalls.length === 0) {
		return { content: text, toolCalls: undefined, finishReason: "stop" };
	}

	// final_answer is a synthetic terminal tool: when the model calls it (and
	// nothing else), convert it into a plain text response so the client ends
	// the turn with the final answer. If real tool calls accompany it, prefer
	// the real calls (the model is still working).
	const finalCall = validCalls.find((c) => c.name === "final_answer");
	const realCalls = validCalls.filter((c) => c.name !== "final_answer");
	if (finalCall && realCalls.length === 0) {
		const answer = (finalCall.arguments as { answer?: string })?.answer;
		const content =
			typeof answer === "string" && answer.length > 0 ? answer : text;
		return { content, toolCalls: undefined, finishReason: "stop" };
	}

	const toolCalls: ToolCallOutput[] = realCalls.map((call) => ({
		id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
		type: "function" as const,
		function: {
			name: call.name,
			arguments: JSON.stringify(call.arguments),
		},
	}));

	// Per OpenAI standard: content is null when assistant produces tool_calls
	return { content: null, toolCalls, finishReason: "tool_calls" };
}
