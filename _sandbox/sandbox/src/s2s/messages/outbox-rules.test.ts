import { backoffMs, expired, retryable, retryAfterMs, verdictOf } from "./outbox-rules.js";

// The outbox's retry rules: what one attempt's answer comes to, the backoff between attempts, the far side's Retry-After,
// and the week after which a send is let go.

const NOW = Date.parse("2026-11-27T12:00:00Z");
const WEEK = 7 * 24 * 60 * 60 * 1000;

test("the backoff doubles from 30 seconds and stops at 30 minutes", () => {
    expect([0, 1, 2, 3, 6, 7, 20].map(backoffMs)).toEqual([30_000, 30_000, 60_000, 120_000, 960_000, 1_800_000, 1_800_000]);
});

test("Retry-After is read as seconds or as an HTTP date, never negative, at most a day, and unreadable as absent", () => {
    expect(retryAfterMs("120", NOW)).toBe(120_000);
    expect(retryAfterMs(" 0 ", NOW)).toBe(0);
    expect(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(retryAfterMs(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(retryAfterMs("999999", NOW)).toBe(24 * 60 * 60 * 1000);
    expect(retryAfterMs("soon", NOW)).toBeUndefined();
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
});

test("no answer, 401, 404, 429 and 5xx are tried again; a refusal in words is not", () => {
    expect([0, 401, 404, 429, 500, 503].map(retryable)).toEqual([true, true, true, true, true, true]);
    expect([400, 403, 409, 413, 422].map(retryable)).toEqual([false, false, false, false, false]);
});

test("200 and 202 deliver; a worded refusal ends it at once with its words and code", () => {
    expect(verdictOf({ status: 202 }, 1, NOW, NOW)).toEqual({ kind: "delivered" });
    expect(verdictOf({ status: 200 }, 3, NOW, NOW)).toEqual({ kind: "delivered" });
    expect(verdictOf({ status: 403, error: "this sandbox has not granted yours message", code: "grant" }, 1, NOW, NOW)).toEqual({
        kind: "refused",
        reason: "this sandbox has not granted yours message (grant)",
    });
    expect(verdictOf({ status: 422 }, 1, NOW, NOW)).toEqual({ kind: "refused", reason: "it answered 422" });
});

test("a retry waits the far side's Retry-After when it says one, else the backoff for the attempts so far", () => {
    expect(verdictOf({ status: 503, retryAfter: "15" }, 1, NOW, NOW)).toEqual({ kind: "retry", at: NOW + 15_000, reason: "it answered 503" });
    expect(verdictOf({ status: 0, error: "it did not answer" }, 3, NOW, NOW)).toEqual({ kind: "retry", at: NOW + 120_000, reason: "it did not answer" });
    expect(verdictOf({ status: 401 }, 1, NOW, NOW)).toEqual({
        kind: "retry",
        at: NOW + 30_000,
        reason: "its daemon is too old to take messages: updating that sandbox brings it",
    });
    expect(verdictOf({ status: 429, error: "at most 60 message envelopes a minute from one contact", code: "rate" }, 2, NOW, NOW)).toEqual({
        kind: "retry",
        at: NOW + 60_000,
        reason: "at most 60 message envelopes a minute from one contact (rate)",
    });
});

test("a retry that would fall past the week is let go instead, saying why it waited", () => {
    const firstAt = NOW - WEEK + 10_000;
    expect(verdictOf({ status: 503 }, 9, firstAt, NOW)).toEqual({ kind: "refused", reason: "not taken within a week: it answered 503" });
    expect(verdictOf({ status: 503 }, 9, NOW - WEEK + 1_800_000, NOW)).toEqual({ kind: "retry", at: NOW + 1_800_000, reason: "it answered 503" });
    expect(expired(NOW - WEEK, NOW)).toBe(false);
    expect(expired(NOW - WEEK - 1, NOW)).toBe(true);
});
