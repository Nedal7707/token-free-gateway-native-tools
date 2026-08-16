import { describe, expect, test } from "bun:test";
import { isRateLimitError, pickNextAccount } from "../src/providers/deepseek/rotation.ts";

describe("isRateLimitError", () => {
	test("429 is always a rate limit", () => {
		expect(isRateLimitError(429, "anything")).toBe(true);
		expect(isRateLimitError(429, "")).toBe(true);
	});

	test("limit wording in the body is detected on 4xx", () => {
		expect(isRateLimitError(400, "rate limit exceeded")).toBe(true);
		expect(isRateLimitError(403, "Too Many Requests")).toBe(true);
		expect(isRateLimitError(503, '{"error":"due to limit"}')).toBe(true);
		expect(isRateLimitError(500, "usage limit reached")).toBe(true);
		expect(isRateLimitError(500, "limit exceeded for account")).toBe(true);
	});

	test("non-limit 4xx/5xx are not rate limits", () => {
		expect(isRateLimitError(400, "bad request")).toBe(false);
		expect(isRateLimitError(401, "unauthorized")).toBe(false);
		expect(isRateLimitError(500, "internal server error")).toBe(false);
	});

	test("success statuses are never rate limits", () => {
		expect(isRateLimitError(200, "rate limit")).toBe(false);
		expect(isRateLimitError(301, "rate limit")).toBe(false);
	});
});

describe("pickNextAccount", () => {
	test("rotates to the next account", () => {
		expect(pickNextAccount(3, new Set(), 0)).toBe(1);
		expect(pickNextAccount(3, new Set(), 1)).toBe(2);
		expect(pickNextAccount(3, new Set(), 2)).toBe(0);
	});

	test("skips limited accounts", () => {
		expect(pickNextAccount(3, new Set([1]), 0)).toBe(2);
		// from-index not limited: wrapping around to it is the only candidate.
		expect(pickNextAccount(3, new Set([1, 2]), 0)).toBe(0);
		expect(pickNextAccount(3, new Set([0, 1]), 1)).toBe(2);
		// Client usage: the current account is always added to limited first.
		expect(pickNextAccount(3, new Set([0, 1, 2]), 0)).toBe(-1);
	});

	test("single account returns -1 when limited", () => {
		expect(pickNextAccount(1, new Set([0]), 0)).toBe(-1);
		expect(pickNextAccount(1, new Set(), 0)).toBe(0);
	});

	test("empty pool returns -1", () => {
		expect(pickNextAccount(0, new Set(), 0)).toBe(-1);
	});
});