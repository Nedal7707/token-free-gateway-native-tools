/**
 * Claude Web client (CDP-based).
 * Sends messages to claude.ai API using Chrome browser context to bypass
 * Cloudflare bot protection, similar to ChatGPT and Kimi clients.
 */
import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { createPushStream } from "../../browser/push-stream.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { StreamResult } from "../types.ts";
import { SessionExpiredError, withTimeout } from "../types.ts";
import type { ClaudeWebAuth } from "./auth.ts";
import { parseClaudeStream } from "./stream.ts";

const SEND_TIMEOUT_MS = 120_000;

export class ClaudeWebClient extends BaseApiClient<ClaudeWebAuth> {
	readonly providerId = "claude-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "claude.ai",
		startUrl: "https://claude.ai/",
		cookieDomain: ".claude.ai",
		defaultModel: "claude-sonnet-4-20250514",
		models: [
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
			{ id: "claude-opus-4-6", name: "Claude Opus 4.6" },
			{ id: "claude-haiku-4-20250514", name: "Claude Haiku 4" },
			{ id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
		],
	};

	private readonly baseUrl = "https://claude.ai/api";
	private organizationId?: string;
	private cookie: string;
	private _pushKey: string | null = null;

	constructor(auth: ClaudeWebAuth) {
		super(auth);
		this.cookie = auth.cookie || `sessionKey=${auth.sessionKey}`;
		this.organizationId = auth.organizationId;
	}

	protected getCookies() {
		return parseCookieHeader(this.cookie, this.config.cookieDomain);
	}

	protected override async onInit(): Promise<void> {
		if (this.organizationId) return;
		try {
			const page = await this.getPage();
			const orgResult = await page.evaluate(async (baseUrl: string) => {
				const res = await fetch(`${baseUrl}/organizations`, { credentials: "include" });
				if (!res.ok) return null;
				const orgs = (await res.json()) as Array<{ uuid: string }>;
				return orgs[0]?.uuid ?? null;
			}, this.baseUrl);
			if (orgResult) {
				this.organizationId = orgResult;
				console.log(`[ClaudeWeb] Discovered organization: ${this.organizationId}`);
			}
		} catch {
			/* ignore */
		}
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const conversationUuid = crypto.randomUUID();
		const orgId = this.organizationId;
		const baseUrl = this.baseUrl;
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		// Native Anthropic-style tools passed through when the caller supplied them.
		// Anthropic web API expects bare: { name, description, input_schema } (no type field).
		const nativeTools = (params.tools ?? []) as {
			type?: string;
			function?: { name: string; description?: string; parameters?: unknown };
		}[];
		const anthropicTools = nativeTools.length
			? nativeTools.map((t) => ({
					name: t.function?.name ?? "",
					description: t.function?.description ?? "",
					input_schema: t.function?.parameters ?? { type: "object", properties: {} },
				}))
			: [];
		// Anthropic web API may not support tool_choice; omit for now.
		const toolChoice = undefined;

		// Push-stream: browser reader calls the exposed Node function per chunk
		// → true letter-by-letter streaming with zero polling.
		const pushStream = createPushStream();
		const pushKey = pushStream.pushKey;
		this._pushKey = pushKey;
		(globalThis as any).__tfg_push_registry = (globalThis as any).__tfg_push_registry || {};
		(globalThis as any).__tfg_push_registry[pushKey] = { stream: pushStream.stream, close: pushStream.close };
		await page.exposeFunction(pushKey, (chunk: string) => {
			pushStream.push(chunk);
		});

		const evaluatePromise = page.evaluate(
			async ({
				baseUrl: apiBase,
				orgId: org,
				conversationUuid: convUuid,
				model: mdl,
				timezone: tz,
				message: msg,
				tools: toolsArg,
				toolChoice: toolChoiceArg,
				pushFn,
			}) => {
				const createUrl = org
					? `${apiBase}/organizations/${org}/chat_conversations`
					: `${apiBase}/chat_conversations`;
				const createRes = await fetch(createUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "include",
					body: JSON.stringify({ name: "", uuid: convUuid }),
				});
				if (!createRes.ok) {
					const text = await createRes.text();
					return {
						ok: false as const,
						status: createRes.status,
						error: `[create_conversation] ${createRes.status} ${text.slice(0, 500)}`,
					};
				}
				const conv = (await createRes.json()) as { uuid: string };
				const completionUrl = org
					? `${apiBase}/organizations/${org}/chat_conversations/${conv.uuid}/completion`
					: `${apiBase}/chat_conversations/${conv.uuid}/completion`;
				const body: Record<string, unknown> = {
					prompt: msg,
					parent_message_uuid: "00000000-0000-4000-8000-000000000000",
					model: mdl,
					timezone: tz,
					rendering_mode: "messages",
					attachments: [],
					files: [],
					locale: "en-US",
					personalized_styles: [],
					sync_sources: [],
					tools: toolsArg,
				};
				if (toolChoiceArg) body.tool_choice = toolChoiceArg;
				const completionRes = await fetch(completionUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
					credentials: "include",
					body: JSON.stringify(body),
				});
				if (!completionRes.ok) {
					const text = await completionRes.text();
					return {
						ok: false as const,
						status: completionRes.status,
						error: `[completion] ${completionRes.status} ${text.slice(0, 500)}`,
					};
				}
				const reader = completionRes.body?.getReader();
				if (!reader)
					return { ok: false as const, status: 500, error: "No response body from Claude API" };
				const decoder = new TextDecoder();
				// Push EVERY read chunk to the Node side immediately via the exposed
				// function → true letter-by-letter streaming (no polling, no buffer).
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						const text = decoder.decode(value, { stream: true });
						if (text) (globalThis as Record<string, any>)[pushFn]?.(text);
					}
				} catch (e) {
					(globalThis as Record<string, any>)[pushFn]?.(
						`__TFG_ERR__${e instanceof Error ? e.message : String(e)}`,
					);
				}
				return { ok: true as const, data: "pushed" };
			},
			{
				baseUrl,
				orgId: orgId ?? null,
				conversationUuid,
				model: params.model,
				timezone,
				message: params.message,
				tools: anthropicTools,
				toolChoice,
				pushFn: pushKey,
			},
		);
		// Fire-and-forget: the evaluate runs the full read loop in the browser,
		// pushing chunks live. Close the push stream when the loop finishes.
		evaluatePromise
			.then(() => {
				pushStream.close();
				delete (globalThis as any).__tfg_push_registry?.[pushKey];
			})
			.catch((e) => {
				console.error(`[ClaudeWeb] stream loop error: ${e instanceof Error ? e.message : String(e)}`);
				pushStream.close();
				delete (globalThis as any).__tfg_push_registry?.[pushKey];
			});
		return { ok: true, data: "pushed" };
	}

	/**
	 * Custom sendMessage to handle Claude-specific error flows:
	 * - 401 → SessionExpiredError + auto-refresh retry
	 * - 403 (rate limit) → clear error
	 * - 403 (other) → DOM fallback
	 * - 429 → rate limit error
	 */
	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		tools?: unknown[];
		toolChoice?: unknown;
		messages?: unknown[];
		reasoningEffort?: string | number | boolean;
		stream?: boolean;
	}): Promise<ReadableStream<Uint8Array>> {
		try {
			return await this.doSendMessage(params);
		} catch (err) {
			if (err instanceof SessionExpiredError) {
				console.warn("[ClaudeWeb] Session expired, attempting auto-refresh...");
				const refreshed = await this.refreshSession();
				if (refreshed) {
					console.log("[ClaudeWeb] Session refreshed, retrying request...");
					return this.doSendMessage(params);
				}
			}
			throw err;
		}
	}

	private async doSendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		tools?: unknown[];
		toolChoice?: unknown;
		messages?: unknown[];
		reasoningEffort?: string | number | boolean;
		stream?: boolean;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const normalized: NormalizedSendParams = {
			message: params.message,
			model: params.model || this.config.defaultModel,
			signal: params.signal,
			tools: params.tools,
			toolChoice: params.toolChoice,
			messages: params.messages,
			reasoningEffort: params.reasoningEffort,
			stream: params.stream,
		};
		const result = await this.callApi(page, normalized);
		if (!result.ok) {
			const errBody = result.error ?? "";
			const errLower = errBody.toLowerCase();
			console.warn(`[ClaudeWeb] API error ${result.status}: ${errBody.slice(0, 500)}`);

			if (result.status === 401) throw new SessionExpiredError(this.providerId, errBody);

			const errorCode = errBody.match(/"error_code"\s*:\s*"([^"]+)"/)?.[1] ?? "";
			const errorMessage =
				errBody.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? `Claude API error ${result.status}`;

			if (errorCode === "model_not_available" || /model.*not available/i.test(errLower))
				throw new Error(errorMessage);

			if (
				result.status === 429 ||
				/rate.?limit|out of (free )?messages|usage.?limit|quota|too many|exceeded/i.test(
					errLower,
				) ||
				/limit.*reset|upgrade.*pro/i.test(errLower)
			) {
				throw new Error(
					`Claude rate limit reached (HTTP ${result.status}). Please wait for the limit to reset or upgrade your plan.`,
				);
			}

			if (result.status === 403) {
				const userMessage = ClaudeWebClient.extractLastUserMessage(params.message);
				console.log(
					`[ClaudeWeb] 403 (unknown cause), falling back to DOM simulation (${userMessage.length} chars)`,
				);
				return this.chatCompletionsViaDOM({ message: userMessage, signal: params.signal });
			}
			throw new Error(errorMessage);
		}
		console.log(`[ClaudeWeb] Response length: ${result.data?.length || 0} bytes`);

		// Live streaming: callApi registered a push stream (exposeFunction) and
		// started the browser read loop. Return that stream directly — chunks
		// arrive letter-by-letter with no polling.
		const pushKey = this._pushKey;
		this._pushKey = null;
		if (!pushKey) return textToStream(result.data ?? "");

		// The push stream was created in callApi; we re-attach it here via the
		// registry that callApi stored.
		const reg = (globalThis as any).__tfg_push_registry?.[pushKey];
		if (reg?.stream) return reg.stream;
		return textToStream(result.data ?? "");
	}

	private static extractLastUserMessage(prompt: string): string {
		const parts = prompt.split(/\n\nHuman:\s*/);
		if (parts.length > 1) {
			const last = parts[parts.length - 1]?.trim();
			if (last) return last;
		}
		return prompt;
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		try {
			const page = await this.getPage();
			const result = await page.evaluate(async (baseUrl: string) => {
				const res = await fetch(`${baseUrl}/organizations`, { credentials: "include" });
				return { status: res.status, ok: res.ok };
			}, this.baseUrl);
			if (result.ok) return { valid: true };
			return { valid: false, reason: `Claude API returned ${result.status}` };
		} catch (err) {
			return { valid: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	async refreshSession(): Promise<boolean> {
		try {
			this.page = null;
			await this.getPage();
			const page = this.page!;
			await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 15000 });
			await page.waitForTimeout(2000);
			const check = await this.checkSession();
			if (check.valid) {
				this.organizationId = undefined;
				await this.onInit();
				console.log("[ClaudeWeb] Session refresh succeeded");
				return true;
			}
			console.warn(`[ClaudeWeb] Session refresh failed: ${check.reason}`);
			return false;
		} catch (err) {
			console.error(
				`[ClaudeWeb] Session refresh error: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	private async chatCompletionsViaDOM(params: {
		message: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const inputSelectors = [
			'div.ProseMirror[contenteditable="true"]',
			'[contenteditable="true"]',
			"textarea",
		];
		let inputHandle = null;
		for (const sel of inputSelectors) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle)
			throw new Error("Claude DOM fallback failed: chat input not found. Is claude.ai loaded?");
		await inputHandle.click();
		await page.waitForTimeout(300);
		await pasteText(page, params.message, inputHandle);
		await page.keyboard.press("Enter");
		console.log(
			`[ClaudeWeb] DOM: pasted message (${params.message.length} chars) and pressed Enter`,
		);

		const maxWaitMs = 120000;
		const pollIntervalMs = 2000;
		let lastText = "";
		let stableCount = 0;
		for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
			if (params.signal?.aborted) throw new Error("Claude request cancelled");
			await new Promise((r) => setTimeout(r, pollIntervalMs));
			const result = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const assistantMessages = document.querySelectorAll(
					'[data-is-streaming], [class*="response"], [class*="assistant"], [class*="markdown"]',
				);
				let text = "";
				if (assistantMessages.length > 0) {
					const last = assistantMessages[assistantMessages.length - 1];
					if (last) text = clean((last as HTMLElement).innerText ?? "");
				}
				const stopBtn = document.querySelector(
					'button[aria-label*="Stop"], [class*="stop-button"]',
				);
				return { text, isStreaming: !!stopBtn };
			});
			if (result.text && result.text.length >= 20) {
				if (result.text !== lastText) {
					lastText = result.text;
					stableCount = 0;
				} else {
					stableCount++;
					if (!result.isStreaming && stableCount >= 2) break;
				}
			}
		}
		if (!lastText)
			throw new Error(
				"Claude DOM fallback: no assistant reply detected. Ensure claude.ai is open and logged in.",
			);
		const rateLimitPatterns = [
			/you['']ve hit your limit/i,
			/limits will reset/i,
			/out of free messages/i,
			/upgrade.*pro/i,
			/usage limit/i,
		];
		if (rateLimitPatterns.some((r) => r.test(lastText)))
			throw new Error(
				"Claude rate limit reached. Please wait for the limit to reset or upgrade your plan.",
			);
		const fakeSse = `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: lastText } })}\n\ndata: [DONE]\n\n`;
		return textToStream(fakeSse);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseClaudeStream(body, onDelta);
	}
}
