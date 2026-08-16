/**
 * watchdog.mjs — keep the token-free gateway alive and healthy.
 *
 * Checks the gateway health endpoint every `--interval-sec` seconds; if the
 * gateway is down or unhealthy, restarts it via the daemon (bun index.ts
 * daemon start) and logs the event. Run as a persistent process:
 *
 *   bun scripts/watchdog.mjs                # default: check every 30s
 *   bun scripts/watchdog.mjs --interval-sec 60
 *   bun scripts/watchdog.mjs --once         # single check, exit
 *
 * The watchdog is a maintenance helper only: it never touches provider
 * sessions, credentials, or the product repo.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const GATEWAY_URL = process.env.TFG_GATEWAY_URL ?? "http://127.0.0.1:3461";
const HEALTH_PATH = "/health";
const DEV_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const args = process.argv.slice(2);

function parseArgs() {
	let intervalSec = 30;
	let once = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--interval-sec") intervalSec = Number(args[i + 1]) || 30;
		if (args[i] === "--once") once = true;
	}
	return { intervalSec, once };
}

function log(msg) {
	console.log(`[watchdog ${new Date().toISOString()}] ${msg}`);
}

async function isHealthy() {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 5000);
		const res = await fetch(`${GATEWAY_URL}${HEALTH_PATH}`, { signal: ctrl.signal });
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

function startDaemon() {
	return new Promise((resolve) => {
		log("Gateway down — restarting via daemon...");
		const child = spawn("bun", ["index.ts", "start"], {
			cwd: DEV_DIR,
			stdio: "inherit",
			windowsHide: true,
		});
		child.on("exit", (code) => {
			log(`daemon start exited with code ${code}`);
			resolve(code === 0);
		});
		child.on("error", (err) => {
			log(`daemon start failed: ${err.message}`);
			resolve(false);
		});
	});
}

async function checkOnce() {
	const healthy = await isHealthy();
	if (healthy) {
		log("gateway healthy");
		return true;
	}
	// Wait a moment in case the gateway is mid-restart, then try once.
	await new Promise((r) => setTimeout(r, 2000));
	if (await isHealthy()) {
		log("gateway healthy (recovered)");
		return true;
	}
	return startDaemon();
}

const { intervalSec, once } = parseArgs();

if (once) {
	const ok = await checkOnce();
	process.exit(ok ? 0 : 1);
}

log(`watchdog started (interval ${intervalSec}s, target ${GATEWAY_URL})`);
while (true) {
	await new Promise((r) => setTimeout(r, intervalSec * 1000));
	await checkOnce();
}