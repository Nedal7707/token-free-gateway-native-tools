import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { type BrowserCookie, parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { KimiWebAuth } from "./auth.ts";
import { parseKimiStream } from "./stream.ts";

export class KimiWebClient extends BaseApiClient<KimiWebAuth> {
	readonly providerId = "kimi-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "kimi.com",
		startUrl: "https://www.kimi.com/",
		cookieDomain: ".kimi.com",
		defaultModel: "kimi-k3",
		models: [
		{ id: "kimi-k3", name: "Kimi K3" },
		{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code" }
	],
	};

	private readonly baseUrl = "https://www.kimi.com";

	protected getCookies(): BrowserCookie[] {
		return [];
	}

	/** Custom page init: dynamic domain for cookies + secure flag for __Secure-/__Host- prefixed cookies. */
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
		this.page = await bm.getPage(this.config.hostKey, this.config.startUrl);
		const cookie = this.auth.cookie || "";
		if (cookie.trim()) {
			const pageUrl = this.page.url() ?? this.baseUrl;
			const domain = pageUrl.includes("moonshot.cn") ? ".moonshot.cn" : ".kimi.com";
			const cookies = parseCookieHeader(cookie, domain).map((c) => ({
				...c,
				...(c.name.startsWith("__Secure-") || c.name.startsWith("__Host-") ? { secure: true } : {}),
			}));
			if (cookies.length > 0) await bm.addCookies(cookies);
		}
		return this.page;
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const bm = BrowserManager.getInstance();
		const ctx = await bm.getContext();
		const cookies = await ctx.cookies([this.baseUrl]);
		const kimiAuthCookie = cookies.find((c) => c.name === "kimi-auth")?.value;
		let authToken = this.auth.accessToken || kimiAuthCookie;

		// Auto-refresh: kimi access tokens are short-lived (~15 min). If the
		// stored token is expired (or missing), use the refresh_token to get a
		// fresh one from the kimi account API.
		if (!authToken || this.isKimiTokenExpired(authToken)) {
			const refreshed = await this.refreshKimiToken(page);
			if (refreshed) authToken = refreshed;
		}

		if (!authToken) {
			return {
				ok: false,
				status: 401,
				error:
					"Kimi: no credentials (accessToken or kimi-auth cookie). Run webauth to refresh login.",
			};
		}

		const model = params.model;
		const result = await page.evaluate(
			async ({
				baseUrl,
				message,
				kimiAuthToken,
				scenario,
				thinking,
			}: {
				baseUrl: string;
				message: string;
				kimiAuthToken: string;
				scenario: string;
				thinking: boolean;
			}) => {
				const req = {
					scenario,
					message: {
						role: "user" as const,
						blocks: [{ message_id: "", text: { content: message } }],
						scenario,
					},
					// Real reasoning: enable thinking when the client asks for effort.
					options: { thinking },
				};
				const enc = new TextEncoder().encode(JSON.stringify(req));
				const buf = new ArrayBuffer(5 + enc.byteLength);
				const dv = new DataView(buf);
				dv.setUint8(0, 0x00);
				dv.setUint32(1, enc.byteLength, false);
				new Uint8Array(buf, 5).set(enc);

				const res = await fetch(`${baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, {
					method: "POST",
					headers: {
						"Content-Type": "application/connect+json",
						"Connect-Protocol-Version": "1",
						Accept: "*/*",
						Origin: baseUrl,
						Referer: `${baseUrl}/`,
						"X-Language": "zh-CN",
						"X-Msh-Platform": "web",
						Authorization: `Bearer ${kimiAuthToken}`,
					},
					body: buf,
				});
				if (!res.ok) {
					const text = await res.text();
					return { ok: false as const, status: res.status, error: text.slice(0, 400) };
				}
				const arr = await res.arrayBuffer();
				const u8 = new Uint8Array(arr);
				const texts: string[] = [];
				let o = 0;
				while (o + 5 <= u8.length) {
					const len = new DataView(u8.buffer, u8.byteOffset + o + 1, 4).getUint32(0, false);
					if (o + 5 + len > u8.length) break;
					const chunk = u8.slice(o + 5, o + 5 + len);
					try {
						const obj = JSON.parse(new TextDecoder().decode(chunk));
						if (obj.error)
							return {
								ok: false as const,
								error:
									obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 200),
							};
						const op = obj.op || "";
						if (obj.block?.text?.content && (op === "append" || op === "set"))
							texts.push(obj.block.text.content);
						else if (obj.text?.content && (op === "append" || op === "set"))
							texts.push(obj.text.content);
						if (!op && obj.message?.role === "assistant" && obj.message?.blocks) {
							for (const blk of obj.message.blocks) {
								if (blk.text?.content) texts.push(blk.text.content);
							}
						}
						if (obj.done) break;
					} catch {
						/* ignore */
					}
					o += 5 + len;
				}
				return { ok: true as const, text: texts.join("") };
			},
			{
				baseUrl: this.baseUrl,
				message: params.message,
				kimiAuthToken: authToken,
				thinking: params.reasoningEffort !== undefined && params.reasoningEffort !== false,
				scenario: model.includes("search")
					? "SCENARIO_SEARCH"
					: model.includes("research")
						? "SCENARIO_RESEARCH"
						: model.includes("k1")
							? "SCENARIO_K1"
							: "SCENARIO_K2",
			},
		);

		if (!result.ok) {
			return {
				ok: false,
				status: ("status" in result ? result.status : 0) as number,
				error: ("error" in result ? result.error : "Unknown error") as string,
			};
		}
		const escaped = JSON.stringify(result.text);
		return { ok: true, data: `data: {"text":${escaped}}\n\ndata: [DONE]\n\n` };
	}

	/** True if the kimi JWT access token is expired or unparseable. */
	private isKimiTokenExpired(token: string): boolean {
		try {
			const payload = JSON.parse(
				Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
			) as { exp?: number };
			return typeof payload.exp === "number" && payload.exp * 1000 < Date.now();
		} catch {
			return true;
		}
	}

	/** Use the refresh_token to mint a fresh kimi access token. */
	private async refreshKimiToken(page: Page): Promise<string | null> {
		const refreshToken = this.auth.refreshToken;
		if (!refreshToken) return null;
		try {
			const result = await page.evaluate(
				async ({ rt }: { rt: string }) => {
					const res = await fetch("https://www.kimi.com/api/auth/token/refresh", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ refresh_token: rt }),
					});
					if (!res.ok) return null;
					const data = (await res.json()) as { access_token?: string };
					return data.access_token ?? null;
				},
				{ rt: refreshToken },
			);
			if (result && typeof result === "string" && result.length > 50) {
				(this.auth as { accessToken?: string }).accessToken = result;
				return result;
			}
			return null;
		} catch {
			return null;
		}
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseKimiStream(body, onDelta);
	}
}
