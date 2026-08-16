/**
 * Persistent credential store for web AI providers.
 * Stores auth profiles in <homedir>/.token-free-gateway/auth-profiles.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AuthProfile {
	providerId: string;
	credentials: unknown;
	updatedAt: string;
}

export interface AuthStore {
	profiles: Record<string, AuthProfile>;
}

const DEFAULT_STORE_PATH = join(homedir(), ".token-free-gateway", "auth-profiles.json");

/** Returns the active store path. Override with TFG_STORE_PATH (used in tests). */
export function getStorePath(): string {
	return process.env.TFG_STORE_PATH ?? DEFAULT_STORE_PATH;
}

function ensureStoreDir(storePath: string): void {
	const dir = dirname(storePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

export function loadAuthStore(): AuthStore {
	const storePath = getStorePath();
	try {
		if (existsSync(storePath)) {
			const raw = readFileSync(storePath, "utf-8");
			return JSON.parse(raw) as AuthStore;
		}
	} catch (e) {
		console.warn(`[auth-store] Failed to load ${storePath}: ${e}`);
	}
	return { profiles: {} };
}

export function saveAuthStore(store: AuthStore): void {
	const storePath = getStorePath();
	ensureStoreDir(storePath);
	writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

export function getCredentials<T = unknown>(providerId: string): T | null {
	const store = loadAuthStore();
	const profile = store.profiles[providerId];
	if (!profile) return null;
	return profile.credentials as T;
}

export function saveCredentials(providerId: string, credentials: unknown): void {
	const store = loadAuthStore();
	store.profiles[providerId] = {
		providerId,
		credentials,
		updatedAt: new Date().toISOString(),
	};
	saveAuthStore(store);
}

/**
 * Append a credential set to a provider's account pool. The first call
 * behaves like saveCredentials; subsequent calls convert the stored shape
 * to an array pool (single object → [old, new]) so providers like DeepSeek
 * can rotate across multiple accounts on rate limits. Duplicate credentials
 * (same JSON) are skipped.
 */
export function addAccountCredentials(providerId: string, credentials: unknown): void {
	const store = loadAuthStore();
	const existing = store.profiles[providerId]?.credentials;
	let pool: unknown[];
	if (Array.isArray(existing)) {
		pool = [...existing];
	} else if (existing !== undefined && existing !== null) {
		pool = [existing];
	} else {
		pool = [];
	}
	const key = JSON.stringify(credentials);
	if (!pool.some((c) => JSON.stringify(c) === key)) {
		pool.push(credentials);
	}
	store.profiles[providerId] = {
		providerId,
		credentials: pool.length === 1 ? pool[0] : pool,
		updatedAt: new Date().toISOString(),
	};
	saveAuthStore(store);
}

/**
 * Normalize a provider's stored credentials into an account pool (array).
 * Supports the legacy single-object shape, an array pool, and the
 * `{ accounts: [...] }` shape. Returns an empty array when absent.
 */
export function getCredentialPool(providerId: string): unknown[] {
	const creds = getCredentials(providerId);
	if (creds === null || creds === undefined) return [];
	if (Array.isArray(creds)) return creds;
	if (
		typeof creds === "object" &&
		Array.isArray((creds as { accounts?: unknown[] }).accounts) &&
		((creds as { accounts?: unknown[] }).accounts?.length ?? 0) > 0
	) {
		return (creds as { accounts: unknown[] }).accounts;
	}
	return [creds];
}

export function listAuthorizedProviders(): string[] {
	const store = loadAuthStore();
	return Object.keys(store.profiles);
}
