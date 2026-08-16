/**
 * memory-ledger.ts — persistent per-conversation memory for the gateway.
 *
 * "Never forget" layer: every turn's key content is appended to a per-
 * conversation JSONL file on disk. Nothing is ever deleted. On each request
 * the bounded recent tail is re-injected as a system memory block, so even
 * when compaction trims the live prompt, the conversation's memory survives
 * (and survives gateway restarts).
 *
 * The ledger is a maintenance/memory aid only: it never touches provider
 * sessions or credentials, and it is append-only (no mutation of history).
 */
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const MEMORY_DIR = join(homedir(), ".token-free-gateway", "memory");
const TAIL_LIMIT = 12; // most recent ledger entries injected per request
const ENTRY_CHAR_LIMIT = 2_000; // per-entry text cap (keeps the tail bounded)

type LedgerEntry = {
	ts: string;
	role: "user" | "assistant" | "tool" | "summary";
	text: string;
};

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

/** Stable conversation key: hash of the first user message + model id. */
export function conversationKey(model: string, messages: unknown[]): string {
	const firstUser = messages.find((m) => (m as { role?: string })?.role === "user");
	const text = (firstUser as { content?: string })?.content ?? "";
	return sha256(`${model}|${text.slice(0, 1_000)}`);
}

function ledgerPath(key: string): string {
	return join(MEMORY_DIR, `${key}.jsonl`);
}

function truncate(text: string, limit = ENTRY_CHAR_LIMIT): string {
	if (!text) return "";
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Append one entry (best-effort; never throws into the request path). */
export async function appendLedgerEntry(
	key: string,
	role: LedgerEntry["role"],
	text: string,
): Promise<void> {
	try {
		await mkdir(MEMORY_DIR, { recursive: true });
		const entry: LedgerEntry = { ts: new Date().toISOString(), role, text: truncate(text) };
		await appendFile(ledgerPath(key), `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// Memory is best-effort — never fail a request because of it.
	}
}

/** Read the bounded recent tail of the ledger (newest last). */
export async function readLedgerTail(key: string, limit = TAIL_LIMIT): Promise<LedgerEntry[]> {
	try {
		const raw = await readFile(ledgerPath(key), "utf8");
		const lines = raw.split("\n").filter(Boolean);
		const tail = lines.slice(-limit);
		return tail
			.map((line) => {
				try {
					return JSON.parse(line) as LedgerEntry;
				} catch {
					return null;
				}
			})
			.filter((e): e is LedgerEntry => e !== null);
	} catch {
		return [];
	}
}

/** Render the ledger tail as a system memory block ("" when empty). */
export function renderLedgerMemory(entries: LedgerEntry[]): string {
	if (entries.length === 0) return "";
	const parts = entries.map((e) => `[${e.role} @ ${e.ts}] ${e.text}`);
	return `[Persistent conversation memory (recent turns, never deleted):\n${parts.join("\n")}\n]`;
}