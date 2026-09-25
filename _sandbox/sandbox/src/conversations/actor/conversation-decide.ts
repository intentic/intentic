import {
    type AgentEvent,
    type AgentJob,
    type AgentOrigin,
    type AgentSummary,
    type AgentWatch,
    type ForkedFrom,
    type KeepWarmEnd,
    PARK_KINDS,
    type ParkKind,
    type ResumeRouting,
    RETRY_LADDER_TRIES,
    type SessionOwner,
    type TodoItem,
    type TurnProfile,
    type TurnProof,
} from "@intentic/sandbox-contract";
import type { TurnCheckpoint } from "../../agent/checkpoints/turn-checkpoints.js";
import type { JournalledTurn } from "../../agent/run/turn/turn-journal.js";
import type { HeldTurn } from "../../agent/run/turn/turn-resume.js";
import { opt } from "../../opt.js";
import type { FailedEnding, PersistedAgent } from "../registry/agents-store.js";
import {
    edited,
    hold,
    joined,
    type QueueChange,
    type QueuedItem,
    released,
    removed,
    rerouted,
    returned,
    taken,
    type TurnQueue,
} from "./conversation-queue.js";
import {
    type ConversationState,
    freshRuntime,
    type HeldRecord,
    NO_USAGE,
    type RunningPhase,
    runningPhase,
    type StopEnding,
    type TurnRuntime,
    type TurnUsage,
} from "./conversation-state.js";

// The conversation's one writer: an event and the state it meets become the next state, the effects to perform, and
// the answer owed to whoever sent it. Pure: the persisted entry arrives as a value, time as `now`, and every write
// beyond the state (the entry, the roster broadcast, the transcript index) leaves as data for the runner.

// What `begin` records for a turn: its profile whole, and what only a conversation's opening turn decides (title,
// origin, start folder, starter, owner, fence), each latched on the first turn and ignored on every later one.
export interface BeginTurn {
    readonly conversationId: string;
    readonly prompt: string;
    readonly profile: TurnProfile;
    // Placement as the conversation decided it; the profile's own `isolated` is only what the request asked for.
    readonly isolated: boolean;
    // Latched like `isolated`; only a conversation never seen before takes the request's runner.
    readonly runner?: string;
    readonly title?: string;
    readonly origin?: AgentOrigin;
    readonly startIn?: string;
    // A person sent this turn: the only turn that opens, and so un-archives, an archived conversation.
    readonly byPerson: boolean;
    // Who asked for this turn, as the daemon verified it.
    readonly startedBy?: string;
    // The member the conversation belongs to when this turn opens it.
    readonly owner?: Pick<SessionOwner, "email" | "name">;
    // The fence that member holds, as area ids.
    readonly areas?: readonly string[];
    readonly forkedFrom?: ForkedFrom;
}

// Why a turn does not claim the conversation: a turn or a rewind holds it, or it is archived and no person sent this one.
export type BeginRefusal = "busy" | "archived";

export type BeginOutcome = "begun" | BeginRefusal;

// How the settling turn ended, read before the settle resets what says so. A turn that ran to its own end speaks for
// the whole checklist; one cut short learned nothing about what it did not see; `none` is a settle with no turn.
export type TurnEnding = "clean" | "cut" | "none";

// What the settle folds into the entry, as the turn left it.
export interface SettleFlush {
    // Whether a turn was live, so a manual land's settle does not count one.
    readonly ranTurn: boolean;
    readonly stopped: StopEnding | undefined;
    readonly ending: TurnEnding;
    readonly failure: FailedEnding | undefined;
    readonly usage: TurnUsage;
    readonly sessionId: string | undefined;
    readonly checklist: readonly TodoItem[] | undefined;
    // What the turn showed of its own work; absent for one that touched no code, which leaves the card's last record.
    readonly proof: TurnProof | undefined;
}

export type ConversationEvent =
    // Claims the conversation for a turn unless it is archived and no person sent the turn, or a turn or a rewind holds it.
    | { readonly kind: "begin"; readonly turn: BeginTurn }
    // Whether a `begin` from this sender would find the conversation archived, asked before a run is made for it.
    | { readonly kind: "open-asked"; readonly byPerson: boolean }
    // The in-flight record of the run that holds, or is about to hold, this conversation's turn, whole as of now: held
    // for the `begin` that writes it with its entry, then written through as it changes.
    | { readonly kind: "journalled"; readonly entry: JournalledTurn }
    // That run is over and its transcript is down; its record goes.
    | { readonly kind: "unjournalled" }
    // One frame of the live turn, folded into what the card shows.
    | { readonly kind: "frame"; readonly frame: AgentEvent }
    // A stop or a dismissal, recorded the instant it lands, ahead of the seconds-long unwind.
    | { readonly kind: "stop"; readonly ending: StopEnding }
    // What the settling turn showed of its own work, read off its tool calls; the settle files it on the card.
    | { readonly kind: "proof-noted"; readonly proof: TurnProof }
    // The turn is over, however it ended; a manual land settles a resting card the same way.
    | { readonly kind: "settle" }
    // A restored card's answer will re-run the turn; holds the card through the settle that precedes it.
    | { readonly kind: "resume-promised" }
    // The recovery is not coming; settles the card into the failure it was holding open.
    | { readonly kind: "resume-abandoned"; readonly reason: string }
    | { readonly kind: "land-leased" }
    | { readonly kind: "land-released" }
    | { readonly kind: "rewind-leased" }
    | { readonly kind: "rewind-released" }
    // A rewind restored files the session no longer describes; the next turn opens a fresh thread.
    | { readonly kind: "session-cleared" }
    // A wall stranded the settling turn, or the door turned it away: held whole for a press or the resume pass.
    | { readonly kind: "turn-held"; readonly held: HeldTurn }
    // A turn settled with nothing held: the run got somewhere, so the stop ladder starts from its first rung again.
    | { readonly kind: "turn-got-somewhere" }
    // A new turn supersedes the pending resume; the held turn it replaces is the answer, for its ledgers.
    | { readonly kind: "resume-superseded" }
    // A re-mint attempt starting or ending.
    | { readonly kind: "auth-firing"; readonly firing: boolean }
    // The held turn the resume pass is finished with.
    | { readonly kind: "resume-dropped" }
    // The held turn's one dispatch, a limit's appointment or a stop-ladder rung; answers whether it may go.
    | { readonly kind: "held-fired"; readonly ladder: boolean }
    // A spent stop ladder stands down: the hold stays for a press, never fired by the pass again; the count restarts.
    | { readonly kind: "ladder-spent" }
    // A turn took the conversation's steering seam; it starts unwatched, whatever the last one was.
    | { readonly kind: "turn-registered" }
    // A person's words reached the live turn.
    | { readonly kind: "person-steered" }
    // A steered message's checkpoint box, reserved before its capture starts; answers the box's id.
    | { readonly kind: "steer-reserved" }
    | { readonly kind: "steer-captured"; readonly slot: number; readonly checkpoint: TurnCheckpoint }
    // The settle files every box under its row; answers them in the order reserved, and leaves none behind.
    | { readonly kind: "steers-taken" }
    // A restored card's permission, for the resumed turn's gate to take instead of asking again.
    | { readonly kind: "grant-restored"; readonly tool: string; readonly always: boolean }
    // The gate asks for a grant on this tool; answered once, and only while fresh.
    | { readonly kind: "grant-taken"; readonly tool: string }
    // The card's list of the conversation's background jobs, whole, as their registry now reads it.
    | { readonly kind: "jobs-shown"; readonly jobs: readonly AgentJob[] }
    // The card's list of its armed watches, whole; empty once the last one fires or is stopped.
    | { readonly kind: "watches-shown"; readonly watches: readonly AgentWatch[] }
    // Where its loop stands, at each iteration boundary and once more at the end.
    | { readonly kind: "loop-shown"; readonly loop: NonNullable<AgentSummary["loop"]> }
    // The workflow step it runs, as that step starts.
    | { readonly kind: "workflow-shown"; readonly workflow: NonNullable<AgentSummary["workflow"]> }
    // A message joins the queue: it arrived while a turn that could not take it ran, or behind others waiting.
    | { readonly kind: "queue-joined"; readonly item: Omit<QueuedItem, "revision"> }
    // A turn delivered these waiting messages: it started with them, or they were said into it.
    | { readonly kind: "queue-taken"; readonly ids: readonly string[] }
    // A refusal at the door handed these back: at the head again, held.
    | { readonly kind: "queue-returned"; readonly items: readonly Omit<QueuedItem, "revision">[] }
    // Somebody took one back, or reworded it, as it read at `revision`; answers what the change found.
    | { readonly kind: "queue-removed"; readonly id: string; readonly revision: number }
    | { readonly kind: "queue-edited"; readonly id: string; readonly revision: number; readonly text: string }
    // A held queue is let go, what a person waits with pointed at who the press names to serve it.
    | { readonly kind: "queue-released"; readonly routing?: ResumeRouting }
    // Whether the daemon now holds the settled turn's request to replay as a cache refresh.
    | { readonly kind: "replay-noted"; readonly replayable: boolean }
    // The prompt cache is to be kept warm until `until`; a second arming moves the deadline and keeps the count.
    | { readonly kind: "keep-warm-armed"; readonly until: number; readonly auto: boolean }
    | { readonly kind: "keep-warm-dropped" }
    // A refresh landed: the cache's clock restarts at `at`, and `readTokens` is what it found still cached.
    | { readonly kind: "keep-warm-refreshed"; readonly at: number; readonly ttlMs: number; readonly readTokens: number }
    | { readonly kind: "keep-warm-ended"; readonly reason: KeepWarmEnd; readonly detail?: string };

export type ConversationEffect =
    // Publishes the whole roster; readers take the state as it is by then.
    | { readonly kind: "broadcast" }
    // The same, for a running turn's own progress, which may ride the next send a moment later instead.
    | { readonly kind: "progress" }
    // Writes the entries to disk; what an awaited send waits on.
    | { readonly kind: "persist" }
    // Re-derives every land standing; a settled card must go out with the standing its turn left.
    | { readonly kind: "reprobe" }
    // The turn's entry, and its journal row when the run filed one: written together by the `persist` after it.
    | { readonly kind: "entry-opened"; readonly turn: BeginTurn; readonly inFlight?: JournalledTurn }
    // The begun run's journal row rewritten, or deleted, on its own.
    | { readonly kind: "journal-written"; readonly entry: JournalledTurn }
    | { readonly kind: "journal-cleared" }
    | { readonly kind: "entry-settled"; readonly flush: SettleFlush }
    | { readonly kind: "entry-abandoned"; readonly failure: string | undefined }
    // The session and the account that minted it, written through at once, fire-and-forget.
    | { readonly kind: "session-bound"; readonly sessionId: string; readonly account: string | undefined }
    | { readonly kind: "session-dropped" }
    // A plan's heading offered as the title; the registry's ranking decides whether it lands.
    | { readonly kind: "title-planned"; readonly text: string }
    // A compaction filed under the turn it happened in, once per turn.
    | { readonly kind: "compacted" }
    // The prompt filed for search under a provider session, and under the conversation itself.
    | { readonly kind: "session-prompt"; readonly sessionId: string; readonly prompt: string }
    | { readonly kind: "conversation-prompt"; readonly prompt: string }
    // The queue onto the entry, for the persist after it to carry.
    | { readonly kind: "queue-written"; readonly queue: TurnQueue };

// What each event answers; every other event answers nothing.
interface Replies {
    readonly begin: BeginOutcome;
    readonly "open-asked": boolean;
    readonly "resume-superseded": HeldRecord | undefined;
    readonly "held-fired": boolean;
    readonly "steer-reserved": number | undefined;
    readonly "steers-taken": readonly (TurnCheckpoint | undefined)[];
    readonly "grant-taken": { readonly always: boolean } | undefined;
    readonly "resume-abandoned": boolean;
    readonly "rewind-leased": boolean;
    readonly "queue-removed": QueueChange;
    readonly "queue-edited": QueueChange;
}

export type ReplyOf<E extends ConversationEvent> = E["kind"] extends keyof Replies ? Replies[E["kind"]] : undefined;

export interface Decision<R> {
    readonly state: ConversationState;
    readonly effects: readonly ConversationEffect[];
    readonly reply: R;
}

// Long enough for a provider's own explanation; short enough that a stack trace or error page can't ride into the
// roster. One bounded line, no newlines; empty collapses to `undefined`.
const MAX_FAILURE_LENGTH = 400;
const sanitizeFailure = (message: string): string | undefined => {
    const clean = message.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_FAILURE_LENGTH);
    return clean === "" ? undefined : clean;
};

// The frame's own verdict decides, not the code, except a rate limit: its reopening can be hours away, so it is
// recorded as a failure rather than hidden as work in progress.
const comingBackNow = (event: Extract<AgentEvent, { kind: "error" }>): boolean => event.autoResume === "scheduled" && event.code !== "rate_limit";

// A spent allowance is its own kind: the only failure with a reopening, a hold, a booking and a move to carry.
const failureOf = (event: Extract<AgentEvent, { kind: "error" }>): FailedEnding => {
    const failure = sanitizeFailure(event.message);
    if (event.code !== "rate_limit") {
        return { kind: "failed", ...opt("failure", failure), ...opt("code", event.code) };
    }
    return {
        kind: "limited",
        ...opt("failure", failure),
        ...opt("resetsAt", event.resetsAt),
        held: event.held !== undefined,
        // The daemon's own verdict for this failure; the firing pass reads the same value, so card and schedule agree.
        scheduled: event.autoResume === "scheduled",
        ...opt("moving", event.held?.moving),
    };
};

// Half a pair names no deadline, so the frame is read only whole; a frame carrying neither leaves the last one standing.
const promptCacheOf = (event: Extract<AgentEvent, { kind: "context_usage" }>, last: TurnRuntime["promptCache"]): TurnRuntime["promptCache"] =>
    event.cachedAt !== undefined && event.cacheTtlMs !== undefined ? { at: event.cachedAt, ttlMs: event.cacheTtlMs } : last;

const unchanged = <R>(state: ConversationState, reply: R): Decision<R> => ({ state, effects: [], reply });

const BROADCAST: readonly ConversationEffect[] = [{ kind: "broadcast" }];

// A queue that moved is written onto the entry, persisted, and shown, in that order; one that did not writes nothing.
const queueWrites = (before: TurnQueue, after: TurnQueue): readonly ConversationEffect[] =>
    before === after ? [] : [{ kind: "queue-written", queue: after }, { kind: "persist" }];

const withQueue = <R>(state: ConversationState, queue: TurnQueue, reply: R): Decision<R> =>
    queue === state.queue
        ? unchanged(state, reply)
        : { state: { ...state, queue }, effects: [...queueWrites(state.queue, queue), ...BROADCAST], reply };

const PROGRESS: readonly ConversationEffect[] = [{ kind: "progress" }];

// A frame that changes only the turn's runtime, and is card-visible.
const shown = (state: ConversationState, turn: TurnRuntime): Decision<undefined> => ({
    state: { ...state, turn },
    effects: PROGRESS,
    reply: undefined,
});

const withParked = (running: RunningPhase, parked: RunningPhase["parked"]): RunningPhase => ({ ...running, parked });

type ParkFrame = Extract<AgentEvent, { kind: ParkKind }>;

// A card raised on a live turn parks it; one raised on a turn being torn down, or on no turn, has nowhere to go. A
// plan's heading is offered as the title first, so a plan raised behind a stop still names the job.
const onPark = (state: ConversationState, turn: TurnRuntime, event: ParkFrame): Decision<undefined> => {
    const lead: readonly ConversationEffect[] = event.kind === "plan" ? [{ kind: "title-planned", text: event.text }] : [];
    const running = runningPhase(state);
    if (running === undefined || running.stopping !== undefined) {
        return { state: { ...state, turn }, effects: lead, reply: undefined };
    }
    const card = { requestId: event.requestId, kind: event.kind };
    const at = running.parked.findIndex((held) => held.requestId === card.requestId);
    const parked = at === -1 ? [...running.parked, card] : running.parked.map((held, index) => (index === at ? card : held));
    return { state: { ...state, phase: withParked(running, parked), turn }, effects: [...lead, { kind: "broadcast" }], reply: undefined };
};

// Nothing to release means nothing to publish: a daemon restarted mid-park never saw the card go up.
const onResolved = (state: ConversationState, turn: TurnRuntime, requestId: string): Decision<undefined> => {
    const running = runningPhase(state);
    if (running === undefined || !running.parked.some((card) => card.requestId === requestId)) {
        return { state: { ...state, turn }, effects: [], reply: undefined };
    }
    const parked = running.parked.filter((card) => card.requestId !== requestId);
    return { state: { ...state, phase: withParked(running, parked), turn }, effects: BROADCAST, reply: undefined };
};

const onSession = (state: ConversationState, turn: TurnRuntime, event: Extract<AgentEvent, { kind: "session" }>): Decision<undefined> => {
    const filed: readonly ConversationEffect[] =
        turn.promptToFile === undefined ? [] : [{ kind: "session-prompt", sessionId: event.sessionId, prompt: turn.promptToFile }];
    return {
        state: { ...state, turn: { ...turn, sessionId: event.sessionId, promptToFile: undefined } },
        effects: [{ kind: "session-bound", sessionId: event.sessionId, account: event.account }, ...filed],
        reply: undefined,
    };
};

type Spent = { readonly [K in keyof TurnUsage]?: number | undefined };

const counted = (turn: TurnRuntime, spent: Spent): TurnRuntime => ({
    ...turn,
    usage: {
        costUsd: turn.usage.costUsd + (spent.costUsd ?? 0),
        inputTokens: turn.usage.inputTokens + (spent.inputTokens ?? 0),
        outputTokens: turn.usage.outputTokens + (spent.outputTokens ?? 0),
        toolUses: turn.usage.toolUses + (spent.toolUses ?? 0),
        subagents: turn.usage.subagents + (spent.subagents ?? 0),
    },
});

const onToolCall = (state: ConversationState, turn: TurnRuntime, frame: Extract<AgentEvent, { kind: "tool_call" }>): Decision<undefined> =>
    shown(state, {
        ...counted(turn, { toolUses: 1 }),
        activity: {
            tool: frame.name,
            ...(frame.target !== undefined ? { target: frame.target } : {}),
            ...(turn.activity?.todo !== undefined ? { todo: turn.activity.todo } : {}),
        },
    });

// Every `todos` frame carries the complete list, never a patch, so the last one is the final word.
const onTodos = (state: ConversationState, turn: TurnRuntime, frame: Extract<AgentEvent, { kind: "todos" }>): Decision<undefined> => {
    const current = frame.items.find((item) => item.status === "in_progress")?.content;
    return shown(state, { ...turn, activity: { ...turn.activity, ...(current !== undefined ? { todo: current } : {}) }, checklist: frame.items });
};

// A scheduled resume is not how the turn ended; it still reads as work in progress, and says so without a broadcast.
const onError = (state: ConversationState, turn: TurnRuntime, frame: Extract<AgentEvent, { kind: "error" }>): Decision<undefined> =>
    comingBackNow(frame)
        ? unchanged({ ...state, turn: { ...turn, resuming: true } }, undefined)
        : shown(state, { ...turn, failure: failureOf(frame) });

type FrameHandler<K extends AgentEvent["kind"]> = (
    state: ConversationState,
    turn: TurnRuntime,
    frame: Extract<AgentEvent, { kind: K }>,
) => Decision<undefined>;

// Every frame not named here (deltas, thinking, text) moves only the card's recency, with no broadcast.
// Every card kind parks its turn the same way.
const PARKS = Object.fromEntries(PARK_KINDS.map((kind) => [kind, onPark])) as { readonly [K in ParkKind]: FrameHandler<K> };

const FRAMES: { readonly [K in AgentEvent["kind"]]?: FrameHandler<K> } = {
    ...PARKS,
    session: onSession,
    resolved: (state, turn, frame) => onResolved(state, turn, frame.requestId),
    usage: (state, turn, frame) => shown(state, counted(turn, frame)),
    context_usage: (state, turn, frame) =>
        shown(state, {
            ...turn,
            contextTokens: frame.tokens,
            contextWindow: frame.contextWindow,
            promptCache: promptCacheOf(frame, turn.promptCache),
        }),
    tool_call: onToolCall,
    todos: onTodos,
    // The lifetime count is taken only at birth; the live registry sweeps a settled child and forgets it.
    subagent: (state, turn) => shown(state, counted(turn, { subagents: 1 })),
    subagent_update: (state, turn, frame) => (frame.status === undefined ? unchanged({ ...state, turn }, undefined) : shown(state, turn)),
    compact: (state, turn) => ({ state: { ...state, turn }, effects: [{ kind: "compacted" }], reply: undefined }),
    error: onError,
};

const onFrame = (state: ConversationState, frame: AgentEvent, now: number): Decision<undefined> => {
    const turn: TurnRuntime = { ...state.turn, lastAt: now };
    const handler = FRAMES[frame.kind] as FrameHandler<AgentEvent["kind"]> | undefined;
    return handler === undefined ? unchanged({ ...state, turn }, undefined) : handler(state, turn, frame);
};

// Only a person un-archives a conversation: every other turn meets an archived one turned away.
const refusesArchived = (entry: PersistedAgent | undefined, byPerson: boolean): boolean => entry?.archivedAt !== undefined && !byPerson;

// Both holders of the mutex are read together, and the claim is this one synchronous step. The prompt is filed under
// the session the conversation resumes at once, else held for the frame that mints one.
const onBegin = (state: ConversationState, turn: BeginTurn, now: number, entry: PersistedAgent | undefined): Decision<BeginOutcome> => {
    if (refusesArchived(entry, turn.byPerson)) {
        return unchanged(state, "archived");
    }
    if (state.phase.kind !== "idle") {
        return unchanged(state, "busy");
    }
    const session = entry?.sessionId;
    const staged = state.journal?.written === false ? state.journal.entry : undefined;
    const kept = state.keepWarm;
    return {
        state: {
            ...state,
            phase: { kind: "running", startedAt: now, parked: [], stopping: undefined },
            turn: {
                ...freshRuntime(),
                lastAt: now,
                promptToFile: session === undefined ? turn.prompt : undefined,
                keptWarm: kept === undefined || kept.ended !== undefined ? undefined : { forMs: now - kept.since, refreshes: kept.refreshes },
            },
            journal: staged === undefined ? state.journal : { entry: staged, written: true },
            keepWarm: undefined,
        },
        effects: [
            { kind: "entry-opened", turn, ...opt("inFlight", staged) },
            // An entry opened just now missed what already waits: a message sent while the first turn was starting.
            ...(entry === undefined && state.queue.items.length > 0 ? [{ kind: "queue-written", queue: state.queue } as const] : []),
            ...(session === undefined ? [] : [{ kind: "session-prompt", sessionId: session, prompt: turn.prompt } as const]),
            { kind: "conversation-prompt", prompt: turn.prompt },
            // Published before the write: this is the frame that moves every board's card into Active.
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    };
};

// Nothing running means nothing to say; marking a settled conversation would leak `stopping` onto its next turn. Every
// parked card goes here, since a `resolved` frame may never make it out of a dying stream. What waits is held for
// everyone, so a stopped agent does not start again on its own.
const onStop = (state: ConversationState, ending: StopEnding): Decision<undefined> => {
    const running = runningPhase(state);
    if (running === undefined || running.stopping !== undefined) {
        return unchanged(state, undefined);
    }
    const queue = hold(state.queue, "stopped");
    return {
        state: { ...state, phase: { ...running, stopping: ending, parked: [] }, queue },
        effects: [...queueWrites(state.queue, queue), ...BROADCAST],
        reply: undefined,
    };
};

// The turn's books go into the entry and are zeroed; the readings a card keeps showing stay. A settle on a rewinding
// conversation leaves the rewind holding it, and one whose entry is gone writes nothing and keeps the books.
const onSettle = (state: ConversationState, entry: PersistedAgent | undefined): Decision<undefined> => {
    const running = runningPhase(state);
    const phase = running === undefined ? state.phase : { kind: "idle" as const };
    if (entry === undefined) {
        return { state: { ...state, phase }, effects: [{ kind: "reprobe" }, { kind: "broadcast" }], reply: undefined };
    }
    const { turn } = state;
    const flush: SettleFlush = {
        ranTurn: running !== undefined,
        stopped: running?.stopping,
        ending: running === undefined ? "none" : turn.failure !== undefined || running.stopping !== undefined ? "cut" : "clean",
        failure: turn.failure,
        usage: turn.usage,
        sessionId: turn.sessionId,
        checklist: turn.checklist,
        proof: turn.proof,
    };
    return {
        state: { ...state, phase, turn: { ...turn, usage: NO_USAGE, sessionId: undefined, failure: undefined, proof: undefined } },
        effects: [{ kind: "entry-settled", flush }, { kind: "persist" }, { kind: "reprobe" }, { kind: "broadcast" }],
        reply: undefined,
    };
};

// Answers whether the wait is over, not whether anything was written: a turn still unwinding is about to overwrite
// anything written here, and a wait a fresh `begin` already cleared has nothing left to end.
const onAbandon = (state: ConversationState, reason: string, entry: PersistedAgent | undefined): Decision<boolean> => {
    if (state.phase.kind === "running") {
        return unchanged(state, false);
    }
    if (entry === undefined || !state.turn.resuming) {
        return unchanged(state, true);
    }
    return {
        state: { ...state, turn: { ...state.turn, resuming: false } },
        effects: [{ kind: "entry-abandoned", failure: sanitizeFailure(reason) }, { kind: "persist" }, { kind: "broadcast" }],
        reply: true,
    };
};

// Held until the `begin` that writes it with the turn's entry; once that has happened, every newer version is written.
const onJournalled = (state: ConversationState, entry: JournalledTurn): Decision<undefined> =>
    state.journal?.written === true
        ? { state: { ...state, journal: { entry, written: true } }, effects: [{ kind: "journal-written", entry }], reply: undefined }
        : unchanged({ ...state, journal: { entry, written: false } }, undefined);

// A record never written has nothing to delete.
const onUnjournalled = (state: ConversationState): Decision<undefined> =>
    state.journal?.written === true
        ? { state: { ...state, journal: undefined }, effects: [{ kind: "journal-cleared" }], reply: undefined }
        : unchanged({ ...state, journal: undefined }, undefined);

// The card reads `landing` from the first holder's claim; each release counts one off, and the last one hides it.
const onLandLeased = (state: ConversationState): Decision<undefined> => ({
    state: { ...state, turn: { ...state.turn, landing: true }, land: { held: state.land.held + 1 } },
    effects: state.turn.landing ? [] : BROADCAST,
    reply: undefined,
});

const onLandReleased = (state: ConversationState): Decision<undefined> => {
    const held = Math.max(0, state.land.held - 1);
    if (held > 0) {
        return unchanged({ ...state, land: { held } }, undefined);
    }
    return { state: { ...state, turn: { ...state.turn, landing: false }, land: { held } }, effects: BROADCAST, reply: undefined };
};

// A rewind shares the turn mutex: refused under a live turn, and holding off every `begin` until released.
const onRewindLeased = (state: ConversationState): Decision<boolean> =>
    state.phase.kind === "running" ? unchanged(state, false) : { state: { ...state, phase: { kind: "rewinding" } }, effects: [], reply: true };

const onRewindReleased = (state: ConversationState): Decision<undefined> =>
    unchanged(state.phase.kind === "rewinding" ? { ...state, phase: { kind: "idle" } } : state, undefined);

const withResume = (state: ConversationState, resume: Partial<ConversationState["resume"]>): ConversationState => ({
    ...state,
    resume: { ...state.resume, ...resume },
});

// A stopped hold inherits the ladder's count; an outage or a refused credential says nothing of a stall, so restarts it.
const onHeld = (state: ConversationState, held: HeldTurn, now: number): Decision<undefined> => {
    const tries = held.reason === "stopped" ? state.resume.stopTries : 0;
    const provider = held.reason === "outage" || held.reason === "auth";
    return unchanged(
        withResume(state, { held: { ...held, recordedAt: now, fired: false, tries }, ...(provider ? { stopTries: 0 } : {}) }),
        undefined,
    );
};

// The one dispatch a hold gets, stamped before the fire so it holds even if starting conflicts. A ladder rung also
// spends one try, and a spent ladder fires no more whatever the pass asks.
const onHeldFired = (state: ConversationState, ladder: boolean): Decision<boolean> => {
    const { held } = state.resume;
    if (held === undefined || held.fired || (ladder && held.tries >= RETRY_LADDER_TRIES)) {
        return unchanged(state, false);
    }
    return unchanged(withResume(state, { held: { ...held, fired: true }, ...(ladder ? { stopTries: held.tries + 1 } : {}) }), true);
};

// Bounds runaway steering per conversation; a settling turn empties the boxes, this guards one that never does. Only
// ever bites at the tail, so it can't shift an earlier message's position.
const MAX_STEER_SLOTS = 200;

const onSteerReserved = (state: ConversationState): Decision<number | undefined> => {
    const { next, slots } = state.steers;
    if (slots.length >= MAX_STEER_SLOTS) {
        return unchanged(state, undefined);
    }
    return unchanged({ ...state, steers: { next: next + 1, slots: [...slots, { id: next, checkpoint: undefined }] } }, next);
};

const onSteerCaptured = (state: ConversationState, slot: number, checkpoint: TurnCheckpoint): Decision<undefined> => {
    const slots = state.steers.slots.map((box) => (box.id === slot ? { id: slot, checkpoint } : box));
    return unchanged({ ...state, steers: { ...state.steers, slots } }, undefined);
};

// How long a restored grant waits for the re-run it was given for; past it, the gate asks again.
const RESTORED_GRANT_TTL_MS = 10 * 60_000;

// Only the tool it was granted for takes it, and only fresh; a stale one stays until the next grant replaces it.
const onGrantTaken = (state: ConversationState, tool: string, now: number): Decision<{ readonly always: boolean } | undefined> => {
    const { grant } = state;
    if (grant === undefined || grant.tool !== tool || now - grant.grantedAt > RESTORED_GRANT_TTL_MS) {
        return unchanged(state, undefined);
    }
    return unchanged({ ...state, grant: undefined }, { always: grant.always });
};

// A live hold keeps its start and its count when re-armed; an ended one starts over.
const onKeepWarmArmed = (state: ConversationState, until: number, auto: boolean, now: number): Decision<undefined> => {
    const live = state.keepWarm?.ended === undefined ? state.keepWarm : undefined;
    return {
        state: { ...state, keepWarm: { since: live?.since ?? now, until, refreshes: live?.refreshes ?? 0, ...opt("readTokens", live?.readTokens), ...(auto ? { auto } : {}) } },
        effects: BROADCAST,
        reply: undefined,
    };
};

// A refresh or an ending that lands after a turn took the hold has nothing left to write to.
const onKeepWarmRefreshed = (state: ConversationState, event: Extract<ConversationEvent, { kind: "keep-warm-refreshed" }>): Decision<undefined> => {
    const kept = state.keepWarm;
    if (kept === undefined || kept.ended !== undefined || state.phase.kind === "running") {
        return unchanged(state, undefined);
    }
    return {
        state: {
            ...state,
            turn: { ...state.turn, promptCache: { at: event.at, ttlMs: event.ttlMs } },
            keepWarm: { ...kept, refreshes: kept.refreshes + 1, readTokens: event.readTokens },
        },
        effects: BROADCAST,
        reply: undefined,
    };
};

const onKeepWarmEnded = (state: ConversationState, event: Extract<ConversationEvent, { kind: "keep-warm-ended" }>, now: number): Decision<undefined> => {
    const kept = state.keepWarm;
    if (kept === undefined || kept.ended !== undefined) {
        return unchanged(state, undefined);
    }
    return {
        state: { ...state, keepWarm: { ...kept, ended: { at: now, reason: event.reason, ...opt("detail", event.detail) } } },
        effects: BROADCAST,
        reply: undefined,
    };
};

// Both halves go, the live turn's pending id and the entry's, or the next turn would resume through whichever survived.
const onSessionCleared = (state: ConversationState, entry: PersistedAgent | undefined): Decision<undefined> =>
    entry === undefined
        ? unchanged(state, undefined)
        : {
              state: { ...state, turn: { ...state.turn, sessionId: undefined } },
              effects: [{ kind: "session-dropped" }, { kind: "persist" }, { kind: "broadcast" }],
              reply: undefined,
          };

type Handler<K extends ConversationEvent["kind"]> = (
    state: ConversationState,
    event: Extract<ConversationEvent, { kind: K }>,
    now: number,
    entry: PersistedAgent | undefined,
) => Decision<ReplyOf<Extract<ConversationEvent, { kind: K }>>>;

const HANDLERS: { readonly [K in ConversationEvent["kind"]]: Handler<K> } = {
    begin: (state, event, now, entry) => onBegin(state, event.turn, now, entry),
    "open-asked": (state, event, _now, entry) => unchanged(state, !refusesArchived(entry, event.byPerson)),
    journalled: (state, event) => onJournalled(state, event.entry),
    unjournalled: onUnjournalled,
    frame: (state, event, now) => onFrame(state, event.frame, now),
    stop: (state, event) => onStop(state, event.ending),
    "proof-noted": (state, event) => unchanged({ ...state, turn: { ...state.turn, proof: event.proof } }, undefined),
    settle: (state, _event, _now, entry) => onSettle(state, entry),
    "resume-promised": (state) => unchanged({ ...state, turn: { ...state.turn, resuming: true } }, undefined),
    "resume-abandoned": (state, event, _now, entry) => onAbandon(state, event.reason, entry),
    "land-leased": onLandLeased,
    "land-released": onLandReleased,
    "rewind-leased": onRewindLeased,
    "rewind-released": onRewindReleased,
    "session-cleared": (state, _event, _now, entry) => onSessionCleared(state, entry),
    "turn-held": (state, event, now) => onHeld(state, event.held, now),
    "turn-got-somewhere": (state) => unchanged(withResume(state, { stopTries: 0 }), undefined),
    "resume-superseded": (state) => unchanged(withResume(state, { held: undefined }), state.resume.held),
    "auth-firing": (state, event) => unchanged(withResume(state, { authFiring: event.firing }), undefined),
    "resume-dropped": (state) => unchanged(withResume(state, { held: undefined }), undefined),
    "held-fired": (state, event) => onHeldFired(state, event.ladder),
    "ladder-spent": (state) =>
        unchanged(withResume(state, { held: state.resume.held && { ...state.resume.held, fired: true }, stopTries: 0 }), undefined),
    "turn-registered": (state) => unchanged({ ...state, steered: false }, undefined),
    "person-steered": (state) => unchanged({ ...state, steered: true }, undefined),
    "steer-reserved": onSteerReserved,
    "steer-captured": (state, event) => onSteerCaptured(state, event.slot, event.checkpoint),
    "grant-restored": (state, event, now) => unchanged({ ...state, grant: { tool: event.tool, always: event.always, grantedAt: now } }, undefined),
    "grant-taken": (state, event, now) => onGrantTaken(state, event.tool, now),
    "jobs-shown": (state, event) => ({ state: { ...state, jobs: event.jobs }, effects: BROADCAST, reply: undefined }),
    "watches-shown": (state, event) => ({ state: { ...state, watches: event.watches }, effects: BROADCAST, reply: undefined }),
    "loop-shown": (state, event) => ({ state: { ...state, loop: event.loop }, effects: BROADCAST, reply: undefined }),
    "workflow-shown": (state, event) => ({ state: { ...state, workflow: event.workflow }, effects: BROADCAST, reply: undefined }),
    "steers-taken": (state) =>
        unchanged(
            { ...state, steers: { ...state.steers, slots: [] } },
            state.steers.slots.map((box) => box.checkpoint),
        ),
    "queue-joined": (state, event) => withQueue(state, joined(state.queue, event.item), undefined),
    "queue-taken": (state, event) => withQueue(state, taken(state.queue, event.ids), undefined),
    "queue-returned": (state, event) => withQueue(state, returned(state.queue, event.items), undefined),
    "queue-removed": (state, event) => {
        const { queue, change } = removed(state.queue, event.id, event.revision);
        return withQueue(state, queue, change);
    },
    "queue-edited": (state, event) => {
        const { queue, change } = edited(state.queue, event.id, event.revision, event.text);
        return withQueue(state, queue, change);
    },
    "queue-released": (state, event) =>
        withQueue(state, released(event.routing === undefined ? state.queue : rerouted(state.queue, event.routing)), undefined),
    "replay-noted": (state, event) =>
        state.turn.replayable === event.replayable
            ? unchanged(state, undefined)
            : { state: { ...state, turn: { ...state.turn, replayable: event.replayable } }, effects: BROADCAST, reply: undefined },
    "keep-warm-armed": (state, event, now) => onKeepWarmArmed(state, event.until, event.auto, now),
    "keep-warm-dropped": (state) => (state.keepWarm === undefined ? unchanged(state, undefined) : { state: { ...state, keepWarm: undefined }, effects: BROADCAST, reply: undefined }),
    "keep-warm-refreshed": (state, event) => onKeepWarmRefreshed(state, event),
    "keep-warm-ended": (state, event, now) => onKeepWarmEnded(state, event, now),
};

/* ONE EVENT, APPLIED WHOLE: the next state, the effects in the order they must run, and the sender's answer. */
export const decide = <E extends ConversationEvent>(
    state: ConversationState,
    event: E,
    now: number,
    entry: PersistedAgent | undefined,
): Decision<ReplyOf<E>> =>
    (HANDLERS[event.kind] as unknown as (state: ConversationState, event: E, now: number, entry: PersistedAgent | undefined) => Decision<ReplyOf<E>>)(
        state,
        event,
        now,
        entry,
    );
