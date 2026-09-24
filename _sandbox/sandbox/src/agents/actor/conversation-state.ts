import type { AgentEvent, AgentJob, AgentSummary, AgentWatch, KeepWarm, TodoItem } from "@intentic/sandbox-contract";
import type { TurnCheckpoint } from "../../agent/checkpoints/turn-checkpoints.js";
import type { JournalledTurn } from "../../agent/run/turn/turn-journal.js";
import type { HeldTurn } from "../../agent/run/turn/turn-resume.js";
import type { CheckVerdict } from "../../agent/verification/turn-checks.js";
import type { FailedEnding } from "../registry/agents-store.js";
import { NO_QUEUE, type TurnQueue } from "./conversation-queue.js";

// One conversation's in-memory life as a value: which phase it is in, what its live turn has measured, and the
// leases and records that outlive a turn. Only conversation-decide.ts writes it, one event at a time; everything else
// reads it. A restart keeps none of it: the persisted entry, its queue included, and the turn journal rebuild it.

// The frames that park a turn on a person; a `resolved` frame naming the same request releases one.
export type ParkKind = Extract<
    AgentEvent["kind"],
    "plan" | "question" | "permission" | "browser_help" | "terminal_help" | "capability_offer" | "credential_offer"
>;

export type StopEnding = "stopped" | "dismissed";

export interface ParkedCard {
    readonly requestId: string;
    readonly kind: ParkKind;
}

// A live turn. Cards park only here, and each leaves by its own `resolved` frame, a stop, or the settle.
export interface RunningPhase {
    readonly kind: "running";
    readonly startedAt: number;
    readonly parked: readonly ParkedCard[];
    // Set the instant a stop or a dismissal lands, while the turn is still unwinding; a chosen ending outranks a park.
    readonly stopping: StopEnding | undefined;
}

// The turn mutex's two holders: a live turn, or a rewind restoring files, never both; `idle` is neither.
export type ConversationPhase = { readonly kind: "idle" } | { readonly kind: "rewinding" } | RunningPhase;

// What a turn spent, folded into the entry once at the settle rather than per frame.
export interface TurnUsage {
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolUses: number;
    // Children started, counted at birth; the live count comes from the subagent registry.
    readonly subagents: number;
}

export interface TurnActivity {
    readonly tool?: string;
    readonly target?: string;
    readonly todo?: string;
}

// Everything `begin` starts afresh. The settle clears the turn's books (usage, session, failure, check) and leaves the
// readings a card keeps showing between turns (activity, context fill, cache deadline, checklist, landing, resuming).
export interface TurnRuntime {
    // When the last frame arrived; a live card's recency, never a settled one's.
    readonly lastAt: number | undefined;
    readonly activity: TurnActivity | undefined;
    readonly contextTokens: number | undefined;
    readonly contextWindow: number | undefined;
    // Outlives the turn that set it: the cache entry goes on expiring whether or not this conversation runs.
    readonly promptCache: { readonly at: number; readonly ttlMs: number } | undefined;
    // Whether the daemon holds this conversation's last request to replay as a cache refresh (cache-keepwarm.ts).
    readonly replayable: boolean;
    // How long the cache was kept warm for the turn now running, stamped onto its first cache reading.
    readonly keptWarm: { readonly forMs: number; readonly refreshes: number } | undefined;
    // The agent's own checklist, whole, as of the last `todos` frame. `undefined` is a turn that has not seen the list,
    // which is not the same as an empty one.
    readonly checklist: readonly TodoItem[] | undefined;
    // The opening prompt, held until a session id exists to file it under.
    readonly promptToFile: string | undefined;
    // The session the live turn named, ahead of the settle that writes it to the entry.
    readonly sessionId: string | undefined;
    readonly usage: TurnUsage;
    // A failure the live turn hit, written whole from one frame, so a later refusal can't leave a stale code or countdown
    // behind from an earlier one; the ending the settle files. Its presence is what "errored" means.
    readonly failure: FailedEnding | undefined;
    // How the end-of-turn check went, last run wins; spent with the turn, unlike the checklist.
    readonly check: { readonly label: string; readonly failed: boolean } | undefined;
    // A recovery the daemon is already running and will re-run on its own; the one ending that survives the settle.
    readonly resuming: boolean;
    // What the card shows of the land lease; `begin` hides it, the next acquisition shows it again.
    readonly landing: boolean;
}

// The land lease's holders, the running land and those queued behind it; a count, so it outlives any one turn.
export interface LandLease {
    readonly held: number;
}

// A held turn with the resume pass's own bookkeeping: when it was held, whether its one dispatch went out, and how many
// rungs of the stop ladder it inherited.
export type HeldRecord = HeldTurn & { readonly recordedAt: number; readonly fired: boolean; readonly tries: number };

// The turn a wall stranded, until a press or the resume pass (turn-resume.ts) fires it or a new turn supersedes it.
export interface ResumeRecords {
    readonly held: HeldRecord | undefined;
    // A re-mint in flight, so a slow one isn't refired by the next pass underneath itself.
    readonly authFiring: boolean;
    // Rungs the stop ladder has spent without the run getting anywhere. Kept apart from `held`, which every turn start
    // wipes, since a count kept there would reset itself on the very fire it bounds.
    readonly stopTries: number;
}

// A steered message's before-state checkpoint, reserved the instant the turn accepts the message and filled once its
// capture resolves: position is fixed at reserve time, so two captures finishing out of order can't swap messages.
export interface SteerSlot {
    readonly id: number;
    readonly checkpoint: TurnCheckpoint | undefined;
}

export interface SteerSlots {
    // The id the next reservation takes; never reused, so a capture landing after its box was taken fills nothing.
    readonly next: number;
    readonly slots: readonly SteerSlot[];
}

export interface ConversationState {
    readonly phase: ConversationPhase;
    readonly turn: TurnRuntime;
    readonly land: LandLease;
    // The last turn.ending check's verdict, until the land takes it; the last run wins, so a repaired tree passes.
    readonly verdict: CheckVerdict | undefined;
    readonly resume: ResumeRecords;
    // Whether a person has steered the turn now running: proof somebody is at the composer, read live by the gates that
    // would otherwise refuse an unattended turn's asks. The next turn starts unwatched again.
    readonly steered: boolean;
    readonly steers: SteerSlots;
    // A permission granted on a card restored after a restart, taken once by the resumed turn's re-run of the same tool
    // so the gate doesn't ask twice.
    readonly grant: RestoredGrant | undefined;
    // A proof follow-up is in flight; the next turn's ask consumes it, so a nudge never answers a nudge.
    readonly nudged: boolean;
    // What the card lists of its background jobs, running first and then how recent ones ended, as background-jobs.ts
    // last published it. No turn resets it: a job ends whenever its command does, as often as not between turns.
    readonly jobs: readonly AgentJob[];
    // Its armed watches as the card lists them, as watchers.ts last published them: armed as one turn ends, fired hours
    // later, so no turn resets this either.
    readonly watches: readonly AgentWatch[];
    // The loop running on it and the workflow step it is, as their pumps last published them; a workflow step's is kept
    // after its run ends, since the card is read long after to say why the branch exists.
    readonly loop: NonNullable<AgentSummary["loop"]> | undefined;
    readonly workflow: NonNullable<AgentSummary["workflow"]> | undefined;
    // The in-flight record of the run that holds, or is about to hold, the turn (turn-journal.ts): unwritten until the
    // `begin` that writes it with the turn's entry, so neither is ever on disk without the other.
    readonly journal: { readonly entry: JournalledTurn; readonly written: boolean } | undefined;
    // What waits for its next turn (conversation-queue.ts), written onto the entry at every change and read back from it
    // by an actor made after a restart.
    readonly queue: TurnQueue;
    // A hold on the prompt cache while the conversation sits idle; the next turn to begin takes it.
    readonly keepWarm: KeepWarm | undefined;
}

export interface RestoredGrant {
    readonly tool: string;
    readonly always: boolean;
    readonly grantedAt: number;
}

const NO_RESUME: ResumeRecords = { held: undefined, authFiring: false, stopTries: 0 };

export const NO_USAGE: TurnUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0, toolUses: 0, subagents: 0 };

export const freshRuntime = (): TurnRuntime => ({
    lastAt: undefined,
    activity: undefined,
    contextTokens: undefined,
    contextWindow: undefined,
    promptCache: undefined,
    replayable: false,
    keptWarm: undefined,
    checklist: undefined,
    promptToFile: undefined,
    sessionId: undefined,
    usage: NO_USAGE,
    failure: undefined,
    check: undefined,
    resuming: false,
    landing: false,
});

// Where a conversation this daemon has not heard from yet starts: after a boot, every one of them, holding whatever its
// entry kept waiting.
export const idleConversation = (queue: TurnQueue = NO_QUEUE): ConversationState => ({
    phase: { kind: "idle" },
    turn: freshRuntime(),
    land: { held: 0 },
    verdict: undefined,
    resume: NO_RESUME,
    steered: false,
    steers: { next: 0, slots: [] },
    grant: undefined,
    nudged: false,
    jobs: [],
    watches: [],
    loop: undefined,
    workflow: undefined,
    journal: undefined,
    queue,
    keepWarm: undefined,
});

export const runningPhase = (state: ConversationState): RunningPhase | undefined => (state.phase.kind === "running" ? state.phase : undefined);

// Mid-sentence rather than merely alive: a park or a chosen ending already counts as quiet enough to rebase under.
export const writing = (state: ConversationState): boolean => {
    const running = runningPhase(state);
    return running !== undefined && running.stopping === undefined && running.parked.length === 0;
};

// Whether a turn is unwinding or a land or resume holds the card; a settled card must not borrow `lastAt` for recency.
export const activityLive = (state: ConversationState): boolean => state.phase.kind === "running" || state.turn.resuming || state.turn.landing;
