import type { AccountUsage, LimitResetClaim, LimitResetStatus, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { claudeUsageWindows, rateLimitParkMs } from "../../agent/providers/claude/claude-usage.js";
import { asRecord, asString, resetFromIso } from "../../usage/payload.js";
import { CLAUDE_CLI_USER_AGENT, type ClaudeStore, ensureFreshToken } from "../../agent/providers/claude/claude-credentials.js";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";

/* Anthropic's once-a-week session reset. */

// This probe reads the same URL the headroom sweep does, so it shares that endpoint's park rather than keeping one of
// its own: the sweep's budget is only a budget if every reader of the endpoint is inside it. Satisfied by
// HeadroomService.
export interface UsageEndpointGate {
    readonly parked: (account: string) => Promise<boolean>;
    readonly park: (provider: AgentProvider, account: string, forMs: number) => Promise<void>;
    readonly record: (provider: AgentProvider, account: string, usage: AccountUsage) => Promise<void>;
}

export interface LimitResetDeps {
    readonly store: ClaudeStore;
    readonly headroom: UsageEndpointGate;
}

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const ORGANIZATIONS_ENDPOINT = "https://api.anthropic.com/api/organizations";
const PROGRAM = "juniper_tide";

const headers = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
    "User-Agent": CLAUDE_CLI_USER_AGENT,
});

// Probe must never outlive the strip that asked for it.
const PROBE_TIMEOUT_MS = 8_000;
// The claim is the press itself, given room to land; upstream waits 25s on the same call.
const CLAIM_TIMEOUT_MS = 25_000;

// A known absence of a grant. A failed probe returns undefined instead: caching a 429 as this answer hid
// an eligible account's reset for the rest of the page's life.
const NOTHING: LimitResetStatus = { available: false };

/* The offer requires general eligibility, an unspent grant, and enrollment in the reset arm. */
const statusFrom = (block: Record<string, unknown>): LimitResetStatus => {
    const available = block[`eligible`] === true && block[`available`] === true && block[`arm`] === "reset";
    const reason = asString(block[`ineligible_reason`]);
    const nextAvailableAt = resetFromIso(block[`next_available_at`]);
    const weeklyResetsAt = resetFromIso(block[`weekly_resets_at`]);
    return {
        available,
        ...(available || reason === undefined ? {} : { reason }),
        ...(nextAvailableAt === undefined ? {} : { nextAvailableAt }),
        ...(weeklyResetsAt === undefined ? {} : { weeklyResetsAt }),
    };
};

// The grant this answer describes, or undefined when the answer was not about one.
// `null` is what an account outside the programme gets, and it is a real answer rather than a failure: an
// organisation-managed plan is told nothing at all here, where a personal one is told why not.
const grantFrom = (body: Record<string, unknown> | undefined): LimitResetStatus | undefined => {
    if (body === undefined || !(PROGRAM in body)) {
        return undefined;
    }
    const block = asRecord(body[PROGRAM]);
    return body[PROGRAM] === null ? NOTHING : block === undefined || typeof block[`eligible`] !== "boolean" ? undefined : statusFrom(block);
};

// This answer is a whole usage payload, the same one the headroom sweep reads. Filing it is a reading the endpoint has
// already been paid for, and for an account at the wall it is the freshest one anything will get. Best-effort: a
// reading that could not be filed must not cost the answer about the reset.
const fileUsage = async (deps: LimitResetDeps, id: string, body: Record<string, unknown> | undefined): Promise<void> => {
    const windows = body === undefined ? [] : claudeUsageWindows(body);
    if (windows.length > 0) {
        await deps.headroom.record("claude", id, { windows, measuredAt: Date.now() }).catch(() => undefined);
    }
};

export const readLimitReset = async (deps: LimitResetDeps, id: string, fetchFn: typeof fetch = fetch): Promise<LimitResetStatus | undefined> => {
    // While the provider is holding this account's usage reads off, asking again only spends the budget the headroom
    // number depends on, and is answered with a longer stay-away. Unanswered, so a later probe can still offer a reset.
    if (await deps.headroom.parked(id)) {
        return undefined;
    }
    try {
        // Undefined is an account unconnected or revoked, a known absence; a renewal that failed throws, and is no answer.
        const token = await ensureFreshToken(deps.store, id);
        if (token === undefined) {
            return NOTHING;
        }
        const response = await fetchFn(USAGE_ENDPOINT, { headers: headers(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (response.status === 429) {
            // Armed from this reader's own refusal: a 429 is the endpoint's word to every caller, not just the sweep's.
            await deps.headroom.park("claude", id, rateLimitParkMs(response));
            return undefined;
        }
        if (!response.ok) {
            return response.status === 401 || response.status === 403 ? NOTHING : undefined;
        }
        const body = asRecord(await response.json());
        await fileUsage(deps, id, body);
        return grantFrom(body);
    } catch {
        return undefined;
    }
};

// uuid is on the profile, not the stored credential (which only has the organisation's name). Fetched at claim time so
// it can't go stale, at the cost of one round trip on a deliberate press.
const organizationUuid = async (token: string, fetchFn: typeof fetch): Promise<string | undefined> => {
    const response = await fetchFn(PROFILE_ENDPOINT, { headers: headers(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) {
        return undefined;
    }
    return asString(asRecord(asRecord(await response.json())?.[`organization`])?.[`uuid`]);
};

// Unrecognised result reads as unavailable: safe, since it neither claims a reset nor blames anyone.
const RESULTS = new Set(["reset", "already_used", "not_limited", "ineligible", "unavailable"]);

const claimFrom = (body: Record<string, unknown> | undefined): LimitResetClaim => {
    const result = asString(body?.[`result`]);
    const nextAvailableAt = resetFromIso(body?.[`next_available_at`]);
    return {
        result: result !== undefined && RESULTS.has(result) ? (result as LimitResetClaim["result"]) : "unavailable",
        ...(nextAvailableAt === undefined ? {} : { nextAvailableAt }),
    };
};

// A refused claim spent nothing, so every one is safe to retry; 429 means the endpoint wants a moment, not that the
// grant is gone.
const refused = (status: number): LimitResetClaim => ({
    result: status === 429 ? "unavailable" : "error",
    detail: `The provider answered ${status}.`,
});

const post = async (token: string, organization: string, fetchFn: typeof fetch): Promise<LimitResetClaim> => {
    const response = await fetchFn(`${ORGANIZATIONS_ENDPOINT}/${encodeURIComponent(organization)}/reset_rate_limits`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ program: PROGRAM }),
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
    return response.ok ? claimFrom(asRecord(await response.json())) : refused(response.status);
};

/* A RESET THE PROVIDER CONFIRMED REOPENS WHAT THE RECORDS STILL CALL SPENT. The refusal on file is what makes an account
   read spent (only a refusal proves a rounded Claude pool spent), and nothing but an answered turn settled it. A turn
   moved off the account before anything was sent never answers, so after a claimed reset every Continue was moved to
   another account while the one just reset sat idle, read spent until its old reopen (2026-11-12). A claim answered
   `reset`, or `not_limited` (the provider's word that the session window is open), drops the account's refusals of that
   window and files a fresh reading of it. A refusal naming a reopen past the session window is the weekly allowance,
   which the reset leaves as it was, so it stands. */

// The session window's whole length: a refusal naming a reopen further off than this is not the session window's.
const SESSION_WINDOW_S = 5 * 60 * 60;

/** What settling a claimed reset reaches beyond the claim's own seams: the refusal ledger. */
export interface ClaimDeps extends LimitResetDeps {
    readonly refusals: Pick<ProviderRefusalStore, "drop">;
}

// Whether a refusal on file is this account's session window, the one a reset reopens: its named reopen within the
// window's length from now, or none named at all.
const sessionRefusal =
    (id: string, nowS: number) =>
    (refusal: ProviderRefusal): boolean => {
        const reopensAt = refusal.resetsAt ?? refusal.poolResetsAt;
        return refusal.kind === "limit" && refusal.account === id && (reopensAt === undefined || reopensAt <= nowS + SESSION_WINDOW_S);
    };

/**
 * Claims the reset, and where the provider says the session window is open after it, takes back what the records
 * still say against it. Best-effort past the claim: the window is open whatever the ledger does, so a settle that fails
 * costs only the next turn a move, never the claim's answer.
 */
export const claimAndSettle = async (deps: ClaimDeps, id: string, fetchFn: typeof fetch = fetch, now: number = Date.now()): Promise<LimitResetClaim> => {
    const claim = await claimLimitReset(deps.store, id, fetchFn);
    if (claim.result !== "reset" && claim.result !== "not_limited") {
        return claim;
    }
    // allow(silent-catch): a refusal left standing is answered by the next turn on the account, as before this settle.
    await deps.refusals.drop("claude", sessionRefusal(id, Math.floor(now / 1000))).catch(() => false);
    // The reading that says so: filed by the probe itself (fileUsage), its answer about the next reset not needed here.
    await readLimitReset(deps, id, fetchFn);
    return claim;
};

export const claimLimitReset = async (store: ClaudeStore, id: string, fetchFn: typeof fetch = fetch): Promise<LimitResetClaim> => {
    const token = await ensureFreshToken(store, id).catch(() => undefined);
    if (token === undefined) {
        return { result: "error", detail: "That account's credential could not be renewed. Reconnect it and try again." };
    }
    try {
        const organization = await organizationUuid(token, fetchFn);
        return organization === undefined
            ? { result: "error", detail: "The provider did not say which organisation this account belongs to." }
            : await post(token, organization, fetchFn);
    } catch {
        return { result: "error", detail: "The provider could not be reached." };
    }
};
