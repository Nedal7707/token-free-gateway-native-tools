import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import { throwIfSessionExpired } from "../shared/error-guard.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { StreamResult } from "../types.ts";
import { withTimeout } from "../types.ts";
import type { ChatGPTWebAuth } from "./auth.ts";
import { parseChatGPTStream } from "./stream.ts";

const SEND_TIMEOUT_MS = 120_000;

export class ChatGPTWebClient extends BaseApiClient<ChatGPTWebAuth> {
	readonly providerId = "chatgpt-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "chatgpt.com",
		startUrl: "https://chatgpt.com/",
		cookieDomain: ".chatgpt.com",
		defaultModel: "gpt-4",
		models: [
			{ id: "gpt-4", name: "GPT-4" },
			{ id: "gpt-4-turbo", name: "GPT-4 Turbo" },
			{ id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
		],
	};

	private accessToken: string;
	private cookie: string;
	private conversationId: string | undefined;
	private parentMessageId: string | undefined;

	constructor(auth: ChatGPTWebAuth) {
		super(auth);
		this.accessToken = auth.accessToken;
		this.cookie = auth.cookie || `__Secure-next-auth.session-token=${auth.accessToken}`;
	}

	protected getCookies() {
		return parseCookieHeader(this.cookie.trim(), this.config.cookieDomain);
	}

	/** Custom page bootstrapping: wait for oaistatic scripts. */
	protected override async getPage(): Promise<Page> {
		if (this.page) {
			try {
				await this.page.evaluate(() => document.readyState);
				return this.page;
			} catch {
				this.page = null;
			}
		}
		const bm = BrowserManager.getInstance();
		console.log("[ChatGPT Web] Connecting via BrowserManager...");
		this.page = await bm.getPage(this.config.hostKey, this.config.startUrl);
		console.log(`[ChatGPT Web] Using page: ${this.page.url()}`);
		await this.ensureChatGptPageReady();
		console.log("[ChatGPT Web] Connected to Chrome successfully");
		const cookies = this.getCookies();
		if (cookies.length > 0) await bm.addCookies(cookies);
		return this.page;
	}

	private async ensureChatGptPageReady() {
		if (!this.page) return;
		if (!this.page.url().includes("chatgpt.com")) {
			await this.page.goto("https://chatgpt.com/", { waitUntil: "load" });
		}
		try {
			await this.page.waitForFunction(
				() => {
					const scripts = Array.from(document.scripts);
					return scripts.some((s) => s.src?.includes("oaistatic.com") && s.src?.endsWith(".js"));
				},
				{ timeout: 15000 },
			);
		} catch {
			console.warn("[ChatGPT Web] oaistatic script not found in 15s, continuing anyway");
		}
		await new Promise((r) => setTimeout(r, 2000));
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const convId = this.conversationId ?? "new";
		const parentId = this.parentMessageId ?? randomUUID();
		const messageId = randomUUID();
		console.log(
			`[ChatGPT Web] Sending message, Conversation ID: ${convId}, Model: ${params.model}`,
		);

		// Build request body. When native tools are supplied, pass them through
		// to ChatGPT's backend so the model can emit REAL tool_calls.
		const tools = (params.tools ?? []) as {
			type?: string;
			function?: { name: string; description?: string; parameters?: unknown };
		}[];
		const toolChoice = params.toolChoice as string | { type?: string; function?: { name?: string } } | undefined;

		const body: Record<string, unknown> = {
			action: "next",
			messages: [
				{
					id: messageId,
					author: { role: "user" },
					content: { content_type: "text", parts: [params.message] },
				},
			],
			parent_message_id: parentId,
			model: params.model,
			timezone_offset_min: new Date().getTimezoneOffset(),
			conversation_id: convId === "new" ? undefined : convId,
			history_and_training_disabled: false,
			conversation_mode: { kind: "primary_assistant", plugin_ids: null },
			force_paragen: false,
			force_paragen_model_slug: "",
			force_rate_limit: false,
			reset_rate_limits: false,
			force_use_sse: true,
		};

		if (tools.length > 0) {
			body.tools = tools.map((t) => ({
				type: "function",
				function: {
					name: t.function?.name ?? "",
					description: t.function?.description ?? "",
					parameters: t.function?.parameters ?? {},
				},
			}));
		}
		if (toolChoice) {
			body.tool_choice = toolChoice;
		}
		const pageUrl = page.url();

		return (await withTimeout(
			page.evaluate(
				async ({ body: reqBody, pageUrl: refUrl }) => {
					const baseHeaders = (accessToken: string | undefined, deviceId: string) => ({
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"oai-device-id": deviceId,
						"oai-language": "en-US",
						Referer: refUrl || "https://chatgpt.com/",
						"sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
						"sec-ch-ua-mobile": "?0",
						"sec-ch-ua-platform": '"macOS"',
						...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
					});
					async function warmupSentinel(accessToken: string | undefined, deviceId: string) {
						const h = baseHeaders(accessToken, deviceId);
						await fetch("https://chatgpt.com/backend-api/conversation/init", {
							method: "POST",
							headers: h,
							body: "{}",
							credentials: "include",
						}).catch(() => {});
						await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare", {
							method: "POST",
							headers: h,
							body: "{}",
							credentials: "include",
						}).catch(() => {});
						await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize", {
							method: "POST",
							headers: h,
							body: "{}",
							credentials: "include",
						}).catch(() => {});
					}
					async function getSession() {
						const r = await fetch("https://chatgpt.com/api/auth/session", {
							credentials: "include",
						});
						return r.ok ? r.json() : null;
					}
					async function tryFetchWithSentinel(accessToken: string | undefined, deviceId: string) {
						await warmupSentinel(accessToken, deviceId);
						const scripts = Array.from(document.scripts);
						const assetSrc = scripts
							.map((s) => s.src)
							.find((s) => s?.includes("oaistatic.com") && s.endsWith(".js"));
						const assetUrl = assetSrc || "https://cdn.oaistatic.com/assets/i5bamk05qmvsi6c3.js";
						try {
							const g = await import(/* @vite-ignore */ assetUrl);
							if (typeof g.bk !== "function" || typeof g.fX !== "function")
								return { error: `Sentinel asset missing bk/fX (asset: ${assetUrl})` };
							const z = await g.bk();
							const turnstileKey = z?.turnstile?.bx ?? z?.turnstile?.dx;
							if (!turnstileKey) return { error: "Sentinel chat-requirements missing turnstile" };
							const r = await g.bi(turnstileKey);
							let arkose: unknown = null;
							try {
								arkose = await g.bl?.getEnforcementToken?.(z);
							} catch {
								/* Arkose may fail */
							}
							let p: unknown = null;
							try {
								p = await g.bm?.getEnforcementToken?.(z);
							} catch {
								/* Proof token may fail */
							}
							const extraHeaders = await g.fX(z, arkose, r, p, null);
							const headers: Record<string, string> = {
								...baseHeaders(accessToken, deviceId),
								...(typeof extraHeaders === "object" ? extraHeaders : {}),
							};
							const res = await fetch("https://chatgpt.com/backend-api/conversation", {
								method: "POST",
								headers,
								body: JSON.stringify(reqBody),
								credentials: "include",
							});
							return { res };
						} catch (e: unknown) {
							return {
								error: `Sentinel token failed: ${e instanceof Error ? e.message : String(e)}`,
							};
						}
					}
					const session = await getSession();
					const accessToken = session?.accessToken as string | undefined;
					const deviceId =
						(session as { oaiDeviceId?: string })?.oaiDeviceId ??
						globalThis.crypto?.randomUUID?.() ??
						Math.random().toString(36).slice(2);
					const sentinelResult = await tryFetchWithSentinel(accessToken, deviceId);
					const res =
						sentinelResult.res ??
						(await fetch("https://chatgpt.com/backend-api/conversation", {
							method: "POST",
							headers: baseHeaders(accessToken, deviceId),
							body: JSON.stringify(reqBody),
							credentials: "include",
						}));
					const sentinelError = "error" in sentinelResult ? sentinelResult.error : undefined;
					if (!res.ok) {
						const errorText = await res.text();
						return { ok: false, status: res.status, error: errorText, sentinelError };
					}
					const reader = res.body?.getReader();
					if (!reader) return { ok: false, status: 500, error: "No response body", sentinelError };
					const decoder = new TextDecoder();
					// Stream SSE chunks into a shared window buffer; the Node side polls
					// it via page.evaluate for TRUE line-by-line delivery (not buffering).
					const streamKey = `__tfg_s_${(reqBody.messages as { id?: string }[])?.[0]?.id ?? Math.random().toString(36).slice(2)}`;
					(globalThis as Record<string, unknown>)[streamKey] = {
						chunks: [] as string[],
						done: false,
						error: undefined as string | undefined,
					};
					const sink = (globalThis as Record<string, any>)[streamKey];
					(async () => {
						try {
							while (true) {
								const { done: d, value } = await reader.read();
								if (d) break;
								sink.chunks.push(decoder.decode(value, { stream: true }));
							}
						} catch (e) {
							sink.error = e instanceof Error ? e.message : String(e);
						} finally {
							sink.done = true;
						}
					})();
					// Return IMMEDIATELY so Node can poll the window buffer live.
					return {
						ok: true,
						data: JSON.stringify({
							streamKey,
							bytes: 0,
						}),
					};
				},
				{ body, pageUrl },
			),
			SEND_TIMEOUT_MS,
			"ChatGPT request",
		)) as EvalResult & { sentinelError?: string };
	}

	/**
	 * Override sendMessage for custom error handling:
	 * - 403 → DOM fallback
	 * - 401 → SessionExpiredError
	 * - sentinelError hint
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
		const responseData = (await this.callApi(page, normalized)) as EvalResult & {
			sentinelError?: string;
		};
		if (!responseData.ok) {
			if (responseData.status === 403) {
				console.log("[ChatGPT Web] 403 from API, falling back to DOM simulation");
				return this.chatCompletionsViaDOM({ message: params.message, signal: params.signal });
			}
			throwIfSessionExpired(
				this.providerId,
				responseData.status,
				"ChatGPT authentication failed. Re-run webauth to refresh the session.",
			);
			const sentinelHint = responseData.sentinelError
				? ` Sentinel: ${responseData.sentinelError}`
				: " If 403 persists, check oaistatic export names in the chatgpt.com console.";
			throw new Error(
				`ChatGPT API error ${responseData.status}: ${responseData.error?.slice(0, 200) || ""}${sentinelHint}`,
			);
		}

		// Live streaming: callApi stored SSE chunks in a window buffer under streamKey.
		// Poll the buffer via page.evaluate and emit chunks as they arrive → TRUE line-by-line.
		let streamInfo: { streamKey?: string } = {};
		try {
			streamInfo = JSON.parse(responseData.data ?? "{}");
		} catch {
			// Older path: data is raw text — return it as a single chunk.
			return textToStream(responseData.data ?? "");
		}
		const streamKey = streamInfo.streamKey;
		if (!streamKey) {
			return textToStream(responseData.data ?? "");
		}

		const encoder = new TextEncoder();
		const readable = new ReadableStream<Uint8Array>({
			start: async (controller) => {
				let lastLen = 0;
				let done = false;
				let error: string | undefined;
				try {
					while (!done) {
						if (params.signal?.aborted) throw new Error("ChatGPT request cancelled");
						const poll = await page.evaluate(
							({ key, from }) => {
								const sink = (globalThis as Record<string, any>)[key] as {
									chunks: string[];
									done: boolean;
									error?: string;
								} | undefined;
								if (!sink) return { done: true, error: "stream buffer missing", chunks: [] as string[] };
								const chunks = sink.chunks.slice(from);
								return { done: sink.done, error: sink.error, chunks };
							},
							{ key: streamKey, from: lastLen },
						);
						for (const chunk of poll.chunks) {
							controller.enqueue(encoder.encode(chunk));
						}
						lastLen += poll.chunks.reduce((n, c) => n + c.length, 0);
						done = poll.done;
						error = poll.error;
						if (!done) await new Promise((r) => setTimeout(r, 100));
					}
					if (error) throw new Error(error);
					controller.close();
				} catch (e) {
					controller.error(e instanceof Error ? e : new Error(String(e)));
				} finally {
					// Cleanup the window buffer.
					await page.evaluate((key) => {
						delete (globalThis as Record<string, any>)[key];
					}, streamKey).catch(() => {});
				}
			},
		});
		return readable;
	}

	override async parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseChatGPTStream(body, onDelta, (meta) => {
			if (meta.conversationId) this.conversationId = meta.conversationId;
			if (meta.parentMessageId) this.parentMessageId = meta.parentMessageId;
		});
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return this.parseStream(body, onDelta);
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		try {
			const page = await this.getPage();
			const result = await page.evaluate(async () => {
				const r = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
				if (!r.ok) return { status: r.status, hasToken: false };
				const data = (await r.json()) as { accessToken?: string };
				return { status: r.status, hasToken: !!data.accessToken };
			});
			if (result.hasToken) return { valid: true };
			return { valid: false, reason: `ChatGPT session returned ${result.status}, no access token` };
		} catch (err) {
			return { valid: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	private async chatCompletionsViaDOM(params: {
		message: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const inputSelectors = [
			"#prompt-textarea",
			"textarea[placeholder]",
			"textarea",
			'[contenteditable="true"]',
		];
		let inputHandle = null;
		for (const sel of inputSelectors) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle) throw new Error("ChatGPT DOM simulation failed: input not found");
		await inputHandle.click();
		await page.waitForTimeout(300);
		await pasteText(page, params.message, inputHandle);
		await page.waitForTimeout(300);
		await page.keyboard.press("Enter");
		console.log("[ChatGPT Web] DOM: pasted message and pressed Enter");
		const maxWaitMs = 90000;
		const pollIntervalMs = 2000;
		let lastText = "";
		let stableCount = 0;
		for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
			if (params.signal?.aborted) throw new Error("ChatGPT request cancelled");
			await new Promise((r) => setTimeout(r, pollIntervalMs));
			const result = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const els = document.querySelectorAll(
					'div[data-message-author-role="assistant"], .agent-turn [data-message-author-role="assistant"], [class*="markdown"], [class*="assistant"]',
				);
				const last = els.length > 0 ? els[els.length - 1] : null;
				const text = last ? clean(last.textContent ?? "") : "";
				const stopBtn = document.querySelector('button.bg-black .icon-lg, [aria-label*="Stop"]');
				return { text, isStreaming: !!stopBtn };
			});
			if (result.text && result.text !== lastText) {
				lastText = result.text;
				stableCount = 0;
			} else if (result.text) {
				stableCount++;
				if (!result.isStreaming && stableCount >= 2) break;
			}
		}
		if (!lastText)
			throw new Error(
				"ChatGPT DOM simulation: no assistant reply detected. Ensure chatgpt.com is open, logged in, and the input is visible.",
			);
		const fakeSse = `data: ${JSON.stringify({ message: { id: "dom-fallback", content: { parts: [lastText] } } })}\n\ndata: [DONE]\n\n`;
		return textToStream(fakeSse);
	}
}
