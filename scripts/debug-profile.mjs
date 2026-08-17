// debug-profile.mjs — inspect a DeepSeek profile's actual login state
import { chromium } from "playwright-core";
import { getChromeWebSocketUrl, getHeadersWithAuth } from "../src/browser/cdp-helpers.ts";

const port = Number(process.argv[2] ?? 9223);
const wsUrl = await getChromeWebSocketUrl(`http://127.0.0.1:${port}`, 4000);
if (!wsUrl) {
	console.log(`port ${port}: CDP unreachable`);
	process.exit(1);
}
const browser = await chromium.connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) });
try {
	const context = browser.contexts()[0];
	const pages = context.pages();
	console.log(`port ${port}: ${pages.length} page(s)`);
	for (const p of pages) {
		console.log(`  url: ${p.url()}`);
	}
	const page = pages.find((p) => p.url().includes("deepseek.com")) ?? pages[0];
	if (!page) {
		console.log("  no page");
		process.exit(0);
	}
	try {
		await page.goto("https://chat.deepseek.com", { timeout: 8000 });
	} catch {}
	await new Promise((r) => setTimeout(r, 2000));
	const state = await page.evaluate(() => {
		const store = globalThis.localStorage;
		const keys = [];
		for (let i = 0; i < store.length; i++) {
			const k = store.key(i);
			if (k) keys.push(k);
		}
		const tokenish = {};
		for (const k of keys) {
			if (/token|auth|user/i.test(k)) {
				const v = store.getItem(k) ?? "";
				tokenish[k] = v.length > 120 ? v.slice(0, 40) + "..." : v;
			}
		}
		const cookies = document.cookie;
		return { keys, tokenish, cookieLen: cookies.length, cookieSample: cookies.slice(0, 200) };
	});
	console.log("localStorage keys:", JSON.stringify(state.keys));
	console.log("token-ish:", JSON.stringify(state.tokenish, null, 2));
	console.log("document.cookie len:", state.cookieLen, "sample:", state.cookieSample);
	const title = await page.title().catch(() => "");
	console.log("title:", title);
} finally {
	await browser.close().catch(() => {});
}