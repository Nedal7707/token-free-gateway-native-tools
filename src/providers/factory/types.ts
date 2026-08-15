import type { ModelInfo } from "../types.ts";

/** Static configuration shared by all API-based providers. */
export interface ApiClientConfig {
	hostKey: string;
	startUrl: string;
	cookieDomain: string;
	defaultModel: string;
	models: ModelInfo[];
}

/** Static configuration shared by all DOM-interaction providers. */
export interface DomClientConfig {
	hostKey: string;
	startUrl: string;
	cookieDomain: string;
	models: ModelInfo[];
	/** Milliseconds between DOM polls (default 2000). */
	pollIntervalMs?: number;
	/** Maximum wait time for a response (default 120000). */
	maxWaitMs?: number;
	/** Number of consecutive stable reads before accepting (default 2). */
	stabilityThreshold?: number;
}

/** Parameters passed to `callApi` / DOM hooks after default-model resolution. */
export interface NormalizedSendParams {
	message: string;
	model: string;
	signal?: AbortSignal;
	/** Native tool definitions passed through to providers that support real tool calling. */
	tools?: unknown[];
	/** Native tool_choice semantics ("auto" | "none" | "required" | {function:{name}}). */
	toolChoice?: unknown;
	/** Raw OpenAI chat messages (used by native-API providers to preserve tool history). */
	messages?: unknown[];
	/** Provider-side reasoning effort hint, when the upstream supports it. */
	reasoningEffort?: string | number | boolean;
	/** Stream line-by-line (true) or buffer (false). API clients honor this to forward SSE chunks live. */
	stream?: boolean;
}
