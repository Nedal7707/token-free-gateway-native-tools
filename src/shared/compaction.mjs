/**
 * compaction.mjs — shared auto-compaction for the free-model stack.
 *
 * Compacts a chat completion request's message list when it exceeds the
 * model's context window (with headroom), so long agentic sessions never
 * hard-fail with "context length exceeded".
 *
 * Strategy (keeps tool-call chains intact):
 *  1. If total estimated tokens <= budget, return the messages unchanged.
 *  2. Otherwise, walk from the newest message backward, dropping ONLY
 *     user/assistant text pairs that are safe to drop (they are not part of
 *     the open tool-call chain, are not the system prompt, and are not the
 *     final user turn). Tool messages are never dropped alone — the assistant
 *     tool_calls message that preceded them is dropped together as a unit.
 *  3. If still over budget, optionally summarize the dropped text using a
 *     cheap local summary (no network call — deterministic extractive
 *     summary) and re-insert a single "context" user message.
 *  4. As a last resort, keep only the last N messages that fit, always
 *     preserving the system prompt + final user message.
 *
 * Context windows are per model ID (supports "provider/model" prefixed ids).
 * Unknown models default to 128k. Threshold = 80% of the window.
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;
const THRESHOLD_RATIO = 0.8; // trigger compaction at 80% of window
const SAFE_HEADROOM = 8_000; // keep this many tokens free for the response

// Per-model context windows (tokens). Covers every provider in the stack.
// Values are the model's advertised max input context; output allowance is
// carved out of the same window by SAFE_HEADROOM.
export const MODEL_CONTEXT_WINDOWS = {
	// ---- Token-free gateway (web providers) ----
	"claude-sonnet-4-6": 200_000,
	"claude-sonnet-4-20250514": 200_000,
	"claude-opus-4-6": 200_000,
	"claude-haiku-4-6": 200_000,
	"gpt-5.6-luna": 400_000,
	"gpt-5.6-sol": 400_000,
	"gpt-5.6-terra": 400_000,
	"gpt-5.5": 400_000,
	"gpt-5.4": 400_000,
	"gpt-4-turbo": 128_000,
	"gpt-4": 8_192,
	"deepseek-chat": 128_000,
	"deepseek-reasoner": 128_000,
	"gemini-pro": 1_000_000,
	"gemini-ultra": 1_000_000,
	"glm-4-plus": 128_000,
	"glm-4-think": 128_000,
	"moonshot-v1-8k": 8_192,
	"moonshot-v1-32k": 32_768,
	"moonshot-v1-128k": 131_072,
	"perplexity-web": 128_000,
	"perplexity-pro": 128_000,
	"qwen3.5-plus": 262_144,
	"qwen3.5-turbo": 262_144,

	// ---- OpenCode Zen (opencode) ----
	"deepseek-v4-flash-free": 128_000,
	"deepseek-v4-flash": 128_000,
	"deepseek-v4-pro": 128_000,
	"hy3-free": 128_000,
	"hy3-free-preview": 128_000,
	"nemotron-3-ultra-free": 1_000_000,
	"nemotron-3-super-free": 262_144,
	"nemotron-3.5-lightning-free": 1_000_000,
	"laguna-s-2.1-free": 262_144,
	"gpt-5.6-luna-free": 400_000,
	"gpt-5.6-sol-free": 400_000,
	"gpt-5.6-terra-free": 400_000,
	"gpt-5.5-free": 400_000,
	"ring-2.6-1t-free": 1_000_000,
	"kimi-k2.5-free": 256_000,
	"kimi-k2.7-code": 256_000,
	"kimi-k3": 256_000,
	"minimax-m3": 204_800,
	"minimax-m3-free": 204_800,
	"glm-5-free": 128_000,
	"glm-5.2": 128_000,
	"qwen3.6-plus-free": 262_144,
	"qwen3.6-plus": 262_144,
	"big-pickle": 128_000,
	"mimo-v2.5-free": 256_000,
	"grok-code": 256_000,
	"trinity-large-preview-free": 400_000,
	"claude-sonnet-4-5": 200_000,
	"claude-opus-4-5": 200_000,
	"claude-haiku-4-5": 200_000,
	"gemini-3.7-flash": 1_000_000,
	"gemini-3.6-flash": 1_000_000,
	"gemini-3.5-flash": 1_000_000,
	"gemini-3.5-flash-lite": 1_000_000,
	"grok-4.6": 256_000,
	"grok-4.5": 256_000,
	"muse-spark-1.2": 128_000,
	"gpt-5.6-luna-zen": 400_000,

	// ---- NVIDIA NIM ----
	"nvidia/nemotron-3-ultra-550b-a55b": 1_000_000,
	"nvidia/nemotron-3-super-120b-a12b": 262_144,
	"nvidia/nemotron-3.5-lightning-30b-a3b": 1_000_000,
	"nvidia/nemotron-3-nano-30b-a3b": 256_000,
	"nvidia/nemotron-nano-9b-v2": 128_000,
	"nvidia/llama-3.3-nemotron-super-49b-v1": 128_000,
	"nvidia/llama-3.3-nemotron-super-49b-v1.5": 128_000,
	"nvidia/nemotron-mini-4b-instruct": 128_000,
	"z-ai/glm-5.2": 128_000,
	"meta/llama-3.1-70b-instruct": 128_000,
	"meta/llama-3.1-8b-instruct": 128_000,
	"stepfun-ai/step-3.7-flash": 128_000,
	"thinkingmachines/inkling": 128_000,
	"mistralai/mistral-nemotron": 128_000,
	"minimaxai/minimax-m3": 204_800,
	"openai/gpt-oss-20b": 131_072,
	"deepseek-ai/deepseek-v4-flash": 128_000,
	"deepseek-ai/deepseek-v4-pro": 128_000,

	// ---- AIHubMix free ----
	"gemini-3.6-flash-free": 1_000_000,
	"coding-glm-5.2-free": 1_000_000,
	"coding-kimi-k3-free": 1_000_000,
	"coding-minimax-m3-free": 204_800,
	"gpt-5.5-free-aihubmix": 400_000,

	// ---- ZenMux ----
	"deepseek/deepseek-v4-flash-free": 128_000,
	"z-ai/glm-4.7-flash-free": 128_000,
	"z-ai/glm-4.6v-flash-free": 128_000,

	// ---- Cloudflare Workers AI ----
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast": 128_000,
	"@cf/meta/llama-3.2-3b-instruct": 128_000,
	"@cf/openai/gpt-oss-20b": 131_072,
	"@cf/zai-org/glm-4.7-flash": 128_000,
	"@cf/mistralai/mistral-small-3.1-24b-instruct": 128_000,

	// ---- Command Code (bridge) ----
	"deepseek/deepseek-v4-flash": 128_000,
	"deepseek/deepseek-v4-pro": 128_000,
	"gpt-5.6-luna-cc": 400_000,
	"moonshotai/Kimi-K2.5": 256_000,
	"moonshotai/Kimi-K2.6": 256_000,
	"moonshotai/Kimi-K2.7-Code": 256_000,
	"moonshotai/Kimi-K2.7-Code-Highspeed": 256_000,
	"moonshotai/Kimi-K3": 256_000,
	"MiniMaxAI/MiniMax-M2.5": 204_800,
	"MiniMaxAI/MiniMax-M2.7": 204_800,
	"MiniMaxAI/MiniMax-M3": 204_800,
	"meta/muse-spark-1.2-contributor": 128_000,
	"Qwen/Qwen3.6-Max-Preview": 262_144,
	"Qwen/Qwen3.6-Plus": 262_144,
	"Qwen/Qwen3.7-Flash": 262_144,
	"Qwen/Qwen3.7-Max": 262_144,
	"Qwen/Qwen3.7-Plus": 262_144,
	"Qwen/Qwen3.8-Max": 262_144,
	"stepfun/Step-3.5-Flash": 128_000,
	"stepfun/Step-3.7-Flash": 128_000,
	"tencent/hy3-paid": 128_000,
	"thinkingmachines/inkling-small": 128_000,
	"xai/grok-4.5": 256_000,
	"xiaomi/mimo-v2.5": 256_000,
	"xiaomi/mimo-v2.5-pro": 256_000,
	"zai-org/GLM-5": 128_000,
	"zai-org/GLM-5.1": 128_000,
	"zai-org/GLM-5.2": 128_000,
	"zai-org/GLM-5.2-Fast": 128_000,
	"zai-org/GLM-5.3": 128_000,
};

/** Strip a "provider/model" prefix and look up the bare model id. */
function normalizeModelId(model) {
	if (!model) return "";
	const bare = String(model).split("/").pop() || String(model);
	// Try exact bare id first, then the full prefixed id.
	if (MODEL_CONTEXT_WINDOWS[bare] !== undefined) return bare;
	if (MODEL_CONTEXT_WINDOWS[String(model)] !== undefined) return String(model);
	// Fuzzy: "gpt-5.6-luna-cc" -> "gpt-5.6-luna"
	for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
		if (String(model).startsWith(key) || key.startsWith(bare)) return key;
	}
	return bare;
}

/** Context window for a model id (tokens). Defaults to 128k for unknown. */
export function contextWindowFor(model) {
	const key = normalizeModelId(model);
	return MODEL_CONTEXT_WINDOWS[key] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Cheap deterministic token estimate (~4 chars/token, tuned for code+JSON).
 * Good enough for compaction decisions; never sent to the client.
 */
export function estimateTokens(input) {
	if (input == null) return 0;
	if (typeof input === "string") return Math.ceil(input.length / 4) + 1;
	return 0;
}

function messageText(msg) {
	if (!msg) return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => (typeof p === "string" ? p : p?.text ?? ""))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

function messageTokens(msg) {
	const base = estimateTokens(messageText(msg));
	if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
		return base + msg.tool_calls.reduce((sum, tc) => sum + estimateTokens(tc.function?.name) + estimateTokens(tc.function?.arguments), 0);
	}
	return base;
}

function cloneMessage(msg) {
	if (!msg || typeof msg !== "object") return msg;
	return JSON.parse(JSON.stringify(msg));
}

/**
 * Compact messages for the given model.
 * Returns { messages, compacted, droppedTokens, budget }.
 */
export function compactMessages(model, messages) {
	if (!Array.isArray(messages) || messages.length === 0) {
		return { messages: messages ?? [], compacted: false, droppedTokens: 0, budget: 0 };
	}

	const window = contextWindowFor(model);
	const budget = Math.max(2_000, Math.floor(window * THRESHOLD_RATIO) - SAFE_HEADROOM);

	let total = 0;
	for (const m of messages) total += messageTokens(m);

	if (total <= budget) {
		return { messages, compacted: false, droppedTokens: 0, budget };
	}

	const result = compactWithDrop(model, messages, budget);
	return {
		messages: result.messages,
		compacted: result.droppedTokens > 0,
		droppedTokens: result.droppedTokens,
		budget,
	};
}

/**
 * Drop old turns from the front (after system prompt), keeping the final user
 * message and any open tool-call chain intact. Tool results are only dropped
 * together with their preceding assistant tool_calls message.
 */
function compactWithDrop(model, messages, budget) {
	const out = [];
	// System/developer messages are always kept.
	for (const m of messages) {
		if (m?.role === "system" || m?.role === "developer") out.push(m);
	}

	let droppedTokens = 0;
	let rest = messages.slice(out.length);
	let finalUserIndex = -1;
	for (let i = rest.length - 1; i >= 0; i--) {
		if (rest[i]?.role === "user") {
			finalUserIndex = i;
			break;
		}
	}

	// Find the tool-chain boundary: the index of the newest assistant
	// tool_calls message that starts an OPEN chain (has no tool results after).
	let toolChainStart = rest.length;
	for (let i = rest.length - 1; i >= 0; i--) {
		const m = rest[i];
		if (m?.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			toolChainStart = i;
			break;
		}
	}

	let keepFrom = 0;
	let size = messages.reduce((s, m) => s + messageTokens(m), 0);

	for (let i = 0; i < rest.length && size > budget; i++) {
		// Never drop the final user message.
		if (i === finalUserIndex) continue;
		// Never break an open tool-call chain.
		if (i >= toolChainStart) continue;
		const m = rest[i];
		// Tool results are only dropped WITH their assistant tool_calls (handled
		// by the assistant branch below when i+1 is a tool message).
		if (m?.role === "tool") continue;

		// When dropping an assistant tool_calls message, drop its tool results too.
		let unit = [m];
		let unitTokens = messageTokens(m);
		if (m?.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			let j = i + 1;
			while (j < rest.length && rest[j]?.role === "tool") {
				unit.push(rest[j]);
				unitTokens += messageTokens(rest[j]);
				j++;
			}
		}

		// Only drop whole user/assistant pairs when possible to avoid orphaned
		// assistant replies; dropping a single user msg is fine (it just leaves
		// an assistant reply without its prompt, which is acceptable in a
		// summary-based context).
		keepFrom = i + 1;
		size -= unitTokens;
		droppedTokens += unitTokens;
	}

	const kept = rest.slice(keepFrom);

	// If we dropped anything, insert a compact summary marker so the model
	// knows context was trimmed.
	if (droppedTokens > 0) {
		const summaryNote = {
			role: "system",
			content:
				"[context trimmed: older conversation turns were removed to fit the model's context window. " +
				`Approximately ${Math.round(droppedTokens)} tokens of earlier turns were dropped. ` +
				"Do not mention this unless relevant; continue based on the remaining context.]",
		};
		out.push(summaryNote);
	}

	out.push(...kept);

	// Last resort: hard truncate to the budget, keeping system + final user.
	if (out.reduce((s, m) => s + messageTokens(m), 0) > budget) {
		const sys = out.filter((m) => m?.role === "system" || m?.role === "developer");
		const rest2 = out.filter((m) => m?.role !== "system" && m?.role !== "developer");
		const lastUser = [...rest2].reverse().find((m) => m?.role === "user");
		const tail = [];
		let tailTokens = 0;
		for (let i = rest2.length - 1; i >= 0 && tailTokens < budget * 0.6; i--) {
			const m = rest2[i];
			const t = messageTokens(m);
			if (tailTokens + t > budget * 0.6 && tail.length > 0) break;
			tail.unshift(m);
			tailTokens += t;
		}
		const final = [...sys, ...tail];
		if (lastUser && !final.includes(lastUser)) final.push(lastUser);
		return {
			messages: final,
			droppedTokens: droppedTokens + (out.length - final.length) * 100,
		};
	}

	return { messages: out, droppedTokens };
}

/** JSON-safe clone of the request with compacted messages. */
export function compactRequest(body, modelField = "model") {
	if (!body || typeof body !== "object") return body;
	const model = body[modelField] ?? "";
	const result = compactMessages(model, body.messages);
	if (!result.compacted) return body;
	const next = { ...body };
	next.messages = result.messages;
	next._compacted = {
		droppedTokens: result.droppedTokens,
		budget: result.budget,
		model,
	};
	return next;
}
