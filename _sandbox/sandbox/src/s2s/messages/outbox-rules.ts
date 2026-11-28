import { S2S_OUTBOX_BACKOFF_BASE_MS, S2S_OUTBOX_BACKOFF_MAX_MS, S2S_OUTBOX_KEEP_MS } from "@intentic/sandbox-contract/schemas/s2s";

// WHAT ONE DELIVERY ATTEMPT CAME TO (docs/architecture/messages.md, "The outbox"), as pure rules the outbox applies and
// its tests pin: retried on no answer, 404, 429, 5xx and "too old" (401, a daemon from before the door), honouring the
// far side's Retry-After, otherwise after `min(30 s · 2^n, 30 min)`, for a week; a refusal in words (400, 403, 409, 413,
// 422) ends it at once, saying why.

// How long the far side's Retry-After is believed, at most: a day, so a sender is never parked past its week by one answer.
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

// What one POST /s2s/inbox answered: its status (0 for no answer at all), its Retry-After, and its words.
export interface Attempted {
    readonly status: number;
    readonly retryAfter?: string | undefined;
    readonly error?: string | undefined;
    readonly code?: string | undefined;
}

export type Verdict =
    | { readonly kind: "delivered" }
    | { readonly kind: "retry"; readonly at: number; readonly reason: string }
    | { readonly kind: "refused"; readonly reason: string };

/** The wait before attempt `attempts + 1`, after `attempts` that did not land: 30 s, 1 min, 2 min, … up to 30 min. */
export const backoffMs = (attempts: number): number => Math.min(S2S_OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), S2S_OUTBOX_BACKOFF_MAX_MS);

/** The far side's Retry-After as a wait from `now`: seconds, or an HTTP date; undefined when absent or unreadable. */
export const retryAfterMs = (header: string | undefined, now: number): number | undefined => {
    const text = header?.trim() ?? "";
    if (text === "") {
        return undefined;
    }
    const seconds = /^\d+$/u.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
    return Number.isFinite(seconds) ? Math.min(Math.max(0, seconds), RETRY_AFTER_MAX_MS) : undefined;
};

/** Whether an answer is worth another attempt later: none at all, 404, 429, 5xx, and 401 (too old for the door). */
export const retryable = (status: number): boolean => status === 0 || status === 401 || status === 404 || status === 429 || status >= 500;

const reasonOf = (attempt: Attempted): string => {
    if (attempt.status === 0) {
        return attempt.error ?? "it did not answer";
    }
    if (attempt.status === 401) {
        return "its daemon is too old to take messages: updating that sandbox brings it";
    }
    return attempt.error === undefined ? `it answered ${attempt.status}` : `${attempt.error}${attempt.code === undefined ? "" : ` (${attempt.code})`}`;
};

/**
 * The verdict on one attempt, the `attempts`-th (counting it), for an entry first filed at `firstAt`: delivered on 200
 * or 202; refused for good on any other answer that is not retryable; otherwise retried at the far side's Retry-After or
 * the backoff, unless that falls past the week, which refuses it as not taken in time.
 */
export const verdictOf = (attempt: Attempted, attempts: number, firstAt: number, now: number): Verdict => {
    if (attempt.status === 200 || attempt.status === 202) {
        return { kind: "delivered" };
    }
    const reason = reasonOf(attempt);
    if (!retryable(attempt.status)) {
        return { kind: "refused", reason };
    }
    const at = now + (retryAfterMs(attempt.retryAfter, now) ?? backoffMs(attempts));
    return at - firstAt > S2S_OUTBOX_KEEP_MS ? { kind: "refused", reason: `not taken within a week: ${reason}` } : { kind: "retry", at, reason };
};

/** Whether an entry first filed at `firstAt` has waited past its week. */
export const expired = (firstAt: number, now: number): boolean => now - firstAt > S2S_OUTBOX_KEEP_MS;
