import { CLAUDE_SEED_MODELS } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { isEntitlementRefusalText } from "../../agent/providers/failure-sentences.js";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";
import { CLAUDE_CLI_USER_AGENT, type ClaudeStore, ensureFreshToken } from "./claude-credentials.js";
import type { ClaudeSeatStore } from "./claude-seats.js";

// The way back for a seat mark (claude-seats.ts). A turn answering on the account clears the mark (providerAnswered),
// but once an account is marked, turns that name no account are kept off it (blocked-account.ts), so no turn would ever
// run there again to clear it. An admin can turn access back on and a single-account user would still be held. So the
// mark is re-tested here, and a probe that gets an answer clears it.
//
// WHICH CALL: the refusal belongs to the Messages API. It is the API's own sentence, and the CLI passes it through
// (failure-sentences.ts, NOT_ENTITLED_PHRASES). The OAuth usage and profile reads that headroom and the limit-reset
// probe make are answered for a refused seat as for any other, which is why the mark exists at all, so they show
// nothing about it. The cheapest call that meets the same gate a turn does is the smallest legal Messages request:
// Claude Code's own identity line, one word in, one token out, on the smallest seed model. It costs one token of the
// account's own allowance per probe, and the schedule below keeps probes rare.
//
// WHEN: on three occasions, never on a timer. (1) A turn whose conversation remembers the account is being planned,
// and would be moved or held for the mark. (2) The account list is read. (3) A person picks the account in the composer
// (switch-account.ts). The first two are rationed per account: the first probe comes FIRST_RECHECK_MS after the mark,
// and each probe that finds no answer doubles the wait, up to LONGEST_RECHECK_MS. A person's pick, or a person pressing
// re-measure on the list, asks at once. A probe already on its way is shared, never repeated.

/** What one probe learned: served, refused for the seat again, or nothing either way (offline, spent, a new wording). */
export type SeatProbe =
    | { readonly kind: "entitled" }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "unknown"; readonly why: string };

const MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
// The seed floor runs strongest first, so its last row is the cheapest model every subscription serves.
const PROBE_MODEL = CLAUDE_SEED_MODELS.at(-1)?.id;
// A subscription token is answered only for Claude Code's own requests, recognised by this opening line.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROBE_TIMEOUT_MS = 10_000;

// The provider's own sentence from a refused request's body (`error.message`, first line), or its status when it has none.
// Read here rather than through usage/payload.ts, which reaches back into this runtime.
const ErrorBodySchema = z.object({ error: z.object({ message: z.string() }) });
const refusalSentence = (status: number, body: string): string => {
    let line: string | undefined;
    try {
        line = ErrorBodySchema.safeParse(JSON.parse(body)).data?.error.message.split("\n")[0]?.trim();
    } catch {
        // allow(silent-catch): a body that is not JSON has no sentence to lift, and the status still says what failed.
        line = undefined;
    }
    return line === undefined || line === "" ? `HTTP ${String(status)}` : line;
};

// All of fetch the probe uses, so a test hands it a plain function.
export type SeatProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One real request on the account's own token, read for the seat refusal a turn gets. Never throws. */
export const claudeSeatProbe =
    (store: ClaudeStore, fetchFn: SeatProbeFetch = fetch) =>
    async (id: string): Promise<SeatProbe> => {
        const token = await ensureFreshToken(store, id).catch(() => undefined);
        if (token === undefined || PROBE_MODEL === undefined) {
            return { kind: "unknown", why: token === undefined ? "the sign-in could not be refreshed" : "no model to ask" };
        }
        try {
            const response = await fetchFn(MESSAGES_ENDPOINT, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "oauth-2025-04-20",
                    "Content-Type": "application/json",
                    "User-Agent": CLAUDE_CLI_USER_AGENT,
                },
                body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, system: CLAUDE_CODE_IDENTITY, messages: [{ role: "user", content: "ping" }] }),
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            if (response.ok) {
                return { kind: "entitled" };
            }
            const body = await response.text();
            // Read on the raw body: the phrase is the test (failure-sentences.ts), and the sentence alone may be cut short.
            return isEntitlementRefusalText(body) ? { kind: "refused", reason: refusalSentence(response.status, body) } : { kind: "unknown", why: refusalSentence(response.status, body) };
        } catch (error) {
            return { kind: "unknown", why: error instanceof Error && error.name === "TimeoutError" ? "the provider did not answer in time" : "the request failed" };
        }
    };

export const FIRST_RECHECK_MS = 5 * 60_000;
export const LONGEST_RECHECK_MS = 30 * 60_000;

export interface ClaudeSeatCheck {
    /**
     * Whether the account can serve again: true when it carries no seat mark or entitlement refusal, or when a probe
     * got an answer and cleared both. False while the probe is not due (unless `force`), or it saw the refusal again,
     * or it learned nothing, or the marks could not be read or written. Never throws.
     */
    readonly recheck: (id: string, options?: { readonly force?: boolean }) => Promise<boolean>;
}

export interface ClaudeSeatCheckDeps {
    readonly seats: ClaudeSeatStore;
    // Read per call: the refusal store is composed in another slice, after this one.
    readonly refusals: () => ProviderRefusalStore;
    readonly probe: (id: string) => Promise<SeatProbe>;
    readonly logger: Pick<Logger, "info" | "debug">;
    readonly now?: () => number;
}

// What a probe that did not lift the mark saw, for the log line.
const seenAs = (seen: SeatProbe): string => {
    switch (seen.kind) {
        case "refused":
            return seen.reason;
        case "unknown":
            return seen.why;
        case "entitled":
            return "an answer, but the mark could not be lifted";
    }
};

interface Planned {
    readonly due: number;
    readonly gap: number;
}

export const createClaudeSeatCheck = (deps: ClaudeSeatCheckDeps): ClaudeSeatCheck => {
    const now = deps.now ?? Date.now;
    // In memory: a restart may probe once early, which costs one token, and no store has to hold a schedule.
    const planned = new Map<string, Planned>();
    const asking = new Map<string, Promise<boolean>>();

    // When the account was first refused: its seat mark, or an entitlement refusal that covers it (a refusal naming no
    // account covers every account, and serviceState blocks on either one).
    const markedAt = async (id: string): Promise<number | undefined> => {
        const [seats, refusals] = await Promise.all([deps.seats.read(), deps.refusals().read()]);
        const refusal = refusals["claude"];
        const standing = refusal?.kind === "entitlement" && (refusal.account === undefined || refusal.account === id) ? refusal.at : undefined;
        return seats[id]?.at ?? standing;
    };

    // Clears what a turn answering on the account clears (providerAnswered), but only a refusal of the seat's kind: a
    // one-token answer on the smallest model says nothing about a spent pool.
    const restore = async (id: string): Promise<void> => {
        const refusal = (await deps.refusals().read())["claude"];
        await Promise.all([
            deps.seats.clear(id),
            refusal?.kind === "entitlement" && (refusal.account === undefined || refusal.account === id) ? deps.refusals().clear("claude", id) : undefined,
        ]);
    };

    const attempt = async (id: string, plan: Planned): Promise<boolean> => {
        const seen = await deps.probe(id).catch((): SeatProbe => ({ kind: "unknown", why: "the probe failed" }));
        // A mark that could not be lifted is tried again on the schedule, as if nothing were learned.
        if (seen.kind === "entitled" && (await restore(id).then(() => true, () => false))) {
            planned.delete(id);
            deps.logger.info({ account: id }, "claude account: access is back, the seat mark is lifted");
            return true;
        }
        const gap = Math.min(plan.gap * 2, LONGEST_RECHECK_MS);
        planned.set(id, { due: now() + gap, gap });
        deps.logger.debug({ account: id, seen: seenAs(seen), nextInMs: gap }, "claude account: the seat is still off");
        return false;
    };

    return {
        recheck: async (id, options = {}) => {
            // Unreadable marks: nothing to go on, so the turn is routed as the marks last said (blocked-account.ts).
            const since = await markedAt(id).catch(() => null);
            if (since === null) {
                return false;
            }
            if (since === undefined) {
                planned.delete(id);
                return true;
            }
            // Read after the await, so two callers arriving together share one probe.
            const pending = asking.get(id);
            if (pending !== undefined) {
                return pending;
            }
            const plan = planned.get(id) ?? { due: since + FIRST_RECHECK_MS, gap: FIRST_RECHECK_MS };
            if (options.force !== true && now() < plan.due) {
                return false;
            }
            const run = attempt(id, plan).finally(() => asking.delete(id));
            asking.set(id, run);
            return run;
        },
    };
};
