/**
 * Real-time push streaming for browser-backed providers.
 *
 * Instead of buffering the whole response inside page.evaluate (slow, bursty)
 * or polling a window buffer (coalesces into bursts), we expose a Node-side
 * push function into the page via page.exposeFunction. The browser's fetch
 * reader calls it per chunk → Node enqueues into a ReadableStream IMMEDIATELY.
 * This gives true letter-by-letter streaming.
 */

import type { Page } from "playwright-core";

export interface PushStreamHandle {
	stream: ReadableStream<Uint8Array>;
	/** Call from browser-side evaluate once the reader starts. */
	register(page: Page, key: string, startReader: (push: (chunk: string) => void) => Promise<void>): Promise<void>;
	close(): void;
}

const PUSH_INTERVAL_MS = 30;

/**
 * Create a push stream + the exposed callback name. Usage:
 *
 *   const { stream, register, close } = createPushStream();
 *   await page.exposeFunction(pushKey, (chunk: string) => push(chunk));
 *   // inside page.evaluate: read fetch body, call (globalThis as any)[pushKey](text) per read
 *   await register(page, pushKey, async (push) => { ... browser loop ... });
 *   return stream;
 */
export function createPushStream(): {
	stream: ReadableStream<Uint8Array>;
	pushKey: string;
	push: (chunk: string) => void;
	register(
		page: Page,
		pushKey: string,
		startReader: (push: (chunk: string) => void) => Promise<void>,
	): Promise<void>;
	close: () => void;
} {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;
	let pending: string[] = [];
	let timer: ReturnType<typeof setInterval> | null = null;

	const pushKey = `__tfg_push_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			closed = true;
			if (timer) clearInterval(timer);
		},
	});

	// Node-side push: queue and flush on a fast interval to avoid flooding
	// the stream with micro-chunks; 30ms gives smooth letter-by-letter flow.
	function push(chunk: string): void {
		if (closed || !chunk) return;
		pending.push(chunk);
		if (!timer) {
			timer = setInterval(() => {
				if (pending.length === 0) return;
				const batch = pending.join("");
				pending = [];
				try {
					controller?.enqueue(encoder.encode(batch));
				} catch {
					/* stream closed */
				}
			}, PUSH_INTERVAL_MS);
		}
	}

	async function register(
		page: Page,
		key: string,
		startReader: (push: (chunk: string) => void) => Promise<void>,
	): Promise<void> {
		try {
			await startReader(push);
		} finally {
			// Give the flush timer a last chance, then close.
			setTimeout(() => {
				if (timer) clearInterval(timer);
				try {
					controller?.close();
				} catch {
					/* already closed */
				}
				closed = true;
			}, 60);
		}
	}

	function close(): void {
		closed = true;
		if (timer) clearInterval(timer);
		try {
			controller?.close();
		} catch {
			/* already closed */
		}
	}

	return { stream, pushKey, push, register, close };
}
