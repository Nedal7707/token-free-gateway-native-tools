/**
 * Claude Web SSE stream parser.
 * Handles multiple Claude response formats including thinking blocks.
 */

import type { StreamResult } from "../types.ts";

function extractDelta(data: any): string | undefined {
	if (data.type === "content_block_delta" && typeof data.delta?.text === "string") {
		return data.delta.text;
	}
	if (typeof data.text === "string") return data.text;
	if (typeof data.content === "string") return data.content;
	if (typeof data.delta === "string") return data.delta;
	if (typeof data.choices?.[0]?.delta?.content === "string") {
		return data.choices[0].delta.content;
	}
	return undefined;
}

function parseSseData(dataStr: string): any | null {
	if (!dataStr || dataStr === "[DONE]") return null;
	try {
		return JSON.parse(dataStr);
	} catch {
		return null;
	}
}

function stripInlineThinkTags(text: string): { text: string; thinking: string } {
	const open = text.indexOf("<think>");
	if (open === -1) return { text, thinking: "" };
	const close = text.indexOf("</think>", open);
	if (close === -1) return { text, thinking: "" };
	return {
		text: text.slice(0, open) + text.slice(close + 8),
		thinking: text.slice(open + 7, close),
	};
}

class Accumulator {
	text = "";
	thinkingText = "";
	toolCalls: { id?: string; name: string; arguments: string }[] = [];
	sawToolCall = false;
	private inThinking = false;
	private inToolUse = false;
	private currentTool: { id?: string; name: string; args: string } | null = null;

	processLine(line: string, onDelta?: (delta: string) => void): void {
		if (!line.startsWith("data:")) return;
		const data = parseSseData(line.slice(5).trim());
		if (!data) return;

		if (data.type === "content_block_start" && data.content_block?.type === "thinking") {
			this.inThinking = true;
			return;
		}
		if (data.type === "content_block_stop" && this.inThinking) {
			this.inThinking = false;
			return;
		}

		// Native tool_use block start (Anthropic format).
		if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
			this.inToolUse = true;
			this.sawToolCall = true;
			this.currentTool = {
				id: data.content_block.id,
				name: data.content_block.name ?? "",
				args: "",
			};
			return;
		}
		// Tool input deltas (partial_json).
		if (this.inToolUse && data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
			this.currentTool!.args += data.delta.partial_json ?? "";
			return;
		}
		// Tool use block stop — finalize the tool call.
		if (data.type === "content_block_stop" && this.inToolUse) {
			this.inToolUse = false;
			if (this.currentTool && this.currentTool.name) {
				let args = this.currentTool.args;
				if (!args.trim().startsWith("{")) args = `{${args}}`;
				this.toolCalls.push({
					id: this.currentTool.id,
					name: this.currentTool.name,
					arguments: args,
				});
			}
			this.currentTool = null;
			return;
		}

		const delta = extractDelta(data);
		if (!delta) return;

		if (this.inThinking) {
			this.thinkingText += delta;
		} else {
			this.text += delta;
			onDelta?.(delta);
		}
	}
}

export async function parseClaudeStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const acc = new Accumulator();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) acc.processLine(buffer.trim(), onDelta);
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";
			for (const part of parts) {
				const trimmed = part.trim();
				if (trimmed) acc.processLine(trimmed, onDelta);
			}
		}
	} finally {
		reader.releaseLock();
	}

	const stripped = stripInlineThinkTags(acc.text);
	return {
		text: stripped.text.trim(),
		thinkingText: (acc.thinkingText + stripped.thinking).trim(),
		toolCalls: acc.toolCalls.length > 0 ? acc.toolCalls : undefined,
		finishReason: acc.sawToolCall ? "tool_calls" : "stop",
	};
}
