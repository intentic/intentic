import type { LimitResetClaim, LimitResetStatus } from "@intentic/sandbox-contract";
import { asRecord, asString, resetFromIso } from "./payload.js";
import { type ClaudeStore, ensureFreshToken } from "../runtimes/claude/claude-credentials.js";

/* Anthropic's once-a-week session reset. It reopens the five-hour pool and leaves weekly usage unchanged.
 * The endpoints and program name match Claude Code's /limit-reset implementation.
 *
 * Eligibility is not enrollment. On 2026-09-08 the affected account returned eligible=true, available=true,
 * in_experiment=false and arm=null, then refused the claim with result=ineligible. Claude Code 2.1.263 gates
 * its offer on arm="reset" as well as availability. Without that check we offered a reset the account could
 * not claim. Control and unenrolled accounts must not see the offer, even when their general eligibility
 * passes. The provider may change its rollout independently of these client checks; a refused claim still
 * has to say what happened without guessing that the user's plan is wrong.
 *
 * The User-Agent identifies the Claude Code surface used by our Agent SDK turns. Without it the provider
 * answers ineligible_reason="surface". Its version is pinned because the SDK package and bundled CLI use
 * different versions; an unsupported version is reported as ineligible_reason="cli_version".
 *
 * Probe only when a refused turn is on screen: at_wall=1 asserts that fact, and the endpoint rate limits
 * reads. A transient failure must remain unanswered so the next strip can retry, never cached as no grant.
 */

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const ORGANIZATIONS_ENDPOINT = "https://api.anthropic.com/api/organizations";
const PROGRAM = "juniper_tide";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.257 (external, cli)";

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

export const readLimitReset = async (store: ClaudeStore, id: string, fetchFn: typeof fetch = fetch): Promise<LimitResetStatus | undefined> => {
    const token = await ensureFreshToken(store, id).catch(() => undefined);
    if (token === undefined) {
        return NOTHING;
    }
    try {
        const response = await fetchFn(USAGE_ENDPOINT, { headers: headers(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) {
            return response.status === 401 || response.status === 403 ? NOTHING : undefined;
        }
        const body = asRecord(await response.json());
        if (body === undefined || !(PROGRAM in body)) {
            return undefined;
        }
        const block = asRecord(body[PROGRAM]);
        // `null` is what an account outside the programme gets, and it is a real answer rather than a failure:
        // an organisation-managed plan is told nothing at all here, where a personal one is told why not.
        return body[PROGRAM] === null ? NOTHING : block === undefined || typeof block[`eligible`] !== "boolean" ? undefined : statusFrom(block);
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
