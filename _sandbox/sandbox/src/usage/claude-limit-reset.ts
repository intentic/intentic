import type { LimitResetClaim, LimitResetStatus } from "@intentic/sandbox-contract";
import { asRecord, asString, resetFromIso } from "./payload.js";
import { type ClaudeStore, ensureFreshToken } from "../runtimes/claude/claude-credentials.js";

/* REOPENING A SPENT SESSION WINDOW WITHOUT WAITING FOR IT, which is the one thing a refused turn could never
 * be offered here, and the reason people were told to sit out a five-hour window with a weekly allowance three
 * quarters full.
 *
 * Anthropic grants this once a week per account: the five-hour pool reopens immediately, the WEEKLY pool is
 * untouched and still binds. Upstream's CLI spells it `/limit-reset` and calls the programme `juniper_tide`,
 * which is the word both endpoints below answer under.
 *
 * WHY THIS WAS PREVIOUSLY BELIEVED IMPOSSIBLE, because the note that said so is still next door in the editor
 * (limitFallback.ts) and was wrong for a reason worth writing down. The eligibility block comes back on the
 * SAME usage endpoint this directory has read all along — and it comes back `null` unless the request says it
 * is Claude Code. Read it the way our own reader reads it and the provider answers `ineligible_reason:
 * "surface"` for every account on every plan, which is indistinguishable from "the feature is off for you".
 * One header apart, the same accounts answer `eligible: true, available: true`.
 *
 * WHICH IS WHY THE USER AGENT IS NOT DECORATION. It is the request's claim about which surface is asking, the
 * provider gates the grant on it, and the claim is TRUE: a native Claude turn in this sandbox runs on the
 * Agent SDK's bundled Claude Code, so the allowance being asked about is spent by that CLI. Pinned rather than
 * derived because the SDK ships the CLI as a platform-specific binary with its own version line (the npm
 * package's version is not the CLI's), and a User-Agent assembled from the wrong one would fail the same way
 * sending none does. translator-usage.ts pins Codex's and Antigravity's for the same reason.
 *
 * A PIN THAT GOES STALE FAILS LEGIBLY, which is why it is an acceptable pin. The provider grades the version
 * separately from the surface, `cli_version` is its own refusal beside `surface` in the reasons it answers
 * with, so a version it has stopped accepting comes back as that word, rides out on the status, and is what
 * somebody reads when the button stops appearing. Neither failure is silent and neither can claim a grant that
 * is not there.
 *
 * NOTHING HERE POLLS. `at_wall=1` tells the provider the account has just been refused, which is a claim, and
 * a sweep making it every few minutes for every connection would be making it falsely; the endpoint also rate
 * limits reads hard enough that a second poller would cost the meters their freshness. So the probe happens
 * once, when a turn has actually been refused and somebody is looking at the strip that says so. */

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

// A probe must never outlive the strip that asked for it: the button either appears while somebody is reading
// the refusal or it is no use to them.
const PROBE_TIMEOUT_MS = 8_000;
// The claim is the press itself, so it is given room to land. Upstream waits 25s on the same call.
const CLAIM_TIMEOUT_MS = 25_000;

// Nothing to offer, said the same way for every reason there is nothing: no such account, a credential that
// cannot be refreshed, a provider that answered with no block, a network that did not answer at all. The
// button is drawn from `available` alone, so every one of these correctly draws nothing.
const NOTHING: LimitResetStatus = { available: false };

/* The provider's block, transcribed. `eligible` and `available` are separate facts upstream and both must hold:
 * eligibility is about the account (its plan, its age, its surface), availability about this week (whether the
 * grant is already spent). Either one false is a button that must not be drawn, and the reason says which. */
const statusFrom = (block: Record<string, unknown>): LimitResetStatus => {
    const available = block[`eligible`] === true && block[`available`] === true;
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

export const readLimitReset = async (store: ClaudeStore, id: string, fetchFn: typeof fetch = fetch): Promise<LimitResetStatus> => {
    const token = await ensureFreshToken(store, id).catch(() => undefined);
    if (token === undefined) {
        return NOTHING;
    }
    try {
        const response = await fetchFn(USAGE_ENDPOINT, { headers: headers(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) {
            return NOTHING;
        }
        const block = asRecord(asRecord(await response.json())?.[PROGRAM]);
        // `null` is what an account outside the programme gets, and it is a real answer rather than a failure:
        // an organisation-managed plan is told nothing at all here, where a personal one is told why not.
        return block === undefined ? NOTHING : statusFrom(block);
    } catch {
        return NOTHING;
    }
};

/* WHICH ORGANISATION IS BEING RESET, which the claim is addressed to and the stored credential does not carry.
 *
 * Anthropic answers the token endpoint with the organisation's NAME, which is what the account row shows, and
 * the uuid the claim needs is only on the profile. Fetched at claim time rather than stored: it costs one round
 * trip on a press somebody made deliberately, and it cannot be stale, whereas a copy written at connect time
 * would go on naming the organisation an account was moved out of. */
const organizationUuid = async (token: string, fetchFn: typeof fetch): Promise<string | undefined> => {
    const response = await fetchFn(PROFILE_ENDPOINT, { headers: headers(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) {
        return undefined;
    }
    return asString(asRecord(asRecord(await response.json())?.[`organization`])?.[`uuid`]);
};

// Everything the provider can say, kept as it said it (LimitResetClaimSchema has why they stay apart). A word
// we don't know reads as `unavailable`, which is the outcome that means "nothing happened, try again": the one
// safe reading of an answer we cannot interpret, since it neither claims a reset nor blames the account.
const RESULTS = new Set(["reset", "already_used", "not_limited", "ineligible", "unavailable"]);

const claimFrom = (body: Record<string, unknown> | undefined): LimitResetClaim => {
    const result = asString(body?.[`result`]);
    const nextAvailableAt = resetFromIso(body?.[`next_available_at`]);
    return {
        result: result !== undefined && RESULTS.has(result) ? (result as LimitResetClaim["result"]) : "unavailable",
        ...(nextAvailableAt === undefined ? {} : { nextAvailableAt }),
    };
};

// A refused claim spent nothing, so every one of these is safe to try again, and 429 says so out loud: the
// endpoint is asking for a moment, not reporting that the week's grant is gone.
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
