import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { breakArmed, RETRY_LADDER_TRIES, type TurnBreak, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import type { TodoItem } from "@intentic/sandbox-contract/events/requests";
import type { LimitWay, limitWayOf } from "../../models/limit-way.js";
import { isAdminGrantedAllowanceText, mentionsSpentAllowance } from "../../../engines/failure-sentences.js";
import { latestOf, namedPeriod, namedReset } from "../../../usage/reset-sentences.js";
import { OUTAGE_MAX_ATTEMPTS, type OutageState } from "../../providers/provider-health.js";
import type { VerificationStanding } from "../../verification/agent-verification.js";
import type { RefreshOptions } from "../../../usage/headroom.js";
import type { StoredCooldown } from "../../../usage/model-cooldowns.js";
import type { StoredModelRefusal } from "../../../usage/model-refusals.js";
import { ACCOUNT_WIDE, type ObservedLimit } from "../../../usage/observed-limits.js";
import { opt } from "../../../opt.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import type { HeldReason, HeldTurn } from "../turn/turn-resume.js";
import type { Attribution } from "./frame-decorators.js";

// One failure frame, classified read-only: the frame the window reads, the records to file, its log line and its hold.

export type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// How much of a failure's sentence the ledger and the log keep: enough for any refusal, short enough to stay readable.
export const ERROR_MESSAGE_CHARS = 400;

// Codes with a durable trace elsewhere; logging them at `error` would drown the unclassified failures.
const HANDLED_FAILURE_CODES: ReadonlySet<string> = new Set([
    "rate_limit",
    "provider-outage",
    "claude-token-refused",
    "claude-not-entitled",
    // Filed against the account (observed-limits.json, account-wide), so placement and the spawn gate skip it.
    "account-not-entitled",
    // Filed against the model (model-refusals.json); happens once, since the picker stops offering it after.
    "model-unavailable",
    // The provider's classifier, not this sandbox: held for a person with the vendor's own words.
    "safeguard-flagged",
]);

// Codes filed as a durable refusal against the provider, whose `kind` reads the sentence rather than the code.
const REFUSING_CODES: ReadonlySet<string> = new Set(["rate_limit", "claude-token-refused", "claude-not-entitled", "account-not-entitled"]);

// Codes that refuse the account itself rather than one model's allowance.
const ENTITLEMENT_CODES: ReadonlySet<string> = new Set(["claude-not-entitled", "account-not-entitled"]);

// Everything classifying one failure frame reads, as it stood when the frame arrived.
export interface FailureContext {
    readonly turn: RoutedTurn;
    readonly turnId: string;
    // The detached run carrying the turn, whose id the transcript's rows carry; absent for a turn with no run.
    readonly run?: string | undefined;
    readonly provider: AgentProvider;
    // The model the request resolved to, which is what a refusal is filed against.
    readonly model: string | undefined;
    // The account serving the turn; undefined for a routed turn, where the translator picks the credential itself.
    readonly account: string | undefined;
    readonly attribution: Attribution;
    readonly sessionId: string | undefined;
    // Whether the provider answered before this frame: `ran` on every hold this frame promises.
    readonly answered: boolean;
    // A spawned child's turn: how far off a reset it is still booked to re-run by itself (children.ts
    // childRerunHorizonMs), since nobody watches it; undefined for every other turn, which has no horizon.
    readonly childRerunHorizonMs?: number | undefined;
    // Whether this turn re-ran a held one, its session carried onto another account than the one it was held on.
    readonly carriedOff?: boolean | undefined;
    // Held at the door for a spent allowance (spent-door.ts): no request went out, so nothing is filed against the
    // provider (the records already say it, and a refusal filed now would only push its reopening out), and the
    // session is as the last turn left it.
    readonly door?: boolean | undefined;
    // The stored Claude credential a refusal of it would re-mint and re-run the turn on; undefined when none would be.
    readonly remint: HeldTurn["remint"];
    // The reset instant the stream last named, which outranks the frame's own and the account snapshot's.
    readonly limitReset: number | undefined;
    // The breaker's state after recording this outage; undefined unless the frame is one on a conversation.
    readonly outage: OutageState | undefined;
    readonly standing: VerificationStanding;
    readonly checklist: readonly TodoItem[] | undefined;
    readonly contextTokens: number | undefined;
    readonly now: number;
}

// The read-only questions a classification may ask, each only when the frame's code calls for it.
export interface FailureQueries {
    // This conversation's own answer for one ending, read the same way the resume pass will read it.
    readonly breakPolicy: (conversationId: string, ending: TurnBreak) => Promise<TurnBreakPolicy>;
    // When a spent allowance reopens by the account's snapshot or the translator's pool; `period` is the length of the
    // pool the vendor's sentence said ran out, whose own reset is then the answer.
    readonly reopensAt: (at: {
        readonly provider: AgentProvider;
        readonly model: string | undefined;
        readonly account: string | undefined;
        readonly period?: number;
    }) => Promise<number | undefined>;
    readonly limitWay: (params: Parameters<typeof limitWayOf>[1]) => Promise<LimitWay | undefined>;
    // How many rungs the stop ladder has spent, and when its next would fire (undefined once it is spent).
    readonly stopLadder: (conversationId: string) => { readonly made: number; readonly nextAt: number | undefined };
    // The sign-ins of a routed provider's accounts benched until their owner verifies them on the provider's page.
    readonly awaitingVerification: (provider: AgentProvider) => Promise<readonly string[]>;
}

// A record a classification files; the turn performs each fire-and-forget, with its own named failure line.
export type FailureWrite =
    | { readonly kind: "provider-refusal"; readonly provider: string; readonly refusal: ProviderRefusal }
    // Re-measures what just refused while it is the freshest signal; unwatched, so a plan at its wall cannot spend the
    // read budget its own number depends on.
    | { readonly kind: "headroom-refresh"; readonly options: RefreshOptions }
    // A plan with nothing to poll leaves its own refusal as the reading, scoped to the account and model that refused.
    | {
          readonly kind: "observed-limit";
          readonly provider: AgentProvider;
          readonly account: string;
          readonly model: string;
          readonly limit: ObservedLimit;
      }
    // The plan does not cover this model: filed against the model, since the subscription serves its others fine.
    | { readonly kind: "model-refusal"; readonly provider: string; readonly model: string; readonly refusal: StoredModelRefusal }
    // The seat, not the credential: it signs in fine, but the org switched Claude Code off.
    | { readonly kind: "seat-refusal"; readonly account: string; readonly reason: string }
    // A routed provider benches the model to the resolved reset, since the translator picks and benches per model.
    | { readonly kind: "model-cooldown"; readonly provider: AgentProvider; readonly model: string; readonly cooldown: StoredCooldown };

export interface FailurePlan {
    readonly frame: ErrorFrame;
    readonly writes: readonly FailureWrite[];
    // An unclassified failure logs at `error`; an already-filed refusal at `warn`.
    readonly log: { readonly level: "error" | "warn"; readonly message: "turn failed" | "turn refused"; readonly fields: Record<string, unknown> };
    // What the turn is held as for a press or the resume pass; the frame promises exactly this hold.
    readonly held: HeldTurn | undefined;
}

// A named model, or undefined for none and for the wire's `""`, the catalog default.
const named = (model: string | undefined): string | undefined => (model === undefined || model === "" ? undefined : model);

// `kind` reads the sentence, not the code, which can disagree.
const refusalKind = (event: ErrorFrame): ProviderRefusal["kind"] => {
    if (event.code !== undefined && ENTITLEMENT_CODES.has(event.code)) {
        return "entitlement";
    }
    return event.code === "rate_limit" || mentionsSpentAllowance(event.message) ? "limit" : "auth";
};

/* A TRANSLATOR-ROUTED TURN NAMES NO ACCOUNT. The translator picks the credential, so whatever rides as the turn's account
   is a label (Codex's "codex-subscription"), the key of no reading. Filed under it, a refusal was read as one for an
   account since disconnected ("gone", refusalVerdict) and the listing a parent read next ignored it, and the re-read it
   owes was scoped to that label and read nothing (2026-10-13). Filed under no account, it stands over the provider's
   accounts until a reading after it shows room, and its re-read covers them all. */
const refusingAccount = (provider: AgentProvider, account: string | undefined): string | undefined =>
    KeyedProviderSchema.safeParse(provider).success ? undefined : account;

// A plan with nothing to poll keeps its refusals as the reading: a spent allowance against the model that spent it, an
// account refused outright against every model (ACCOUNT_WIDE), so the next placement and the spawn gate skip it rather
// than read it as untouched room (2026-10-17: a Cursor account refusing `[role_forbidden]` took two children in a row).
const observedWrites = (
    event: ErrorFrame,
    at: { readonly provider: AgentProvider; readonly account: string; readonly model: string | undefined; readonly now: number },
): FailureWrite[] => {
    const { provider, account, model, now } = at;
    if (event.code === "account-not-entitled") {
        return [{ kind: "observed-limit", provider, account, model: ACCOUNT_WIDE, limit: { at: now, message: event.message, refused: "entitlement" } }];
    }
    return event.code === "rate_limit" && model !== undefined ? [{ kind: "observed-limit", provider, account, model, limit: { at: now, message: event.message } }] : [];
};

/* The instant a spent allowance's refusal stands until, against every reading: the provider's own. Where its words
   decided the booking (an instant, or a pool it named by length, whose reset the reading holds), the same instant, so the
   listing and the spawn gate do not call a model ready before the turn they held would be. A loop's own instant
   (OpenCode's retry, capped at fifteen minutes) is filed only where nothing better is known: filed instead of the named
   pool's reset, a Kimi five-hour window two hours from reopening read as ready in fifteen minutes. A snapshot's guess is
   never filed: a reading with room after the refusal answers it, as it always has. */
const refusalReset = (event: ErrorFrame, context: FailureContext, reopening: Reopening | undefined): number | undefined => {
    if (reopening !== undefined) {
        return reopening.said ? reopening.at : event.resetsAt;
    }
    return context.limitReset ?? latestOf(namedReset(event.message, context.now), event.resetsAt);
};

// The durable refusal a refusing code files, the re-measure it owes, and for a plan with nothing to poll, the reading.
const refusalWrites = (event: ErrorFrame, context: FailureContext, reopening: Reopening | undefined): FailureWrite[] => {
    if (event.code === undefined || !REFUSING_CODES.has(event.code) || context.door === true) {
        return [];
    }
    const { provider, now } = context;
    const account = refusingAccount(provider, context.account);
    const { account: _label, ...actor } = context.attribution;
    const model = named(context.model);
    // Routed turns have no account to name; the model, so the refusal reads the pool it spends.
    const kind = refusalKind(event);
    // A spent allowance keeps the provider's own "try again at", so the listing a parent reads next shows it spent
    // until then rather than whatever the forced re-read below reports.
    const refusal: ProviderRefusal = {
        at: now,
        kind,
        message: event.message,
        ...actor,
        ...opt("account", refusingAccount(provider, context.attribution.account)),
        ...opt("model", model),
        ...opt("resetsAt", kind === "limit" ? refusalReset(event, context, reopening) : undefined),
        // A team's credit no usage endpoint reads: the refusal stands against every reading (ProviderRefusal.unmetered).
        ...opt("unmetered", kind === "limit" && isAdminGrantedAllowanceText(event.message) ? true : undefined),
    };
    const observed: FailureWrite[] =
        account === undefined || reportsPlanLimits(provider) ? [] : observedWrites(event, { provider, account, model, now });
    return [
        { kind: "provider-refusal", provider, refusal },
        { kind: "headroom-refresh", options: { scope: { providers: [provider], ...opt("account", account) }, maxAgeMs: 0 } },
        ...observed,
    ];
};

// The records a frame files by its code alone, before anything is asked.
const filedWrites = (event: ErrorFrame, context: FailureContext, reopening: Reopening | undefined): FailureWrite[] => {
    const model = named(context.model);
    const modelRefusal: FailureWrite[] =
        event.code === "model-unavailable" && model !== undefined
            ? [{ kind: "model-refusal", provider: context.provider, model, refusal: { at: context.now, message: event.message } }]
            : [];
    const seatRefusal: FailureWrite[] =
        event.code === "claude-not-entitled" && context.account !== undefined
            ? [{ kind: "seat-refusal", account: context.account, reason: event.message }]
            : [];
    return [...refusalWrites(event, context, reopening), ...modelRefusal, ...seatRefusal];
};

const logOf = (event: ErrorFrame, context: FailureContext): FailurePlan["log"] => {
    const failed = event.code === undefined || !HANDLED_FAILURE_CODES.has(event.code);
    return {
        level: failed ? "error" : "warn",
        message: failed ? "turn failed" : "turn refused",
        fields: {
            turnId: context.turnId,
            ...opt("run", context.run),
            provider: context.provider,
            harness: context.turn.harness,
            ...opt("code", event.code),
            ...opt("model", context.model),
            ...context.attribution,
            ...opt("conversationId", context.turn.conversationId),
            ...opt("sessionId", context.sessionId),
            // `reason`, not `message`: the logger's own messageKey is `message` already.
            reason: event.message.slice(0, ERROR_MESSAGE_CHARS),
        },
    };
};

// The outage's own frame: when the breaker retries, which attempt this is, and whether a clock will re-run it unasked.
export const outageFrame = (event: ErrorFrame, armed: boolean, outage: OutageState): ErrorFrame => {
    const retryAt = Math.round(outage.retryAt / 1000);
    return {
        ...event,
        autoResume: armed ? "scheduled" : "available",
        ...(armed ? { nextAt: retryAt } : {}),
        outage: { retryAt },
        retries: { made: outage.attempt, max: OUTAGE_MAX_ATTEMPTS },
    };
};

// Who brings a held turn back: a booked move, the armed appointment, or an offer.
const autoResumeOf = (moving: boolean, schedulable: boolean, armed: boolean): ErrorFrame["autoResume"] => {
    if (moving) {
        return "scheduled";
    }
    if (!schedulable) {
        return undefined;
    }
    return armed ? "scheduled" : "available";
};

// The held turn as the frame states it: whether it ran, what each way on costs, where a policy is taking it.
const heldOf = (ran: boolean, way: LimitWay | undefined, moving: string | undefined): NonNullable<ErrorFrame["held"]> => ({
    ran,
    ...opt("contextTokens", way?.contextTokens),
    ...opt("handoffTokens", way?.handoffTokens),
    ...opt("moving", moving),
    ...opt("handoff", way?.handoff),
});

/* HOW FAR OFF A RESET A CHILD IS STILL WORTH HOLDING FOR. A child's parent waits on it, and was told "do not give the
   task to another agent meanwhile" for a quota that reopened next week (2026-10-17). Past its horizon, a child's spent
   turn is not booked to re-run by itself: it ends offering the reset, and its parent hears where else its work can go on.
   The horizon comes with the turn (childRerunHorizonMs in agent/subagents/child-records.ts): the owner's
   childRerunHorizonHours, six hours unless changed, so a five-hour window is waited out, or 90 minutes for a child with
   fallbacks, so it moves to them rather than waiting. */

// How far past the reset a child's re-run is booked: a margin for a reset that lands a little late, and a spread within it
// read off the conversation's id, so siblings refused together on one provider do not all go again in the same second.
const CHILD_RERUN_MARGIN_S = 15;
const CHILD_RERUN_SPREAD_S = 30;
export const childRerunAt = (resetsAt: number, conversationId: string): number => {
    let spread = 0;
    for (const char of conversationId) {
        spread = (spread * 31 + (char.codePointAt(0) ?? 0)) % (CHILD_RERUN_SPREAD_S + 1);
    }
    return resetsAt + CHILD_RERUN_MARGIN_S + spread;
};

// Dresses a spent-allowance frame with when it reopens, whether it is held, and whether a clock resumes it unasked;
// `autoResume` needs a held turn and a known instant. A booked move fires on the next pass, "now" to a reader, so it
// names no instant.
const limitFrame = async (
    queries: FailureQueries,
    event: ErrorFrame,
    limit: {
        readonly conversationId: string | undefined;
        readonly resetsAt: number | undefined;
        readonly held: boolean;
        readonly ran: boolean;
        readonly way: LimitWay | undefined;
        // A child whose reset is past its horizon: offered, never booked.
        readonly far: boolean;
    },
): Promise<ErrorFrame> => {
    const { conversationId, resetsAt, held, ran, way } = limit;
    const schedulable = held && resetsAt !== undefined && conversationId !== undefined && !limit.far;
    // `move` implies the appointment, so anything but `wait` keeps it.
    const armed = schedulable ? breakArmed(await queries.breakPolicy(conversationId, "limit")) : false;
    const moving = held ? way?.move?.account : undefined;
    return {
        ...event,
        ...(held ? { held: heldOf(ran, way, moving) } : {}),
        ...opt("resetsAt", resetsAt),
        ...opt("autoResume", autoResumeOf(moving !== undefined, schedulable, armed)),
        ...opt("nextAt", moving === undefined && armed ? resetsAt : undefined),
    };
};

// A turn that stopped short with nothing to repair: the press re-runs the held turn rather than appending a message the
// user never typed, and the frame says whether a rung is already booked. A spent ladder reports the offer instead.
const stoppedFrame = async (
    queries: FailureQueries,
    event: ErrorFrame,
    stopped: { readonly conversationId: string; readonly ran: boolean; readonly contextTokens: number | undefined },
): Promise<ErrorFrame> => {
    const armed = breakArmed(await queries.breakPolicy(stopped.conversationId, "stopped"));
    const ladder = queries.stopLadder(stopped.conversationId);
    const nextAt = armed ? ladder.nextAt : undefined;
    return {
        ...event,
        held: { ran: stopped.ran, ...opt("contextTokens", stopped.contextTokens) },
        autoResume: nextAt === undefined ? "available" : "scheduled",
        ...opt("nextAt", nextAt === undefined ? undefined : Math.round(nextAt / 1000)),
        // Stated while armed and once any rung has gone, so the reader always knows how far the ladder got.
        ...(armed || ladder.made > 0 ? { retries: { made: ladder.made, max: RETRY_LADDER_TRIES } } : {}),
    };
};

// The frame's dressing, the turn it holds, and any record only the dressing could decide.
type Dressed = Pick<FailurePlan, "frame" | "held"> & { readonly writes: readonly FailureWrite[] };

const bare = (frame: ErrorFrame): Dressed => ({ frame, held: undefined, writes: [] });

// The turn held on its conversation, as the frame found it; `rest` names what only its wall knows.
const holding = (context: FailureContext, conversationId: string, reason: HeldReason, rest: Partial<HeldTurn> = {}): HeldTurn => ({
    input: { ...context.turn, conversationId },
    reason,
    ...opt("sessionId", context.sessionId),
    ran: context.answered,
    ...rest,
});

// What the turn left behind, which a fresh session's hand-off is seeded from.
const leftBy = (context: FailureContext): Pick<LimitWay, "standing" | "checklist" | "contextTokens"> => ({
    standing: context.standing,
    ...opt("checklist", context.checklist),
    ...opt("contextTokens", context.contextTokens),
});

/* WHEN A SPENT ALLOWANCE REOPENS. The stream's own reset outranks everything (dressLimit). Then the vendor's sentence,
   when it names an instant ("Resets in 166h40m39s", "try again at 5:46 PM"): exact, and the only word a loop's own
   instant must not overrule. Otherwise the frame's instant is only a floor, since a loop hands a limit over at the
   moment IT would ask again (OpenCode's capped retry-after, the translator's bench), and the pool the sentence names
   ("your 5-hour usage limit") reopens when the account's reading says it does: the later of the two. A frame with no
   instant at all reads the snapshot, as before. Booked at the floor, a Gemini quota resetting in a week was re-run in
   fifteen minutes and a Kimi five-hour window with two hours left in thirty, each refused again (2026-10-17). */
// `said` is whether the provider's own words decided it (its stream's reset, an instant or a pool its sentence named),
// which is what the refusal it files may stand on (refusalWrites); a floor or a snapshot is only the booking's.
interface Reopening {
    readonly at: number | undefined;
    readonly said: boolean;
}

const reopeningOf = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<Reopening> => {
    if (context.limitReset !== undefined) {
        return { at: context.limitReset, said: true };
    }
    const said = namedReset(event.message, context.now);
    if (said !== undefined) {
        return { at: latestOf(said, event.resetsAt), said: true };
    }
    const period = namedPeriod(event.message);
    const floor = event.resetsAt;
    if (floor !== undefined && period === undefined) {
        return { at: floor, said: false };
    }
    const { provider, account } = context;
    const at = latestOf(floor, await queries.reopensAt({ provider, model: context.model, account, ...opt("period", period) }));
    return { at, said: period !== undefined };
};

// A spent allowance: when it reopens, whether it is held, the way on, and the model a routed provider benches.
const dressLimit = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries, reopening: Reopening): Promise<Dressed> => {
    const { turn, provider, account, answered } = context;
    const resetsAt = reopening.at;
    const model = named(context.model);
    const writes: FailureWrite[] =
        KeyedProviderSchema.safeParse(provider).success && model !== undefined && resetsAt !== undefined && context.door !== true
            ? [{ kind: "model-cooldown", provider, model, cooldown: { until: resetsAt * 1000, message: event.message } }]
            : [];
    const way = await queries.limitWay({
        turn,
        provider,
        model: context.model,
        account,
        ran: answered,
        standing: context.standing,
        checklist: context.checklist,
        contextTokens: context.contextTokens,
        sessionId: context.sessionId,
    });
    const { conversationId } = turn;
    // A door's hold names its run, whose rows the model never saw, and re-runs on the session as it stood (turn-resume.ts).
    const turnedAway: Partial<HeldTurn> = context.door === true ? { turnedAway: true, ...opt("run", context.run) } : {};
    const horizon = context.childRerunHorizonMs;
    const far = horizon !== undefined && resetsAt !== undefined && resetsAt * 1000 - context.now > horizon;
    // A far reset is said on the frame and kept off the hold: the resume pass fires a limit hold at its `reopensAt` under
    // a `resend` answer whatever the frame said, so a child told nothing was booked was re-run by itself a week later.
    const booked = far || resetsAt === undefined ? undefined : horizon !== undefined && conversationId !== undefined ? childRerunAt(resetsAt, conversationId) : resetsAt;
    const held = conversationId === undefined ? undefined : holding(context, conversationId, "limit", { ...opt("reopensAt", booked), ...way, ...turnedAway });
    // Worth dressing for a reset or a hold; with neither, it goes out bare.
    if (resetsAt === undefined && held === undefined) {
        return { frame: event, held, writes };
    }
    const frame = await limitFrame(queries, event, { conversationId, resetsAt, held: held !== undefined, ran: answered, way, far });
    return { frame, held, writes };
};

// What an overflow's frame adds to the provider's words: where the turn goes next, which the reader cannot see.
const FRESH_RERUN =
    "Resuming this session would only overflow again, so the turn is being sent again in a fresh session that carries the conversation so far and where the work stands.";
const TOO_LARGE =
    "A fresh session could not hold this turn either: the message, an attachment or a tool output it read is larger than the model's context window. Split the task into smaller steps, or read large files and command output in parts.";

// The provider's sentence, then the daemon's; one the provider left unpunctuated ("Prompt is too long") gets its stop.
const withClause = (message: string, clause: string): string => {
    const said = message.trimEnd();
    return `${said}${/[.!?]$/.test(said) ? "" : "."} ${clause}`;
};

// A first overflow is held for a fresh session at once, on no policy; the fresh re-run overflowing too says to split the task.
const dressOverflow = (event: ErrorFrame, context: FailureContext, conversationId: string): Dressed => {
    if (context.turn.resume === "overflow") {
        return bare({ ...event, message: withClause(event.message, TOO_LARGE) });
    }
    const frame: ErrorFrame = { ...event, message: withClause(event.message, FRESH_RERUN), held: { ran: context.answered }, autoResume: "scheduled" };
    return { frame, held: holding(context, conversationId, "overflow", leftBy(context)), writes: [] };
};

// The provider's safety classifier stopped the turn partway: held whole for a person, never re-run by a clock (the owner
// asked to choose each time), with the entry a press resumes the session at so the stopped response is not sent again.
const dressFlagged = (event: ErrorFrame, context: FailureContext, conversationId: string): Dressed => {
    const frame: ErrorFrame = { ...event, held: { ran: context.answered, ...opt("contextTokens", context.contextTokens) }, autoResume: "available" };
    const held = holding(context, conversationId, "flagged", { ...leftBy(context), ...opt("resumeAt", event.refusal?.resumeAt) });
    return { frame, held, writes: [] };
};

// Held whole for a press; a carry refused unanswered moves fresh at once; an unanswered `stopped` resume is not held again.
// A carry is a session moved onto another account (`carriedOff`), whatever way it continued: a trimmed hand-off re-sent
// on the account it was held on is no carry, and read as one it was booked as a move onto that same account, the card
// saying `moving` to where it already was and a move policy re-running it fresh at once (2026-10-10).
const dressDeath = async (event: ErrorFrame, context: FailureContext, conversationId: string, queries: FailureQueries): Promise<Dressed> => {
    const { turn, answered } = context;
    if (context.carriedOff === true && !answered && turn.account !== undefined) {
        const left = leftBy(context);
        const held = holding(context, conversationId, "limit", {
            ran: true,
            carryRefused: true,
            move: { account: turn.account, carry: false },
            ...left,
        });
        return { frame: { ...event, held: heldOf(true, left, turn.account), autoResume: "scheduled" }, held, writes: [] };
    }
    if (!answered && turn.resume === "stopped") {
        return bare(event);
    }
    const frame = await stoppedFrame(queries, event, { conversationId, ran: answered, contextTokens: context.contextTokens });
    return { frame, held: holding(context, conversationId, "stopped", leftBy(context)), writes: [] };
};

const dress = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries, reopening: Reopening | undefined): Promise<Dressed> => {
    const { conversationId } = context.turn;
    if (event.code === "rate_limit") {
        return dressLimit(event, context, queries, reopening ?? (await reopeningOf(event, context, queries)));
    }
    // Every other wall holds a turn only on a conversation.
    if (conversationId === undefined) {
        return bare(event);
    }
    // The provider failed, not the workspace; past the attempt budget the frame goes out bare.
    if (context.outage !== undefined && context.outage.attempt < OUTAGE_MAX_ATTEMPTS) {
        const armed = breakArmed(await queries.breakPolicy(conversationId, "outage"));
        return { frame: outageFrame(event, armed, context.outage), held: holding(context, conversationId, "outage"), writes: [] };
    }
    // Says on the frame whether the daemon will re-mint and re-run this credential.
    if (event.code === "claude-token-refused") {
        const { remint } = context;
        return remint === undefined
            ? bare(event)
            : { frame: { ...event, autoResume: "scheduled" }, held: holding(context, conversationId, "auth", { remint }), writes: [] };
    }
    if (event.code === "context-overflow") {
        return dressOverflow(event, context, conversationId);
    }
    if (event.code === "safeguard-flagged") {
        return dressFlagged(event, context, conversationId);
    }
    return event.code === undefined ? dressDeath(event, context, conversationId, queries) : bare(event);
};

// Google's sentence for an account it stopped serving until its owner verifies it (403, VALIDATION_REQUIRED).
const ASKS_VERIFICATION = /^verify your account to continue\.?$/i;

// How many sign-ins the sentence names before it counts the rest: enough to recognise, short enough to read.
const NAMED_ACCOUNTS = 3;

// "a@x, b@y and 4 more": the names a reader recognises, then how many are left.
const accountList = (labels: readonly string[]): string => {
    const shown = labels.slice(0, NAMED_ACCOUNTS);
    const rest = labels.length - shown.length;
    if (rest > 0) {
        return `${shown.join(", ")} and ${String(rest)} more`;
    }
    return shown.length === 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
};

// Google's "Verify your account to continue." names no account, and on a routed turn the proxy picked it: the reader
// is told which accounts are waiting on them and where each one's verify link is. The provider's sentence stays when
// the translator has not benched any yet, since then there is nothing more true to say.
const namedVerification = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<ErrorFrame> => {
    if (!ASKS_VERIFICATION.test(event.message.trim()) || !KeyedProviderSchema.safeParse(context.provider).success) {
        return event;
    }
    const labels = await queries.awaitingVerification(context.provider).catch(() => [] as readonly string[]);
    if (labels.length === 0) {
        return event;
    }
    const subject = labels.length === 1 ? "an account" : `${String(labels.length)} accounts`;
    return {
        ...event,
        message: `Google wants ${subject} verified before ${labels.length === 1 ? "it takes" : "they take"} turns again: ${accountList(labels)}. Open Sandbox ▸ Agent and follow the Verify link on ${labels.length === 1 ? "its row" : "each row"}.`,
    };
};

export const classifyFailure = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<FailurePlan> => {
    const asked = await namedVerification(event, context, queries);
    // A spent allowance's reopening, asked once: the refusal it files and the hold it books must not disagree.
    const reopening = asked.code === "rate_limit" ? await reopeningOf(asked, context, queries) : undefined;
    const filed = filedWrites(asked, context, reopening);
    const log = logOf(event, context);
    const { frame, held, writes } = await dress(asked, context, queries, reopening);
    return { frame, writes: [...filed, ...writes], log, held };
};
