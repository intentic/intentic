import { SingleFlight } from "@intentic/base/async";
import { CLAUDE_SEED_MODELS } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Logger } from "pino";
import { z } from "zod";
import { isOrgDisabledText } from "../../../engines/failure-sentences.js";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { ProviderRefusalStore } from "../../../usage/provider-refusals.js";
import { CLAUDE_CLI_USER_AGENT, type ClaudeStore, ensureFreshToken } from "./claude-credentials.js";
import type { ClaudeSeatStore } from "./claude-seats.js";

// Recheck seat marks with a minimal Messages request on the smallest seed model (one token); usage/profile reads do not test entitlement.
// Trigger on planning a conversation that remembers the account, listing accounts, or a person's pick/re-measure; never on a timer.
// A usage read refused in the organisation's words is only a hint (`hinted`), but it probes an account not marked yet too.
// Ration automatic probes from FIRST_RECHECK_MS with exponential backoff to LONGEST_RECHECK_MS; explicit picks probe immediately.
// Share in-flight probes; an answer clears the mark so blocked accounts can recover, and a refusal files one in the ledger.

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
        const token = await ensureFreshToken(store, id).catch((error) => {
            store.logger.warn({ err: error, account: id }, "claude seat probe: the sign-in could not be refreshed, the next recheck tries again");
            return undefined;
        });
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
            // The API's own words count: the CLI's sentence for this refusal is never in an API body.
            return isOrgDisabledText(body) ? { kind: "refused", reason: refusalSentence(response.status, body) } : { kind: "unknown", why: refusalSentence(response.status, body) };
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
     *
     * `hinted`: something other than a turn says the seat may be off (the account's usage read refused in its
     * organisation's words, claude-usage.ts). An account carrying no mark is then probed too, on a schedule of its own,
     * and a refusal files the mark; false only where the probe found the seat refused. A marked one keeps its schedule.
     */
    readonly recheck: (id: string, options?: { readonly force?: boolean; readonly hinted?: boolean }) => Promise<boolean>;
}

export interface ClaudeSeatCheckDeps {
    readonly seats: ClaudeSeatStore;
    // Read per call: the refusal store is composed in another slice, after this one.
    readonly refusals: () => ProviderRefusalStore;
    readonly probe: (id: string) => Promise<SeatProbe>;
    readonly logger: Pick<Logger, "info" | "debug" | "warn">;
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
            return "an answer";
    }
};

interface Planned {
    readonly due: number;
    readonly gap: number;
}

// The next probe of a schedule after one at `at`: the gap doubled, up to LONGEST_RECHECK_MS; FIRST_RECHECK_MS for the first.
const after = (at: number, plan: Planned | undefined): Planned => {
    const gap = plan === undefined ? FIRST_RECHECK_MS : Math.min(plan.gap * 2, LONGEST_RECHECK_MS);
    return { due: at + gap, gap };
};

// A seat refusal on file for the account: one naming it, or one naming no account, which covers every account.
const entitlement =
    (id: string) =>
    (refusal: ProviderRefusal): boolean =>
        refusal.kind === "entitlement" && (refusal.account ?? id) === id;

// Clears what a turn answering on the account clears (providerAnswered), but only a refusal of the seat's kind: a
// one-token answer on the smallest model says nothing about a spent pool.
const restore = async (deps: ClaudeSeatCheckDeps, id: string): Promise<void> => {
    await Promise.all([deps.seats.clear(id), deps.refusals().drop("claude", entitlement(id))]);
};

// A refusal the probe saw, filed as a turn's would be, so every verdict blocks the account (serviceState) and the ledger
// believes it for another day while it keeps being refused. Named for no model: the seat is off for every one.
const refuse = (deps: ClaudeSeatCheckDeps, at: number, id: string, reason: string): Promise<void> =>
    deps
        .refusals()
        .record("claude", { at, kind: "entitlement", message: reason, account: id })
        .catch((error) => deps.logger.warn({ err: error, account: id }, "claude account: the probe's refusal could not be filed"));

// One probe, with what it learned filed. An answer whose marks could not be lifted reads as nothing learned, so the
// schedule tries again.
const ask = async (deps: ClaudeSeatCheckDeps, now: () => number, id: string): Promise<SeatProbe> => {
    const seen = await deps.probe(id).catch((): SeatProbe => ({ kind: "unknown", why: "the probe failed" }));
    if (seen.kind === "entitled") {
        return (await restore(deps, id).then(() => true, () => false)) ? seen : { kind: "unknown", why: "an answer, but the mark could not be lifted" };
    }
    if (seen.kind === "refused") {
        await refuse(deps, now(), id, seen.reason);
    }
    return seen;
};

export const createClaudeSeatCheck = (deps: ClaudeSeatCheckDeps): ClaudeSeatCheck => {
    const now = deps.now ?? Date.now;
    // In memory: a restart may probe once early, which costs one token, and no store has to hold a schedule.
    const planned = new Map<string, Planned>();
    // The same for an account no mark is on yet, probed on a hint (`hinted`): at once the first time, then backing off
    // while the hints keep coming. The usage read refused d8561075… in its organisation's words at 2026-10-27 19:54 and
    // turns served on it from 21:17, so a hint answered with access is a false alarm that may well recur.
    const hinted = new Map<string, Planned>();
    const asking = new SingleFlight<string, boolean>();

    // When the account was first refused: its seat mark, or an entitlement refusal that covers it (serviceState blocks
    // on either one).
    const markedAt = async (id: string): Promise<number | undefined> => {
        const [seats, refusals] = await Promise.all([deps.seats.read(), deps.refusals().onFile()]);
        const standing = (refusals["claude"] ?? []).filter(entitlement(id)).map((refusal) => refusal.at);
        return seats[id]?.at ?? (standing.length === 0 ? undefined : Math.min(...standing));
    };

    const attempt = async (id: string, plan: Planned): Promise<boolean> => {
        const seen = await ask(deps, now, id);
        if (seen.kind === "entitled") {
            planned.delete(id);
            deps.logger.info({ account: id }, "claude account: access is back, the seat mark is lifted");
            return true;
        }
        const next = after(now(), plan);
        planned.set(id, next);
        deps.logger.debug({ account: id, seen: seenAs(seen), nextInMs: next.gap }, "claude account: the seat is still off");
        return false;
    };

    // An unmarked account a hint names, probed when its own schedule says so. A refusal files the mark, and from then
    // on the marks' schedule re-tests it.
    const onHint = (id: string): Promise<boolean> => {
        const last = hinted.get(id);
        const pending = asking.joined(id);
        if (pending !== undefined || (last !== undefined && now() < last.due)) {
            return pending ?? Promise.resolve(true);
        }
        hinted.set(id, after(now(), last));
        return asking.run(id, async () => {
            const seen = await ask(deps, now, id);
            const refused = seen.kind === "refused";
            if (refused) {
                deps.logger.info({ account: id, seen: seenAs(seen) }, "claude account: a probe found its organisation switched Claude Code off, taking it out of the rotation");
            } else {
                deps.logger.debug({ account: id, seen: seenAs(seen), nextInMs: hinted.get(id)?.gap }, "claude account: probed on a hint that the seat is off, and not refused");
            }
            return !refused;
        });
    };

    return {
        recheck: async (id, options = {}) => {
            // Unreadable marks: nothing to go on, so the turn is routed as the marks last said (blocked-account.ts).
            const since = await markedAt(id).catch((error) => {
                deps.logger.warn({ err: error, account: id }, "claude account: the seat marks could not be read, routing as they last said");
                return null;
            });
            if (since === null) {
                return false;
            }
            if (since === undefined) {
                planned.delete(id);
                return options.hinted === true ? onHint(id) : true;
            }
            // Read after the await, so two callers arriving together share one probe.
            const pending = asking.joined(id);
            if (pending !== undefined) {
                return pending;
            }
            const plan = planned.get(id) ?? { due: since + FIRST_RECHECK_MS, gap: FIRST_RECHECK_MS };
            if (options.force !== true && now() < plan.due) {
                return false;
            }
            return asking.run(id, () => attempt(id, plan));
        },
    };
};
