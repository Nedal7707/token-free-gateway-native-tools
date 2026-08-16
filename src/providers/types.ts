export interface ModelInfo {
	id: string;
	name: string;
}

export interface StreamResult {
	text: string;
	thinkingText: string;
	/** Native tool calls captured from a provider API response (if the provider supports real tool calling). */
	toolCalls?: {
		id?: string;
		name: string;
		arguments: string;
	}[];
	/** Whether the stream terminated with tool_calls (vs stop). */
	finishReason?: "stop" | "tool_calls" | "length";
}

export class SessionExpiredError extends Error {
	constructor(
		public readonly providerId: string,
		message?: string,
	) {
		super(
			message ??
				`Session expired for provider "${providerId}". Run 'token-free-gateway webauth' to re-authorize.`,
		);
		this.name = "SessionExpiredError";
	}
}

/**
 * Carries a provider-side HTTP status code so the gateway can return
 * an appropriate HTTP status to the client (e.g. 400 → don't retry).
 */
export class ProviderApiError extends Error {
	constructor(
		public readonly httpStatus: number,
		message: string,
	) {
		super(message);
		this.name = "ProviderApiError";
	}
}

/**
 * Raised when a provider rate limit (HTTP 429 or a limit/too-many body) is
 * detected. The provider client marks the offending account as limited and
 * rotates to the next account before throwing, so the gateway's retry path
 * can re-issue the request on a fresh account. When every account is limited
 * the gateway returns a clear 429 instead of a misleading 502.
 */
export class RateLimitError extends Error {
	constructor(
		public readonly providerId: string,
		public readonly httpStatus: number,
		message: string,
	) {
		super(message);
		this.name = "RateLimitError";
	}
}

export interface WebProviderClient {
	readonly providerId: string;
	/** Whether this provider supports NATIVE tool calling through its backend API (not prompt-injection). */
	readonly supportsNativeTools?: boolean;
	init(): Promise<void>;
	sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		tools?: unknown[];
		toolChoice?: unknown;
		messages?: unknown[];
		reasoningEffort?: string | number | boolean;
		stream?: boolean;
	}): Promise<ReadableStream<Uint8Array>>;
	parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult>;
	listModels(): ModelInfo[];
	close?(): Promise<void>;
	/** Lightweight session validity check (e.g. cookie expiry, test API call). */
	checkSession?(): Promise<{ valid: boolean; reason?: string }>;
}

export type WebProviderFactory = (credentials: unknown) => WebProviderClient;

/**
 * Race a promise against a timeout. Rejects with a descriptive error on expiry.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
		),
	]);
}

export interface ProviderDefinition {
	id: string;
	name: string;
	models: ModelInfo[];
	factory: WebProviderFactory;
	loginFn: (params: {
		onProgress: (msg: string) => void;
		openUrl: (url: string) => Promise<boolean>;
	}) => Promise<unknown>;
}
