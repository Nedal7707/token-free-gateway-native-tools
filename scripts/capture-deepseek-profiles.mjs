/**
 * capture-deepseek-profiles.mjs
 *
 * Capture DeepSeek sessions from all multi-profile Chrome instances and
 * save them into the gateway's rotation pool. Run AFTER logging into each
 * profile (see launch-deepseek-profiles.mjs).
 *
 * Usage:
 *   bun scripts/capture-deepseek-profiles.mjs            # ports 9222-9226
 *   bun scripts/capture-deepseek-profiles.mjs --count 3  # ports 9222-9224
 *
 * Each captured account is APPENDED to the pool (addAccountCredentials),
 * so re-running after re-login refreshes that account's credentials.
 */
import { captureDeepseekSessionFromPort } from "../src/providers/deepseek/auth.ts";
import { addAccountCredentials, getCredentialPool } from "../src/providers/auth-store.ts";

const DEFAULT_COUNT = 5;
const BASE_PORT = 9222;

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
	console.log(`Capturing DeepSeek sessions from ${count} Chrome profile(s)...`);

	let captured = 0;
	for (let i = 0; i < count; i++) {
		const port = BASE_PORT + i;
		try {
			const creds = await captureDeepseekSessionFromPort(port, (msg) => {
				console.log(`  [${port}] ${msg}`);
			});
			if (creds) {
				addAccountCredentials("deepseek-web", creds);
				console.log(`  [${port}] ✓ captured account ${i + 1} (cdpPort=${creds.cdpPort})`);
				captured++;
			} else {
				console.log(`  [${port}] — no session found (not logged in?)`);
			}
		} catch (err) {
			console.log(`  [${port}] ✗ ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const pool = getCredentialPool("deepseek-web");
	console.log("");
	console.log(`Captured ${captured}/${count}. Rotation pool now has ${pool.length} account(s).`);
	if (pool.length === 0) {
		console.log("No accounts captured. Log into the profiles first, then re-run.");
		process.exit(1);
	}
	console.log("Restart the gateway to load the pool:");
	console.log("  bun index.ts restart");
	console.log("Verify:");
	console.log("  Get-Content \"$HOME\\.token-free-gateway\\auth-profiles.json\"");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});