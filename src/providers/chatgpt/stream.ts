import type { StreamResult } from "../types.ts";

export interface ChatGptStreamMeta {
	conversationId?: string;
	parentMessageId?: string;
}

/**
 * Parse ChatGPT backend-api /conversation SSE stream.
 *
 * Extracts:
 *  - incremental text deltas (streamed live via onDelta)
 *  - reasoning/thinking deltas (message content with content_type thinking, or "thinking" parts)
 *  - NATIVE tool_calls from the final assistant message (content_type multimodal_text with
 *    tool_calls, or `message.metadata.tool_calls` / `message.content[].tool_calls`).
 *
 * ChatGPT's backend uses these content shapes:
 *  - { content_type: "text", parts: ["..."] }              → plain text
 *  - { content_type: "thinking", thinking_content: "..." } → reasoning
 *  - { content_type: "multimodal_text", parts: [...], tool_calls: [...] } → tool calls
 */
export async function parseChatGPTStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
	onMeta?: (meta: ChatGptStreamMeta) => void,
	onReasoningDelta?: (delta: string) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let accumulatedContent = "";
	let text = "";
	let thinkingText = "";
	let toolCalls: { id?: string; name: string; arguments: string }[] = [];
	let sawToolCall = false;

	const processLine = (line: string) => {
		if (!line?.startsWith("data: ")) return;
		const dataStr = line.slice(6).trim();
		if (dataStr === "[DONE]" || !dataStr) return;

		try {
			const data = JSON.parse(dataStr) as {
				conversation_id?: string;
				message?: {
					id?: string;
					author?: { role?: string };
					role?: string;
					content?: {
						parts?: unknown[];
						content_type?: string;
						thinking_content?: string;
						tool_calls?: {
							id?: string;
							type?: string;
							plugin?: { name?: string };
							function_call?: { name?: string; arguments?: string };
							name?: string;
							arguments?: string;
						}[];
					};
				};
			};

			if (data.conversation_id) onMeta?.({ conversationId: data.conversation_id });
			if (data.message?.id) onMeta?.({ parentMessageId: data.message.id });

			const role = data.message?.author?.role ?? data.message?.role;
			if (role && role !== "assistant") return;

			const msg = data.message;
			if (!msg) return;
			const parts = msg.content?.parts ?? [];
			const contentType = msg.content?.content_type ?? "";

			// Native tool calls (content_type multimodal_text with tool_calls array)
			const calls = msg.content?.tool_calls;
			if (Array.isArray(calls) && calls.length > 0) {
				sawToolCall = true;
				for (const tc of calls) {
					if (!tc) continue;
					const name = tc.name ?? tc.function_call?.name ?? tc.plugin?.name ?? "";
					if (!name) continue;
					const argsRaw =
						tc.arguments ?? tc.function_call?.arguments ?? tc.plugin?.name ?? "{}";
					// arguments may be a string JSON or an object
					const argsStr =
						typeof argsRaw === "string"
							? argsRaw
							: JSON.stringify(argsRaw ?? {});
					toolCalls.push({ id: tc.id, name, arguments: argsStr });
				}
				// Do NOT also emit as text
				return;
			}

			// Thinking / reasoning content
			if (contentType === "thinking" || msg.content?.thinking_content != null) {
				const thinking = msg.content?.thinking_content ?? "";
				if (thinking) {
					// Emit only the NEW portion (backend sends cumulative in some turns)
					const newThinking = thinking.slice(thinkingText.length);
					if (newThinking) {
						thinkingText += newThinking;
						onReasoningDelta?.(newThinking);
					}
				}
				return;
			}

			// Plain text parts
			for (const part of parts) {
				if (typeof part !== "string") continue;
				const rawPart = part;
				const delta = rawPart.slice(accumulatedContent.length);
				if (delta) {
					accumulatedContent = rawPart;
					text += delta;
					onDelta?.(delta);
				}
			}
		} catch {
			// ignore partial or non-JSON lines
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) processLine(buffer.trim());
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";
			for (const part of parts) processLine(part.trim());
		}
	} finally {
		reader.releaseLock();
	}

	return {
		text: text.trim(),
		thinkingText: thinkingText.trim(),
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		finishReason: sawToolCall ? "tool_calls" : "stop",
	};
}
