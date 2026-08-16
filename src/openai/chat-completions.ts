import { evictProviderClient } from "../providers/registry.ts";
import type { WebProviderClient } from "../providers/types.ts";
import { ProviderApiError, SessionExpiredError } from "../providers/types.ts";
import { compactMessages, sanitizeMaxTokens } from "../compaction.ts";
import { buildPromptFromMessages, parseToolResponse } from "../tool-calling/converter.ts";
import { makeChunk, sseDone, sseEvent, sseHeaders } from "./sse.ts";
import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ContentPart,
	ToolCallDelta,
	ToolCallOutput,
} from "./types.ts";

let _routeTimeoutMs = 300_000;

export function setRouteTimeoutSec(sec: number): void {
	_routeTimeoutMs = sec * 1000;
}

function generateId(): string {
	return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Plain text of the last user message (no "Human:" wrapper) for DOM providers. */
function extractLastUserMessage(messages: ChatCompletionRequest["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "user") continue;
		const content = (m as { content?: string | ContentPart[] }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((p) => (typeof p === "string" ? p : p?.text ?? ""))
				.filter(Boolean)
				.join(" ");
		}
	}
	return "";
}

/**
 * When the thinking button is on (reasoning_effort present), make the model
 * reason explicitly. Native-reasoning providers get the effort passed through
 * separately (the client handles it); for web-session/DOM providers we inject a
 * step-by-step directive into the prompt so the reasoning is produced and can
 * be surfaced as reasoning_content by the stream parsers.
 */
function applyReasoningDirective(
	prompt: string,
	reasoningEffort: string | number | boolean | undefined,
	providerId: string,
): string {
	if (reasoningEffort === undefined || reasoningEffort === null || reasoningEffort === false) {
		return prompt;
	}
	// These providers take effort natively (their clients forward it to the
	// upstream API) — no prompt injection needed.
	const nativeReasoning = new Set([
		"deepseek-web",
		"claude-web",
		"chatgpt-web",
	]);
	if (nativeReasoning.has(providerId)) return prompt;

	const effort = String(reasoningEffort);
	const effortLine =
		effort === "max"
			? "Think as deeply and thoroughly as possible."
			: effort === "high"
				? "Think carefully and reason step by step before answering."
				: effort === "low"
					? "Think briefly before answering."
					: "Think step by step before answering.";

	return [
		prompt,
		"",
		`[Reasoning requested: ${effortLine} Show your internal reasoning in <thinking>...</thinking> tags first, then give the final answer.]`,
	].join("\n");
}

/**
 * Decide the send strategy for a provider:
 * - NATIVE: provider supports real tool calling through its backend API. Pass
 *   the original messages + tools + tool_choice straight through and parse
 *   native tool_calls / reasoning from its stream.
 * - INJECTION: DOM-based provider (no native tool protocol). Flatten tools into
 *   the prompt and parse tool_json blocks back out (existing converter path).
 *
 * NOTE: the native path is only used when the provider's own API accepts the
 * OpenAI-style tool schema AND the push/stream loop has been verified to
 * terminate with tool_use blocks. Claude Web's native path hangs (the API
 * waits on the tool_choice and the push stream never closes), so it falls back
 * to injection. Injection is the tested, deterministic path (tool_json blocks).
 */
function useNativeTools(client: WebProviderClient, body: ChatCompletionRequest): boolean {
	if (!body.tools || body.tools.length === 0) return false;
	if (!client.supportsNativeTools) return false;
	// Web-session providers (all of them) do NOT accept OpenAI-style tools in
	// their upstream API — the native path hangs or fails. The reliable path is
	// prompt injection (tool_json blocks) for every web provider.
	// Rotator/API providers (opencode-go, nvidia, aihubmix) DO accept native
	// tools — keep the native path for those.
	const webProviders = new Set([
		"claude-web",
		"chatgpt-web",
		"deepseek-web",
		"gemini-web",
		"glm-web",
		"glm-intl-web",
		"kimi-web",
		"perplexity-web",
		"qwen-web",
		"doubao-web",
		"grok-web",
	]);
	if (webProviders.has(client.providerId)) return false;
	return true;
}

export async function handleChatCompletions(
	body: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	if (!body.messages || body.messages.length === 0) {
		return jsonError("messages is required and must not be empty", 400);
	}

	if (!body.model) {
		return jsonError("model is required", 400);
	}

	const id = generateId();
	const model = body.model;
	const native = useNativeTools(client, body);

	// Auto-compaction: trim old turns when the request exceeds the model's
	// context window, so long agent sessions never hard-fail the web provider.
	const { messages: compactedMessages, compacted, droppedTokens, budget } = compactMessages(
		model,
		body.messages,
	);
	if (compacted) {
		console.log(
			`[chat-completions] auto-compacted: ${droppedTokens} tokens dropped (budget ${budget}) for model ${model}`,
		);
		body = { ...body, messages: compactedMessages };
	}
	// Raise tiny/missing max_tokens so reasoning models don't burn their whole
	// output budget on thinking (returns empty content otherwise).
	const withSaneTokens = sanitizeMaxTokens(body);
	if (withSaneTokens !== body) {
		body = withSaneTokens;
	}

	// For native providers we still build a text prompt for the sendMessage
	// message field, but ALSO pass the structured tools + raw messages through.
	// For DOM providers we keep the full prompt-injection path.
	const { prompt, hasTools } = buildPromptFromMessages(body.messages, body.tools, body.tool_choice);

	if (!prompt) {
		return jsonError("Could not construct prompt from messages", 400);
	}

	// DOM providers (gemini/kimi/qwen/perplexity) type the message into a chat
	// box — the Anthropic-style "Human:" prefix breaks them (the UI shows it as
	// literal text and never sends). Use the plain last user message instead.
	const isDom = !client.supportsNativeTools;
	const domPrompt = isDom ? extractLastUserMessage(body.messages) : prompt;
	if (isDom && !domPrompt) {
		return jsonError("Could not construct prompt from messages", 400);
	}

	// Reasoning: when the thinking button is on (reasoning_effort set), make the
	// model actually reason. Providers with native reasoning (opencode-go,
	// nvidia, aihubmix via rotator; deepseek web) get the effort passed through
	// to their API. Web-session providers that can't take effort natively get a
	// prompt-level thinking directive so the reasoning is produced and surfaced.
	const reasoningEffort = body.reasoning_effort;
	const effectivePrompt = applyReasoningDirective(
		isDom ? domPrompt! : prompt,
		reasoningEffort,
		client.providerId,
	);

	// Persistent agentic directive: web-session models (deepseek/kimi/gemini/
	// claude) tend to answer after ONE tool round and stop. Inject an explicit
	// "keep working until done" instruction so agents drive multi-step tasks.
	const agenticPrompt =
		`${effectivePrompt}\n\n` +
		`[Agent behavior: You are an autonomous agent working on a multi-step task. ` +
		`Use the available tools continuously — do NOT stop after a single tool call or a single answer. ` +
		`After each tool result, evaluate whether the task is fully complete; if not, ` +
		`immediately make the NEXT tool call (or continue reasoning) toward completion. ` +
		`Only produce a final answer when every step of the task is genuinely done. ` +
		`Never ask "should I continue?" — just continue.]`;

	const handler = body.stream
		? handleStreaming(id, model, agenticPrompt, hasTools, native, body, client)
		: handleNonStreaming(id, model, agenticPrompt, hasTools, native, body, client);

	const timeout = new Promise<Response>((resolve) =>
		setTimeout(() => {
			console.error(`[chat-completions] Request timed out after ${_routeTimeoutMs / 1000}s`);
			resolve(jsonError("Gateway timeout: upstream provider did not respond in time", 504));
		}, _routeTimeoutMs),
	);

	const first = await Promise.race([handler, timeout]);

	// EMPTY/FALLBACK RETRY: if the response is a 200 with empty content (web
	// models sometimes return an empty turn — kimi thinking-only, deepseek
	// stale session), retry ONCE so autonomous agents never hit an empty turn
	// that stops their loop. Tool requests that fail also retry as plain chat
	// (tools stripped) since web-session models can't always tool-call.
	const firstBody = await first.clone().text();
	const isEmptyOk = first.status === 200 && (!firstBody || firstBody.length < 60);
	if (isEmptyOk || (hasTools && first.status >= 400)) {
		console.log(
			`[chat-completions] request returned empty/error (${first.status}), retrying once for ${model}`,
		);
		const retryBody: ChatCompletionRequest = hasTools
			? { ...body, tools: undefined, tool_choice: undefined }
			: body;
		const retryPrompt = buildPromptFromMessages(
			retryBody.messages,
			hasTools ? undefined : body.tools,
			hasTools ? undefined : body.tool_choice,
		).prompt;
		const retry = body.stream
			? handleStreaming(id, model, retryPrompt, hasTools, native, retryBody, client)
			: handleNonStreaming(id, model, retryPrompt, hasTools, native, retryBody, client);
		return Promise.race([retry, timeout]);
	}

	return first;
}

async function handleNonStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	native: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	try {
		const stream = await client.sendMessage({
			message: prompt,
			model,
			signal: undefined,
			reasoningEffort: body.reasoning_effort,
			...(native
				? {
						tools: body.tools,
						toolChoice: body.tool_choice,
						messages: body.messages,
						stream: false,
					}
				: {}),
		});
		const result = await client.parseStream(stream);

		let content: string | null;
		let toolCalls: ToolCallOutput[] | undefined;
		let finishReason: "stop" | "tool_calls" | "length";

		if (native && result.toolCalls && result.toolCalls.length > 0) {
			// NATIVE tool calls from the provider API.
			toolCalls = result.toolCalls.map((tc) => ({
				id: tc.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
				type: "function" as const,
				function: { name: tc.name, arguments: tc.arguments },
			}));
			content = null;
			finishReason = "tool_calls";
		} else if (hasTools) {
			// Prompt-injection fallback (DOM providers / no native calls returned).
			const parsed = parseToolResponse(result.text, body.tools);
			content = parsed.content;
			toolCalls = parsed.toolCalls;
			finishReason = parsed.finishReason;
		} else {
			content = result.text;
			finishReason = "stop";
		}

		const promptTokens = estimateTokens(prompt);
		const completionTokens = estimateTokens(result.text);

		// OpenCode's renderer doesn't display reasoning_content, so when the
		// model produced thinking we include a visible Thinking block in the
		// content (kept also as reasoning_content for clients that support it).
		let visibleContent = content;
		if (result.thinkingText && visibleContent) {
			visibleContent = `💭 Thinking:\n${result.thinkingText}\n\n${visibleContent}`;
		} else if (result.thinkingText && !visibleContent) {
			visibleContent = `💭 Thinking:\n${result.thinkingText}`;
		}

		const response: ChatCompletionResponse = {
			id,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model,
			system_fingerprint: `fp_${id.slice(-12)}`,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: visibleContent,
						...(toolCalls ? { tool_calls: toolCalls } : {}),
						// Surface reasoning/thinking text to the client (G8).
						...(result.thinkingText ? { reasoning_content: result.thinkingText } : {}),
					},
					finish_reason: finishReason,
				},
			],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			},
		};

		return Response.json(response);
	} catch (err) {
		return providerErrorResponse(err, "non-streaming");
	}
}

// ---- Streaming helpers ----

type SseWriter = {
	writeChunk(id: string, model: string, choices: Parameters<typeof makeChunk>[2]): void;
	done(): void;
	error(message: string): void;
	close(): void;
};

function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>): SseWriter {
	const encoder = new TextEncoder();
	const emit = (data: string) => controller.enqueue(encoder.encode(data));
	return {
		writeChunk(id, model, choices) {
			emit(sseEvent(JSON.stringify(makeChunk(id, model, choices))));
		},
		done() {
			emit(sseDone());
		},
		error(message: string) {
			emit(sseEvent(JSON.stringify({ error: { message, type: "server_error" } })));
		},
		close() {
			controller.close();
		},
	};
}

function emitToolCallDeltas(w: SseWriter, id: string, model: string, toolCalls: ToolCallOutput[]) {
	for (let i = 0; i < toolCalls.length; i++) {
		const tc = toolCalls[i];
		if (!tc) continue;
		const tcStart: ToolCallDelta = {
			index: i,
			id: tc.id,
			type: "function",
			function: { name: tc.function.name, arguments: "" },
		};
		w.writeChunk(id, model, [{ index: 0, delta: { tool_calls: [tcStart] }, finish_reason: null }]);
		const tcArgs: ToolCallDelta = {
			index: i,
			function: { arguments: tc.function.arguments },
		};
		w.writeChunk(id, model, [{ index: 0, delta: { tool_calls: [tcArgs] }, finish_reason: null }]);
	}
}

async function handleStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	native: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	let providerStream: ReadableStream<Uint8Array>;
	try {
		providerStream = await client.sendMessage({
			message: prompt,
			model,
			signal: undefined,
			reasoningEffort: body.reasoning_effort,
			...(native
				? {
						tools: body.tools,
						toolChoice: body.tool_choice,
						messages: body.messages,
						stream: true,
					}
				: {}),
		});
	} catch (err) {
		return providerErrorResponse(err, "streaming (pre-stream)");
	}

	const readable = new ReadableStream({
		async start(controller) {
			const w = createSseWriter(controller);
			try {
				w.writeChunk(id, model, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);

				if (native) {
					// NATIVE path: stream content deltas live, then emit reasoning
					// and tool_calls at the end (parseStream collects them).
					const collected: string[] = [];
					const result = await client.parseStream(providerStream, (delta) => {
						collected.push(delta);
						w.writeChunk(id, model, [{ index: 0, delta: { content: delta }, finish_reason: null }]);
					});
					if (result.thinkingText) {
						// Emit reasoning in one delta (after content, per OpenAI convention).
						w.writeChunk(id, model, [
							{ index: 0, delta: { reasoning_content: result.thinkingText }, finish_reason: null },
						]);
					}
					if (result.toolCalls && result.toolCalls.length > 0) {
						const calls: ToolCallOutput[] = result.toolCalls.map((tc) => ({
							id: tc.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
							type: "function" as const,
							function: { name: tc.name, arguments: tc.arguments },
						}));
						emitToolCallDeltas(w, id, model, calls);
						w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
					} else {
						w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
					}
				} else if (!hasTools) {
					await streamWithoutTools(w, id, model, providerStream, client);
				} else {
					await streamWithTools(w, id, model, providerStream, body, client);
				}

				w.done();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[chat-completions] Stream error (mid-stream): ${message}`);
				w.error(message);
				w.done();
			}
			w.close();
		},
	});

	return new Response(readable, { headers: sseHeaders() });
}

async function streamWithoutTools(
	w: SseWriter,
	id: string,
	model: string,
	providerStream: ReadableStream<Uint8Array>,
	client: WebProviderClient,
) {
	const chunks: string[] = [];
	const result = await client.parseStream(providerStream, (delta) => {
		chunks.push(delta);
		w.writeChunk(id, model, [{ index: 0, delta: { content: delta }, finish_reason: null }]);
	});
	if (result.thinkingText) {
		w.writeChunk(id, model, [
			{ index: 0, delta: { reasoning_content: result.thinkingText }, finish_reason: null },
		]);
	}
	w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
}

async function streamWithTools(
	w: SseWriter,
	id: string,
	model: string,
	providerStream: ReadableStream<Uint8Array>,
	body: ChatCompletionRequest,
	client: WebProviderClient,
) {
	const result = await client.parseStream(providerStream);
	const { content, toolCalls, finishReason } = parseToolResponse(result.text, body.tools);

	if (finishReason === "tool_calls" && toolCalls) {
		emitToolCallDeltas(w, id, model, toolCalls);
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
	} else {
		if (content) {
			w.writeChunk(id, model, [{ index: 0, delta: { content }, finish_reason: null }]);
		} else if (result.thinkingText) {
			// Thinking-only response (no final content): surface the thinking as
			// the visible content so OpenCode shows a real assistant turn instead
			// of an empty message titled "<thinking>".
			w.writeChunk(id, model, [
				{ index: 0, delta: { content: `💭 Thinking:\n${result.thinkingText}` }, finish_reason: null },
			]);
		}
		if (result.thinkingText) {
			w.writeChunk(id, model, [
				{ index: 0, delta: { reasoning_content: result.thinkingText }, finish_reason: null },
			]);
		}
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
	}
}

function jsonError(message: string, status: number): Response {
	return Response.json({ error: { message, type: "invalid_request_error" } }, { status });
}

/**
 * Map a caught provider error to an HTTP Response.
 * - SessionExpiredError → 401, evict cached client
 * - ProviderApiError    → mirror the provider's 4xx (don't wrap in 502)
 * - anything else       → 502
 */
function providerErrorResponse(err: unknown, context: string): Response {
	if (err instanceof SessionExpiredError) {
		evictProviderClient(err.providerId);
		console.error(
			`[chat-completions] ${context}: session expired for "${err.providerId}". Run 'token-free-gateway webauth'.`,
		);
		return jsonError(err.message, 401);
	}
	if (err instanceof ProviderApiError) {
		const message = err.message;
		console.error(`[chat-completions] ${context}: provider error ${err.httpStatus}: ${message}`);
		return jsonError(message, err.httpStatus);
	}
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[chat-completions] ${context}: ${message}`);
	return jsonError(message, 502);
}
