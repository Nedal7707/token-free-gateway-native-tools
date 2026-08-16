/**
 * Centralized browser lifecycle manager for all web AI providers.
 * Maintains a single shared CDP connection to Chrome, with auto-reconnection,
 * health checking, and optional Chrome auto-start.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { getChromeWebSocketUrl, getDefaultCdpUrl, getHeadersWithAuth } from "./cdp-helpers.ts";

export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure?: boolean;
}

class BrowserManager {
	private static instance: BrowserManager | null = null;

	/** Per-CDP-port connection state (multi-profile Chrome support). */
	private connections = new Map<
		string,
		{
			browser: Browser | null;
			context: BrowserContext | null;
			connecting: Promise<BrowserContext> | null;
			disconnected: boolean;
		}
	>();

	static getInstance(): BrowserManager {
		if (!BrowserManager.instance) {
			BrowserManager.instance = new BrowserManager();
		}
		return BrowserManager.instance;
	}

	/** Resolve the CDP URL for a port. Default port uses the configured URL. */
	private cdpUrlForPort(port?: number): string {
		if (port === undefined) return getDefaultCdpUrl();
		return `http://127.0.0.1:${port}`;
	}

	private stateForPort(port?: number) {
		const key = this.cdpUrlForPort(port);
		let state = this.connections.get(key);
		if (!state) {
			state = { browser: null, context: null, connecting: null, disconnected: false };
			this.connections.set(key, state);
		}
		return state;
	}

	/**
	 * Get the BrowserContext for a CDP port (default: configured port),
	 * connecting if needed. Concurrent callers share the same in-flight
	 * connection promise per port.
	 */
	async getContext(port?: number): Promise<BrowserContext> {
		const state = this.stateForPort(port);
		if (state.context && !state.disconnected) {
			return state.context;
		}

		if (state.connecting) {
			return state.connecting;
		}

		state.connecting = this.connect(port);
		try {
			const ctx = await state.connecting;
			return ctx;
		} finally {
			state.connecting = null;
		}
	}

	/**
	 * Get or create a page for the given domain on a specific CDP port.
	 * Reuses an existing tab whose URL contains the domain string.
	 */
	async getPage(domain: string, fallbackUrl?: string, port?: number): Promise<Page> {
		const ctx = await this.getContext(port);
		const pages = ctx.pages();
		const existing = pages.find((p) => p.url().includes(domain));
		if (existing) return existing;

		const page = await ctx.newPage();
		if (fallbackUrl) {
			await page.goto(fallbackUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
		}
		return page;
	}

	/**
	 * Inject cookies into a browser context (default port).
	 */
	async addCookies(cookies: BrowserCookie[], port?: number): Promise<void> {
		const ctx = await this.getContext(port);
		if (cookies.length > 0) {
			try {
				await ctx.addCookies(cookies);
			} catch (err) {
				console.warn(
					`[BrowserManager] addCookies failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	/**
	 * Check whether Chrome is reachable and the CDP connection is alive.
	 */
	async isHealthy(): Promise<boolean> {
		const state = this.stateForPort();
		if (state.disconnected || !state.browser || !state.context) {
			// Try a lightweight CDP probe even without an active connection
			const cdpUrl = getDefaultCdpUrl();
			const ws = await getChromeWebSocketUrl(cdpUrl, 3000);
			return ws !== null;
		}

		try {
			// Verify the context is still responsive
			const pages = state.context.pages();
			return pages.length >= 0; // will throw if disconnected
		} catch {
			return false;
		}
	}

	/**
	 * Graceful shutdown: disconnect from Chrome without killing it.
	 */
	async shutdown(): Promise<void> {
		for (const state of this.connections.values()) {
			if (state.browser) {
				try {
					state.browser.removeAllListeners("disconnected");
					await state.browser.close().catch(() => {});
				} catch {
					// ignore
				}
			}
			state.browser = null;
			state.context = null;
			state.disconnected = true;
			state.connecting = null;
		}
		this.connections.clear();
	}

	// ── internal ──────────────────────────────────────────────────────

	private async connect(port?: number): Promise<BrowserContext> {
		const cdpUrl = this.cdpUrlForPort(port);
		console.log(`[BrowserManager] Connecting to Chrome at ${cdpUrl}...`);

		let wsUrl: string | null = null;
		for (let attempt = 0; attempt < 15; attempt++) {
			wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
			if (wsUrl) break;

			// On first failure, try to auto-start Chrome (default port only)
			if (attempt === 2 && port === undefined) {
				await this.tryAutoStartChrome();
			}

			await new Promise((r) => setTimeout(r, 1000));
		}

		if (!wsUrl) {
			throw new Error(
				`[BrowserManager] Failed to connect to Chrome at ${cdpUrl}. ` +
					"Make sure Chrome is running in debug mode (token-free-gateway chrome start).",
			);
		}

		const browser = await chromium.connectOverCDP(wsUrl, {
			headers: getHeadersWithAuth(wsUrl),
		});

		const ctx = browser.contexts()[0];
		if (!ctx) {
			throw new Error("[BrowserManager] CDP connection returned no browser context");
		}

		const state = this.stateForPort(port);
		state.browser = browser;
		state.context = ctx;
		state.disconnected = false;

		browser.on("disconnected", () => {
			console.warn(`[BrowserManager] Chrome at ${cdpUrl} disconnected. Will auto-reconnect on next request.`);
			state.browser = null;
			state.context = null;
			state.disconnected = true;
		});

		const pageCount = ctx.pages().length;
		console.log(
			`[BrowserManager] Connected successfully (${pageCount} existing tab${pageCount !== 1 ? "s" : ""})`,
		);

		return ctx;
	}

	private async tryAutoStartChrome(): Promise<void> {
		try {
			console.log("[BrowserManager] Chrome not reachable, attempting auto-start...");
			const { startChrome } = await import("../cli/chrome.ts");
			await startChrome();
		} catch (err) {
			console.warn(
				`[BrowserManager] Auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export { BrowserManager };
