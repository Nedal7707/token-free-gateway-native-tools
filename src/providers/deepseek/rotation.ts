/**
 * Pure account-rotation helpers for multi-account web providers.
 * Kept free of network/browser imports so they are trivially unit-testable.
 */

const LIMIT_PATTERNS = [
	/rate\s*limit/i,
	/too\s*many\s*requests/i,
	/due\s*to\s*limit/i,
	/limit\s*exceeded/i,
	/exhausted/i,
	/usage\s*limit/i,
];

/**
 * Decide whether an upstream HTTP failure is a rate limit.
 * HTTP 429 is definitive; otherwise the response body is scanned for
 * common limit wording (DeepSeek returns "due to limit" style messages).
 */
export function isRateLimitError(status: number, bodyText: string): boolean {
	if (status === 429) return true;
	if (status < 400) return false;
	return LIMIT_PATTERNS.some((re) => re.test(bodyText));
}

/**
 * Pick the next available account index, round-robin starting after
 * `fromIndex`, skipping accounts in the `limited` set.
 * Returns -1 when every account is limited.
 */
export function pickNextAccount(
	accountCount: number,
	limited: ReadonlySet<number>,
	fromIndex: number,
): number {
	if (accountCount <= 0) return -1;
	for (let step = 1; step <= accountCount; step++) {
		const candidate = (fromIndex + step) % accountCount;
		if (!limited.has(candidate)) return candidate;
	}
	return -1;
}