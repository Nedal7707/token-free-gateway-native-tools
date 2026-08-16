import { describe, expect, test } from "bun:test";
import { compactMessages, compactRequest, contextWindowFor } from "../src/compaction.ts";

describe("compaction (shared module)", () => {
	test("context window lookup works for gateway models", () => {
		expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
		expect(contextWindowFor("gpt-5.6-luna")).toBe(1_050_000);
		expect(contextWindowFor("kimi-k3")).toBe(128_000);
		expect(contextWindowFor("glm-5.3")).toBe(1_000_000);
		expect(contextWindowFor("deepseek-chat")).toBe(128_000);
		expect(contextWindowFor("unknown-model")).toBe(128_000);
	});

	test("small request is untouched", () => {
		const messages = [{ role: "user", content: "hello" }];
		const result = compactMessages("claude-sonnet-4-6", messages);
		expect(result.compacted).toBe(false);
		expect(result.messages).toBe(messages);
	});

	test("oversized request is compacted under budget", () => {
		const messages = [];
		for (let i = 0; i < 40; i++) {
			messages.push({ role: "user", content: "x".repeat(2000) });
			messages.push({ role: "assistant", content: "y".repeat(2000) });
		}
		const result = compactMessages("gpt-4", messages);
		expect(result.compacted).toBe(true);
		expect(result.droppedTokens).toBeGreaterThan(0);
		const size = JSON.stringify(result.messages).length;
		expect(size).toBeLessThan(8192 * 4);
	});

	test("tool-call chain is preserved through compaction", () => {
		const messages = [];
		for (let i = 0; i < 30; i++) {
			messages.push({ role: "user", content: "z".repeat(1000) });
			messages.push({ role: "assistant", content: "w".repeat(1000) });
		}
		messages.push({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
		});
		messages.push({ role: "tool", tool_call_id: "c1", content: "result" });
		messages.push({ role: "user", content: "final" });

		const result = compactMessages("gpt-4", messages);
		const joined = JSON.stringify(result.messages);
		expect(joined).toContain('"tool_calls"');
		expect(joined).toContain('"tool_call_id"');
		expect(result.messages[result.messages.length - 1].content).toBe("final");
	});

	test("compactRequest marks the request", () => {
		const messages = [];
		for (let i = 0; i < 40; i++) {
			messages.push({ role: "user", content: "x".repeat(2000) });
		}
		const out = compactRequest({ model: "gpt-4", messages, stream: true });
		expect(out._compacted).toBeDefined();
		expect(out._compacted.droppedTokens).toBeGreaterThan(0);
	});
});
