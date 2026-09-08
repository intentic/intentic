import type { LimitResetClaim, LimitResetStatus } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJsonVia } from "../../sandbox/client/sandboxClient";

// Client side of the session-limit reset: the provider can reopen a spent five-hour window once a week per account
// without touching the weekly allowance. Asked once per account, never on a timer — the endpoint rate-limits hard.
// A failed ask is not cached, so the next strip for that account tries again.

const answers = ref(new Map<string, LimitResetStatus>());
// One in-flight request per account; cleared on settle so a retry after a failure isn't joined to a dead one.
const asking = new Map<string, Promise<void>>();

/** What the provider said about this account, or undefined while nobody has asked or the ask failed. */
export const limitResetFor = (account: string | undefined): LimitResetStatus | undefined =>
    account === undefined ? undefined : answers.value.get(account);

// Asks once per account; `at` targets the conversation's own sandbox, since another box wouldn't hold this account.
// Returns the in-flight promise so a caller can tell "not cached" from "still asking" without polling.
export const askLimitReset = async (account: string | undefined, at?: string): Promise<void> => {
    if (account === undefined || answers.value.has(account)) {
        return;
    }
    const joined = asking.get(account);
    if (joined !== undefined) {
        return joined;
    }
    const request = sandboxJsonVia<LimitResetStatus>(at, `/usage/limit-reset/${encodeURIComponent(account)}`)
        .then((status) => {
            answers.value.set(account, status);
        })
        .catch(() => {
            // Left unanswered on purpose: an unreachable daemon must not become a durable "no".
        })
        .finally(() => {
            asking.delete(account);
        });
    asking.set(account, request);
    return request;
};

// Marks results that proved nothing, so a network or server error leaves the cached offer up for retry.
const RETRYABLE = new Set([`unavailable`, `error`]);

export const claimLimitReset = async (account: string, at?: string): Promise<LimitResetClaim> => {
    const claim = await sandboxJsonVia<LimitResetClaim>(at, `/usage/limit-reset/${encodeURIComponent(account)}/claim`, jsonBody(`POST`, {})).catch(
        (): LimitResetClaim => ({ result: `error`, detail: `Your sandbox didn't answer.` }),
    );
    if (!RETRYABLE.has(claim.result)) {
        answers.value.delete(account);
    }
    return claim;
};

// One line of feedback per claim result, for someone who just pressed the button. `reset` returns none: the window
// is already open and the turn is going again.
export const limitResetNote = (claim: LimitResetClaim): string => {
    switch (claim.result) {
        case `reset`:
            return ``;
        case `already_used`:
            return `This week's reset is already spent.`;
        case `not_limited`:
            return `The window had already reopened — just continue.`;
        case `ineligible`:
            return `Anthropic didn't grant this account a reset. Its current limit still applies.`;
        default:
            return claim.detail ?? `Couldn't reset it right now — try again in a moment.`;
    }
};
