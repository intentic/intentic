import type { AgentEvent, TodoItem } from "@intentic/sandbox-contract";
import type { LimitWay } from "../../models/limit-way.js";
import { createFrameLedger, type FrameLedger } from "../../verification/agent-verification.js";
import { createViewFrameLedger, type ViewFrameLedger } from "../../verification/agent-viewing.js";
import { createTurnMetrics, type TurnMetrics } from "../turn/turn-metrics.js";
import { sumUsage, type UsageFrame } from "../turn/turn-usage.js";

// One fold per concern over a turn's frames, walked once in stream order: each owns its state and answers a reading at
// any point, final once the stream is. The proof ledgers and the call metrics fold the same frames beside them.

// Frames a successful model request produces, which is what clears a standing outage.
export const ANSWERED_FRAMES: ReadonlySet<AgentEvent["kind"]> = new Set(["delta", "thinking", "tool_call"]);

// How full the window was at the last reading; the frame as the stream sent it.
export type ContextFrame = Extract<AgentEvent, { kind: "context_usage" }>;

// The last error frame, not the first: a resumed turn can fail twice.
export interface TurnFailure {
    readonly code: string | undefined;
    readonly message: string;
}

// What the turn put in front of anyone, as a silent ending is judged.
export interface Silence {
    // Characters of the model's own prose, subagent narration included.
    readonly proseChars: number;
    // Every frame kind emitted; what counts as addressing the user is decided from this set, in one place.
    readonly kinds: ReadonlySet<AgentEvent["kind"]>;
    // Whether the provider spoke at all: worked-and-told-nobody counts; never-started does not.
    readonly answered: boolean;
}

// The walls this turn hit, for the records its exit leaves: an answer after an outage or a limit means the harness rode
// it out, while a refused credential stays refused.
export interface Walls {
    readonly outageHit: boolean;
    readonly limitHit: boolean;
    readonly authRefused: boolean;
    // When the refusing allowance is due back, and the way on from it, both decided once at the frame.
    readonly limitReopens: number | undefined;
    readonly limitWay: LimitWay | undefined;
}

// What classifying one failure frame found; an absent member leaves its wall as it stood.
export interface WallChange {
    readonly outageHit?: true;
    readonly authRefused?: true;
    readonly limit?: { readonly hit: boolean; readonly reopens: number | undefined; readonly way: LimitWay | undefined };
}

export const foldUsage = (total: UsageFrame | undefined, event: AgentEvent): UsageFrame | undefined =>
    event.kind === "usage" ? sumUsage(total, event) : total;

export const foldSilence = (silence: Silence, event: AgentEvent): Silence => ({
    proseChars: event.kind === "delta" ? silence.proseChars + event.text.length : silence.proseChars,
    kinds: silence.kinds.has(event.kind) ? silence.kinds : new Set([...silence.kinds, event.kind]),
    answered: silence.answered || ANSWERED_FRAMES.has(event.kind),
});

// The agent's own checklist as last reported; undefined means it kept none, not an empty one.
export const foldChecklist = (checklist: readonly TodoItem[] | undefined, event: AgentEvent): readonly TodoItem[] | undefined =>
    event.kind === "todos" ? event.items : checklist;

export const foldCompactions = (compactions: number, event: AgentEvent): number => (event.kind === "compact" ? compactions + 1 : compactions);

export const foldContext = (context: ContextFrame | undefined, event: AgentEvent): ContextFrame | undefined =>
    event.kind === "context_usage" ? event : context;

export const foldFailure = (failure: TurnFailure | undefined, event: AgentEvent): TurnFailure | undefined =>
    event.kind === "error" ? { code: event.code, message: event.message } : failure;

// The session the turn runs on, replaced by the stream's own frame.
export const foldSession = (sessionId: string | undefined, event: AgentEvent): string | undefined =>
    event.kind === "session" ? event.sessionId : sessionId;

// The reset instant the stream last named, so a spent allowance can say when its window reopens.
export const foldLimitReset = (resetsAt: number | undefined, event: AgentEvent): number | undefined =>
    event.kind === "rate_limit_info" ? (event.resetsAt ?? resetsAt) : resetsAt;

export const foldWalls = (walls: Walls, event: AgentEvent): Walls => (ANSWERED_FRAMES.has(event.kind) ? { ...walls, outageHit: false, limitHit: false } : walls);

export const applyWallChange = (walls: Walls, change: WallChange): Walls => ({
    ...walls,
    outageHit: walls.outageHit || change.outageHit === true,
    authRefused: walls.authRefused || change.authRefused === true,
    ...(change.limit === undefined ? {} : { limitHit: change.limit.hit, limitReopens: change.limit.reopens, limitWay: change.limit.way }),
});

// A fold with its state: `note` takes each frame in stream order, `reading` answers at any point.
export interface FrameReducer<Reading> {
    readonly note: (event: AgentEvent) => void;
    readonly reading: () => Reading;
}

export const frameReducer = <Reading>(initial: Reading, fold: (reading: Reading, event: AgentEvent) => Reading): FrameReducer<Reading> => {
    let reading = initial;
    return {
        note: (event) => {
            reading = fold(reading, event);
        },
        reading: () => reading,
    };
};

// Every reading the turn's frames have produced so far.
export interface TurnReadings {
    readonly sessionId: string | undefined;
    // Summed, not last-wins: a steer is a second SDK turn inside the same one.
    readonly usage: UsageFrame | undefined;
    readonly silence: Silence;
    readonly checklist: readonly TodoItem[] | undefined;
    // How many times the window was compacted, and how full it was at the end: whether the turn hit the wall.
    readonly compactions: number;
    readonly context: ContextFrame | undefined;
    readonly failure: TurnFailure | undefined;
    readonly limitReset: number | undefined;
    readonly walls: Walls;
}

export interface TurnFrames {
    // Folds one frame into every reading and ledger; true when it is the first proof the provider answered.
    readonly note: (event: AgentEvent) => boolean;
    // Folds what classifying a failure frame found about the walls it hit.
    readonly hit: (change: WallChange) => void;
    readonly readings: () => TurnReadings;
    // Whether the turn proved its work, fed frames rather than hooks so it holds on every runtime.
    readonly verification: FrameLedger;
    // Whether the turn looked at what it drew: browser evidence, kept apart from code checks.
    readonly viewing: ViewFrameLedger;
    // What the turn did before its first edit.
    readonly metrics: TurnMetrics;
}

// `root` is the tree as the agent sees it; `resumed` is the session the turn starts on until the stream names its own.
export const createTurnFrames = (root: string, resumed: string | undefined): TurnFrames => {
    const sessionId = frameReducer(resumed, foldSession);
    const usage = frameReducer<UsageFrame | undefined>(undefined, foldUsage);
    const silence = frameReducer<Silence>({ proseChars: 0, kinds: new Set(), answered: false }, foldSilence);
    const checklist = frameReducer<readonly TodoItem[] | undefined>(undefined, foldChecklist);
    const compactions = frameReducer(0, foldCompactions);
    const context = frameReducer<ContextFrame | undefined>(undefined, foldContext);
    const failure = frameReducer<TurnFailure | undefined>(undefined, foldFailure);
    const limitReset = frameReducer<number | undefined>(undefined, foldLimitReset);
    const verification = createFrameLedger();
    const viewing = createViewFrameLedger();
    const metrics = createTurnMetrics(root);
    const folds: readonly { readonly note: (event: AgentEvent) => void }[] = [
        sessionId,
        usage,
        silence,
        checklist,
        compactions,
        context,
        failure,
        limitReset,
        verification,
        viewing,
        metrics,
    ];
    // Moved from both sides, by frames and by classifications, so one state both fold into.
    let walls: Walls = { outageHit: false, limitHit: false, authRefused: false, limitReopens: undefined, limitWay: undefined };
    return {
        note: (event) => {
            const answered = silence.reading().answered;
            walls = foldWalls(walls, event);
            for (const fold of folds) {
                fold.note(event);
            }
            return !answered && silence.reading().answered;
        },
        hit: (change) => {
            walls = applyWallChange(walls, change);
        },
        readings: () => ({
            sessionId: sessionId.reading(),
            usage: usage.reading(),
            silence: silence.reading(),
            checklist: checklist.reading(),
            compactions: compactions.reading(),
            context: context.reading(),
            failure: failure.reading(),
            limitReset: limitReset.reading(),
            walls,
        }),
        verification,
        viewing,
        metrics,
    };
};
