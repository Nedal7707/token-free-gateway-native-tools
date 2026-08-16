/**
 * launch-deepseek-profiles.mjs
 *
 * Launch N dedicated Chrome profiles for DeepSeek multi-account rotation.
 * Each profile has its own user-data-dir and CDP debug port, so every
 * account can stay logged in PERMANENTLY and the gateway rotates between
 * them automatically on rate limits — no manual re-login ever again.
 *
 * Usage:
 *   bun scripts/launch-deepseek-profiles.mjs            # 5 profiles, ports 9222-9226
 *   bun scripts/launch-deepseek-profiles.mjs --count 3  # 3 profiles, ports 9222-9224
 *
 * After launching, log into each window with a DIFFERENT DeepSeek account,
 * then run:
 *   bun scripts/capture-deepseek-profiles.mjs
 * to save all logged-in sessions into the rotation pool.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_COUNT = 5;
const BASE_PORT = 9222;
const PROFILE_DIR = join(homedir(), ".token-free-gateway", "chrome-profiles", "deepseek");

function detectChrome() {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const programFiles = process.env.PROGRAMFILES ?? "";
	const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "";
	const candidates = [
		join(localAppData, "Google/Chrome/Application/chrome.exe"),
		join(programFiles, "Google/Chrome/Application/chrome.exe"),
		join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

async function isCdpRunning(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForCdp(port, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isCdpRunning(port)) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

function parseCount() {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--count") {
			const n = Number(args[i + 1]);
			if (Number.isFinite(n) && n > 0) return Math.min(n, 10);
		}
	}
	return DEFAULT_COUNT;
}

async function main() {
	const count = parseCount();
	const chromePath = detectChrome();
	if (!chromePath) {
		console.error("✗ Chrome not found. Install Google Chrome first.");
		process.exit(1);
	}

	console.log("==============================================");
	console.log(`  DeepSeek multi-account Chrome profiles (${count})`);
	console.log(`  Chrome : ${chromePath}`);
	console.log(`  Profiles: ${PROFILE_DIR}`);
	console.log("==============================================");

	let launched = 0;
	for (let i = 0; i < count; i++) {
		const port = BASE_PORT + i;
		const profile = join(PROFILE_DIR, `account-${i + 1}`);

		if (await isCdpRunning(port)) {
			console.log(`  [${port}] already running — skipping (profile ${i + 1})`);
			continue;
		}

		const flags = [
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-translate",
			"--disable-features=TranslateUI",
			"--remote-allow-origins=*",
			"https://chat.deepseek.com/",
		];

		const proc = spawn(chromePath, flags, {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		});
		proc.unref();

		console.log(`  [${port}] launching Chrome profile ${i + 1} (${profile})...`);
		if (await waitForCdp(port)) {
			console.log(`  [${port}] ✓ CDP ready`);
			launched++;
		} else {
			console.error(`  [${port}] ✗ Chrome did not become ready in time`);
		}
	}

	console.log("");
	console.log("Next steps:");
	console.log(`  1. In each window, log in with a DIFFERENT DeepSeek account.`);
	console.log(`     (${launched} profile(s) launched; skip any already-running port.)`);
	console.log("  2. Once all are logged in, capture the sessions:");
	console.log("       bun scripts/capture-deepseek-profiles.mjs");
	console.log("  3. Restart the gateway to load the pool:");
	console.log("       bun index.ts restart");
	console.log("");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});