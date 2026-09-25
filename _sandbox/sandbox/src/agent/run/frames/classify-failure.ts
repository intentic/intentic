import {
    type AgentEvent,
    type AgentProvider,
    breakArmed,
    KeyedProviderSchema,
    type ProviderRefusal,
    reportsPlanLimits,
    RETRY_LADDER_TRIES,
    type TodoItem,
    type TurnBreak,
    type TurnBreakPolicy,
} from "@intentic/sandbox-contract";
import type { LimitWay, limitWayOf } from "../../models/limit-way.js";
import { mentionsSpentAllowance } from "../../providers/failure-sentences.js";
import { OUTAGE_MAX_ATTEMPTS, type OutageState } from "../../providers/provider-health.js";
import type { VerificationStanding } from "../../verification/agent-verification.js";
import type { RefreshOptions } from "../../../usage/headroom.js";
import type { StoredCooldown } from "../../../usage/model-cooldowns.js";
import type { StoredModelRefusal } from "../../../usage/model-refusals.js";
import type { ObservedLimit } from "../../../usage/observed-limits.js";
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
    // Filed against the model (model-refusals.json); happens once, since the picker stops offering it after.
    "model-unavailable",
]);

// Codes filed as a durable refusal against the provider, whose `kind` reads the sentence rather than the code.
const REFUSING_CODES: ReadonlySet<string> = new Set(["rate_limit", "claude-token-refused", "claude-not-entitled"]);

// Everything classifying one failure frame reads, as it stood when the frame arrived.
export interface FailureContext {
    readonly turn: RoutedTurn;
    readonly turnId: string;
    readonly provider: AgentProvider;
    // The model the request resolved to, which is what a refusal is filed against.
    readonly model: string | undefined;
    // The account serving the turn; undefined for a routed turn, where the translator picks the credential itself.
    readonly account: string | undefined;
    readonly attribution: Attribution;
    readonly sessionId: string | undefined;
    // Whether the provider answered before this frame: `ran` on every hold this frame promises.
    readonly answered: boolean;
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
    // When a spent allowance reopens by the account's snapshot or the translator's pool.
    readonly reopensAt: (at: {
        readonly provider: AgentProvider;
        readonly model: string | undefined;
        readonly account: string | undefined;
    }) => Promise<number | undefined>;
    readonly limitWay: (params: Parameters<typeof limitWayOf>[1]) => Promise<LimitWay | undefined>;
    // How many rungs the stop ladder has spent, and when its next would fire (undefined once it is spent).
    readonly stopLadder: (conversationId: string) => { readonly made: number; readonly nextAt: number | undefined };
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
    if (event.code === "claude-not-entitled") {
        return "entitlement";
    }
    return event.code === "rate_limit" || mentionsSpentAllowance(event.message) ? "limit" : "auth";
};

// The durable refusal a refusing code files, the re-measure it owes, and for a plan with nothing to poll, the reading.
const refusalWrites = (event: ErrorFrame, context: FailureContext): FailureWrite[] => {
    if (event.code === undefined || !REFUSING_CODES.has(event.code)) {
        return [];
    }
    const { provider, account, now } = context;
    const model = named(context.model);
    // Routed turns have no account to name; the model, so the refusal reads the pool it spends.
    const refusal: ProviderRefusal = { at: now, kind: refusalKind(event), message: event.message, ...context.attribution, ...opt("model", model) };
    const observed: FailureWrite[] =
        event.code === "rate_limit" && account !== undefined && model !== undefined && !reportsPlanLimits(provider)
            ? [{ kind: "observed-limit", provider, account, model, limit: { at: now, message: event.message } }]
            : [];
    return [
        { kind: "provider-refusal", provider, refusal },
        { kind: "headroom-refresh", options: { scope: { providers: [provider], ...opt("account", account) }, maxAgeMs: 0 } },
        ...observed,
    ];
};

// The records a frame files by its code alone, before anything is asked.
const filedWrites = (event: ErrorFrame, context: FailureContext): FailureWrite[] => {
    const model = named(context.model);
    const modelRefusal: FailureWrite[] =
        event.code === "model-unavailable" && model !== undefined
            ? [{ kind: "model-refusal", provider: context.provider, model, refusal: { at: context.now, message: event.message } }]
            : [];
    const seatRefusal: FailureWrite[] =
        event.code === "claude-not-entitled" && context.account !== undefined
            ? [{ kind: "seat-refusal", account: context.account, reason: event.message }]
            : [];
    return [...refusalWrites(event, context), ...modelRefusal, ...seatRefusal];
};

const logOf = (event: ErrorFrame, context: FailureContext): FailurePlan["log"] => {
    const failed = event.code === undefined || !HANDLED_FAILURE_CODES.has(event.code);
    return {
        level: failed ? "error" : "warn",
        message: failed ? "turn failed" : "turn refused",
        fields: {
            turnId: context.turnId,
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
});

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
    },
): Promise<ErrorFrame> => {
    const { conversationId, resetsAt, held, ran, way } = limit;
    const schedulable = held && resetsAt !== undefined && conversationId !== undefined;
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

// A spent allowance: when it reopens, whether it is held, the way on, and the model a routed provider benches.
const dressLimit = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<Dressed> => {
    const { turn, provider, account, answered } = context;
    // One precedence for the reset instant: the stream's, the frame's own, else the account or pool snapshot.
    const resetsAt = context.limitReset ?? event.resetsAt ?? (await queries.reopensAt({ provider, model: context.model, account }));
    const model = named(context.model);
    const writes: FailureWrite[] =
        KeyedProviderSchema.safeParse(provider).success && model !== undefined && resetsAt !== undefined
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
    const held = conversationId === undefined ? undefined : holding(context, conversationId, "limit", { ...opt("reopensAt", resetsAt), ...way });
    // Worth dressing for a reset or a hold; with neither, it goes out bare.
    if (resetsAt === undefined && held === undefined) {
        return { frame: event, held, writes };
    }
    const frame = await limitFrame(queries, event, { conversationId, resetsAt, held: held !== undefined, ran: answered, way });
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

// Held whole for a press; a carry refused unanswered moves fresh at once; an unanswered `stopped` resume is not held again.
const dressDeath = async (event: ErrorFrame, context: FailureContext, conversationId: string, queries: FailureQueries): Promise<Dressed> => {
    const { turn, answered } = context;
    if (turn.resume === "carried" && !answered && turn.account !== undefined) {
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

const dress = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<Dressed> => {
    const { conversationId } = context.turn;
    if (event.code === "rate_limit") {
        return dressLimit(event, context, queries);
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
    return event.code === undefined ? dressDeath(event, context, conversationId, queries) : bare(event);
};

export const classifyFailure = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<FailurePlan> => {
    const filed = filedWrites(event, context);
    const log = logOf(event, context);
    const { frame, held, writes } = await dress(event, context, queries);
    return { frame, writes: [...filed, ...writes], log, held };
};
