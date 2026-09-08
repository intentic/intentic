import {
    type AgentEvent,
    type AgentStatus,
    type AgentSummary,
    type AgentTurn,
    deriveTitle,
    type LandedMessageDraft,
    planParts,
    type TodoItem,
    type UnfinishedWork,
} from "@intentic/sandbox-contract";
import { isFailureSentence, isSelfIdentityAnswer, isToolCallStandIn } from "../../agent/providers/failure-sentences.js";
import { opt } from "../../agent/run/opt.js";
import { subagentCountsOf } from "../../agent/subagents/subagents.js";
import { MAX_NOTE_LENGTH, MAX_SUBJECT_LENGTH } from "../../git/ops/commit-message.js";
import { watchProjection } from "../../agent/verification/watch-state.js";
import { loopProjection } from "../../loops/loop-state.js";
import { workflowProjection } from "../../workflows/workflow-state.js";
import { recordConversationPrompt, recordPrompt } from "../../sessions/transcript-search.js";
import { type AgentsStore, type AgentTitleSource, type Composition, isIsolated, landedMessageOf, type PersistedAgent } from "./agents-store.js";
import type { LandOutcome } from "../land/land.js";
import type { LandedPresences } from "../land/landed-presence.js";
import type { LandStanding, LandStandings } from "../land/standing.js";

// Runtime half of the fleet registry: the in-memory entry list (loaded once, write-through on persisted mutations) plus
// per-conversation turn state built from AgentEvent frames. Every card-visible change broadcasts the full roster as a
// snapshot, never a diff (system.routes relays it onto /events).

const MAX_TITLE_LENGTH = 80;
// Long enough for a provider's own explanation; short enough that a stack trace or error page can't ride into the
// roster.
const MAX_FAILURE_LENGTH = 400;
// One bounded line, no newlines: read in a card's width and a run's row, and a newline would break both. Empty
// collapses to `undefined`.
const sanitizeFailure = (message: string): string | undefined => {
    const clean = message.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_FAILURE_LENGTH);
    return clean === "" ? undefined : clean;
};
// Numeric so promoteTitle's comparison is one `<=`; an entry with no source reads as `derived`, replaceable by
// anything.
const TITLE_RANK: Record<AgentTitleSource, number> = { derived: 0, model: 1, plan: 2, user: 3 };
// Collapses control characters and whitespace to single spaces and cuts to `limit`. A parameter, not a constant, since
// a title's card width and a changelog sentence's length must not share one ceiling.
const sanitizeLine = (text: string, limit: number): string | undefined => {
    const clean = text
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, limit);
    return clean === "" ? undefined : clean;
};

const sanitizeTitle = (prompt: string): string | undefined => sanitizeLine(prompt, MAX_TITLE_LENGTH);

// A provider's failure sentence or a tool-call stand-in; never written as a name except by an explicit rename, and a
// stored one forfeits its rank so the next honest title replaces it.
const cannotBeAName = (title: string): boolean => isFailureSentence(title) || isToolCallStandIn(title) || isSelfIdentityAnswer(title);

// One-line scrub on its own limit (MAX_NOTE_LENGTH), never the title's 80-character card width: sharing that ceiling
// once truncated changelog entries mid-word. A backstop; the drafter clips on a word boundary before this is reached.
const sanitizeNote = (note: string): string | undefined => sanitizeLine(note, MAX_NOTE_LENGTH);

// A commit subject's own limit (MAX_SUBJECT_LENGTH, git's header max), never the title's 80-character card width. A
// backstop; the drafter clips on a word boundary before this is reached.
const sanitizeSubject = (subject: string): string | undefined => sanitizeLine(subject, MAX_SUBJECT_LENGTH);

// A drafted message is only a subject and, for a repo with a changelog, its notes; no other text needs scrubbing here.

interface RuntimeState {
    running: boolean;
    // Cards parked right now, keyed by requestId; concurrent pauses are possible, and each is released only by its own
    // `resolved` frame.
    pauses: Map<string, "plan" | "question" | "permission" | "browser_help" | "terminal_help" | "capability_offer" | "credential_offer">;
    errored: boolean;
    // Sentence from the last error frame, flushed at finish; a turn failing twice died of the second.
    failure: string | undefined;
    // The failure's code, plus what a spent allowance alone carries: when the window reopens, and whether the turn is
    // held for a rerun. Read off the frame, not looked up, so the client and the card agree by construction.
    failureCode: string | undefined;
    limitResetsAt: number | undefined;
    limitHeld: boolean;
    limitScheduled: boolean;
    // Where a booked move is taking the held turn, while it is booked.
    limitMoving: string | undefined;
    // Set the instant a stop/dismiss lands, while the turn is still unwinding; publishing plain `running` here is what
    // let a killed turn keep spinning. `finish` reads which flavor to pick the terminal status.
    stopping: "stopped" | "dismissed" | undefined;
    // A turn the daemon is already recovering (a remint, an outage wait) and will re-run on its own; the one flag that
    // survives `finish`. Cleared by the resumed turn's own `begin`, or by `abandonResume` if the recovery fails.
    resuming: boolean;
    // A land lease is held (withLandLease): the worktree is being rebased and carried into the tree. Outlives `finish`
    // too, since a manual land finishes the card while still holding it.
    landing: boolean;
    activity: { tool?: string; target?: string; todo?: string } | undefined;
    contextTokens: number | undefined;
    contextWindow: number | undefined;
    startedAt: number | undefined;
    lastAt: number | undefined;
    // This turn's prompt, held until a session id exists to file it under; cleared once filed.
    pendingPrompt: string | undefined;
    // Frame-carried fields, flushed into the entry once at finish rather than per frame.
    pendingSessionId: string | undefined;
    pendingCostUsd: number;
    pendingInputTokens: number;
    pendingOutputTokens: number;
    pendingToolUses: number;
    // Children started so far, flushed once at finish; the card counts them live via summaryOf.
    pendingSubagents: number;
    // The agent's own checklist, whole, as of the last `todos` frame; only `finish` reads it. `undefined` means this
    // process has not seen the list yet, which is not the same as an empty one.
    checklist: readonly TodoItem[] | undefined;
    // How the end-of-turn check went, last run wins. Recorded here too since the land consumes and clears
    // turn-checks.ts before `finish` runs; unlike the checklist, a verdict is not carried into the next turn.
    check: { label: string; failed: boolean } | undefined;
}

const freshRuntime = (): RuntimeState => ({
    running: false,
    pauses: new Map(),
    errored: false,
    failure: undefined,
    failureCode: undefined,
    limitResetsAt: undefined,
    limitHeld: false,
    limitScheduled: false,
    limitMoving: undefined,
    stopping: undefined,
    resuming: false,
    landing: false,
    activity: undefined,
    contextTokens: undefined,
    contextWindow: undefined,
    startedAt: undefined,
    lastAt: undefined,
    pendingPrompt: undefined,
    pendingSessionId: undefined,
    pendingCostUsd: 0,
    pendingInputTokens: 0,
    pendingOutputTokens: 0,
    pendingToolUses: 0,
    pendingSubagents: 0,
    checklist: undefined,
    check: undefined,
});

// The frame's own verdict decides, not the code, except a rate limit: its reopening can be hours away, so treating it
// as work in progress would hide the one fact, when, that matters. Recorded as a failure instead.
const comingBackNow = (event: Extract<AgentEvent, { kind: "error" }>): boolean => event.autoResume === "scheduled" && event.code !== "rate_limit";

// All four failure fields are written together from one frame, so a later refusal can't leave a stale code or countdown
// behind from an earlier one. Read off the frame, not looked up, so the client and the card agree by construction.
const failureOf = (
    event: Extract<AgentEvent, { kind: "error" }>,
): Pick<RuntimeState, "failure" | "failureCode" | "limitResetsAt" | "limitHeld" | "limitScheduled" | "limitMoving"> => {
    const limit = event.code === "rate_limit";
    return {
        failure: sanitizeFailure(event.message),
        failureCode: event.code,
        limitResetsAt: limit ? event.resetsAt : undefined,
        limitHeld: limit && event.held !== undefined,
        // The daemon's own verdict for this failure; the firing pass reads the same value, so the card and the schedule
        // agree.
        limitScheduled: limit && event.autoResume === "scheduled",
        limitMoving: limit ? event.held?.moving : undefined,
    };
};

// What a turn left open, read at finish from only what it measured, no model asked, nothing self-reported: a missing
// checklist means this process has not seen it yet, a missing check means it was not re-run.
const openSteps = (list: readonly TodoItem[]): UnfinishedWork["steps"] => {
    const open = list.filter((item) => item.status !== "completed");
    if (open.length === 0) {
        return undefined;
    }
    // What it would pick up next: the one already in progress, else the first still waiting.
    const next = (open.find((item) => item.status === "in_progress") ?? open[0])?.content;
    return { open: open.length, total: list.length, ...(next !== undefined ? { next } : {}) };
};

// The check's verdict, only when it ran and failed; passed, cancelled, or never run leaves nothing.
const failedCheck = (state: RuntimeState | undefined): string | undefined => (state?.check?.failed === true ? state.check.label : undefined);

// The moment of measurement, not of the write: a finish that observed neither the list nor a check learned nothing new,
// and stamping `now` there would restart the age of an old abandonment.
const leftAt = (entry: PersistedAgent, state: RuntimeState | undefined, now: number): number =>
    state?.checklist === undefined && state?.check === undefined ? (entry.unfinished?.at ?? now) : now;

const unfinishedOf = (entry: PersistedAgent, state: RuntimeState | undefined, now: number): UnfinishedWork | undefined => {
    // Observed this turn, else whatever the last finish that did observe it wrote.
    const steps = state?.checklist === undefined ? entry.unfinished?.steps : openSteps(state.checklist);
    const check = failedCheck(state);
    if (steps === undefined && check === undefined) {
        return undefined;
    }
    return { at: leftAt(entry, state, now), ...(steps !== undefined ? { steps } : {}), ...(check !== undefined ? { check } : {}) };
};

// The failure fields, only while the card still reads as `error`; once the standing has moved on, they would describe a
// turn the board no longer shows as the last word.
const reportedFailure = (
    entry: PersistedAgent,
    status: AgentStatus,
): Partial<Pick<AgentSummary, "failure" | "failureCode" | "limitResetsAt" | "limitHeld" | "limitScheduled" | "limitMoving">> =>
    status !== "error"
        ? {}
        : {
              ...(entry.failure !== undefined ? { failure: entry.failure } : {}),
              ...(entry.failureCode !== undefined ? { failureCode: entry.failureCode } : {}),
              ...(entry.limitResetsAt !== undefined ? { limitResetsAt: entry.limitResetsAt } : {}),
              ...(entry.limitHeld === true ? { limitHeld: true } : {}),
              ...(entry.limitScheduled === true ? { limitScheduled: true } : {}),
              ...(entry.limitMoving !== undefined ? { limitMoving: entry.limitMoving } : {}),
          };

// The four per-conversation overrides of a sandbox-wide default (absent means inherit), projected together since the
// card's menu and the chat's offers read them together.
const postures = (entry: PersistedAgent): Partial<Pick<AgentSummary, "autoLand" | "resumeAfterOutage" | "resumeAfterLimit" | "moveAfterLimit">> => ({
    ...(entry.autoLand !== undefined ? { autoLand: entry.autoLand } : {}),
    ...(entry.resumeAfterOutage !== undefined ? { resumeAfterOutage: entry.resumeAfterOutage } : {}),
    ...(entry.resumeAfterLimit !== undefined ? { resumeAfterLimit: entry.resumeAfterLimit } : {}),
    ...(entry.moveAfterLimit !== undefined ? { moveAfterLimit: entry.moveAfterLimit } : {}),
});

// What the entry says the last turn left open, except while a turn is running, where it would be noise on a card
// already working through that very list.
const reportedUnfinished = (entry: PersistedAgent, state: RuntimeState | undefined): Partial<Pick<AgentSummary, "unfinished">> =>
    state?.running === true ? {} : opt("unfinished", entry.unfinished);

// The failure fields a finish writes, all four or none, so a clean turn's `{}` clears any wall a previous turn left on
// the card.
const endedFailure = (
    state: RuntimeState | undefined,
): Partial<Pick<PersistedAgent, "failure" | "failureCode" | "limitResetsAt" | "limitHeld" | "limitScheduled" | "limitMoving">> =>
    state?.errored !== true
        ? {}
        : {
              ...(state.failure !== undefined ? { failure: state.failure } : {}),
              ...(state.failureCode !== undefined ? { failureCode: state.failureCode } : {}),
              ...(state.limitResetsAt !== undefined ? { limitResetsAt: state.limitResetsAt } : {}),
              ...(state.limitHeld ? { limitHeld: true } : {}),
              ...(state.limitScheduled ? { limitScheduled: true } : {}),
              ...(state.limitMoving !== undefined ? { limitMoving: state.limitMoving } : {}),
          };

// The live turn's word: a chosen ending outranks a park.
const liveStatus = (state: RuntimeState, parked: readonly string[]): AgentStatus => {
    if (state.stopping !== undefined) {
        return state.stopping === "dismissed" ? "dismissing" : "stopping";
    }
    return parked.length > 0 ? "awaiting" : "running";
};

// Status precedence: the live turn, then an armed resume, then a held land lease, then how the last turn ended, then
// the land standing; only `idle` yields to the standing. A running turn's own end-of-turn land stays `running`: the
// lease reads as `landing` only between turns. Pure, so the rule is testable without a registry.
const statusOf = (
    state: RuntimeState | undefined,
    parked: readonly string[],
    entryStatus: PersistedAgent["status"],
    landing: LandStanding,
): AgentStatus => {
    if (state?.running === true) {
        return liveStatus(state, parked);
    }
    if (state?.resuming === true) {
        return "resuming";
    }
    if (state?.landing === true) {
        return "landing";
    }
    return entryStatus === "idle" ? landing : entryStatus;
};

// Session id and account move together: a session resumes only under the account that minted it. Taken from the frame,
// not the request; a frame naming none leaves the existing account alone rather than clearing it.
const sessionBinding = (
    entry: Pick<PersistedAgent, "sessionId" | "account"> | undefined,
    frame: { readonly sessionId: string; readonly account?: string | undefined },
): { readonly sessionId: string; readonly account?: string } | undefined => {
    // Entry gone (archived, purged) mid-turn: nothing to bind, and no next turn to read it.
    if (entry === undefined) {
        return undefined;
    }
    const account = frame.account ?? entry.account;
    const moved = entry.sessionId !== frame.sessionId || entry.account !== account;
    return moved ? { sessionId: frame.sessionId, ...(account !== undefined ? { account } : {}) } : undefined;
};

// The fields `begin` records for a turn. Placement (branch or not) is explicit here rather than inferred from the
// provider, since isolated and workspace conversations share the same identity and status lifecycle.
export type AgentTurnIdentity = Pick<AgentTurn, "prompt"> &
    Partial<Pick<AgentTurn, "title" | "model" | "effort" | "thinking" | "fast" | "tierHold" | "account" | "origin">> & {
        readonly conversationId: string;
        readonly isolated: boolean;
        // Latched like `isolated`; only a conversation never seen before takes the request's runner, and naming one
        // implies isolation.
        readonly runner?: string;
        readonly provider: NonNullable<AgentTurn["agent"]>;
        readonly harness: NonNullable<AgentTurn["harness"]>;
        // Who asked for this turn, as the daemon verified it; latched on the first one.
        readonly startedBy?: string;
    };

// Who asked for the conversation's first turn; an existing entry keeps its answer, latched the same way as `origin`.
const startedByOf = (existing: PersistedAgent | undefined, turn: AgentTurnIdentity): { readonly startedBy?: string } =>
    opt("startedBy", existing?.startedBy ?? turn.startedBy);

export interface AgentsRegistry {
    readonly init: () => Promise<void>;
    readonly ids: () => string[];
    // The board's roster, live agents only; archived ones are excluded here and from every broadcast.
    readonly list: () => AgentSummary[];
    // The archive, newest first; read on demand, never broadcast.
    readonly listArchived: () => AgentSummary[];
    readonly get: (id: string) => AgentSummary | undefined;
    // The persisted entry, including the per-repo bases diff and land need.
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly running: (id: string) => boolean;
    // Turns in flight per runner, what the scheduler divides free capacity by. Derived, not counted, so it cannot drift
    // from a decrement somebody forgot.
    readonly inFlightByRunner: () => Map<string, number>;
    // Narrower than `running`: excludes a turn parked on a question or permission card, since a park already counts as
    // quiet enough to rebase under. Not proof of stillness; a parallel tool call may still run.
    readonly writing: (id: string) => boolean;
    // SDK session ids of turns running right now, so the terminals list doesn't read a thinking agent's pane as
    // finished between commands. A not-yet-flushed entry falls back to the last turn's id.
    readonly liveSessionIds: () => string[];
    // Current session id, including a running first turn's, which the persisted entry alone would miss until finish.
    readonly sessionIdOf: (id: string) => string | undefined;
    // Acquires the turn mutex and marks it running. False: a turn is already running, or a rewind holds the same mutex.
    readonly begin: (turn: AgentTurnIdentity, now: number) => Promise<boolean>;
    // Holds the conversation against its own turns while a rewind restores files under a running turn. Shares one mutex
    // with `begin`, claimed synchronously; always released, even if `fn` throws.
    readonly withRewindLease: <T>(conversationId: string, fn: () => Promise<T>) => Promise<T | undefined>;
    // One land at a time per conversation, later ones queued in arrival order; held through the pre-land sync as well
    // as the land, since the sync rebases the very worktree the land reads. Claimed synchronously, so a request that
    // asks `landing` right after sees it; released once the last queued one settles, whether or not it threw.
    readonly withLandLease: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    // Whether a land lease is held or queued on right now; what a second press is refused against.
    readonly landing: (id: string) => boolean;
    // Writes what the checkout is (its repos, each with the main-line base) and, only when given, what it should carry
    // (`composition`); callers that merely rewrite repos keep the opening turn's decision.
    readonly recordWorktree: (id: string, repos: readonly PersistedAgent["repos"][number][], composition?: Composition) => Promise<void>;
    // Strips a deleted repo out of every composition, live and archived, since a frozen composition can't survive a
    // directory that no longer exists. Only the registry's half; agents/vanished-repos.ts decides the rest.
    readonly dropRepos: (repos: readonly string[]) => Promise<string[]>;
    // Records the complexity judge's verdict for the next turn's `afterHardTurn` signal. Not part of `begin` (the
    // daemon decides it after the request), and not broadcast, since nothing renders it.
    readonly recordTier: (id: string, tier: "fast" | "standard") => Promise<void>;
    // Sets the title per the source ranking (AgentTitleSourceSchema): a rename always lands, an automatic source only
    // moves it up. A rejected promotion still returns the entry's current summary, not `undefined`.
    readonly setTitle: (id: string, title: string, source: AgentTitleSource) => Promise<AgentSummary | undefined>;
    // Records what the landed work did, as a commit subject; no ranking, the newest land simply describes the most
    // current claim. Broadcast so the Changes panel picks it up immediately.
    readonly setLandedSubject: (id: string, draft: { subject: string; note?: string; breaking?: string }) => Promise<void>;
    // Publishes the live account of a landed message being drafted, as it changes; the wait is the one part of a land a
    // user watches. Runtime and broadcast only, never persisted; `undefined` withdraws it.
    readonly setLandedMessageDraft: (id: string, draft: LandedMessageDraft | undefined) => void;
    // Stamps the read marker; leaves `updatedAt` alone, since reading is not activity.
    readonly markSeen: (id: string, now: number) => Promise<AgentSummary | undefined>;
    // Set/clear the autoLand override (null inherits the sandbox setting); read at turn completion, so a mid-turn flip
    // holds only this turn's work.
    readonly setAutoLand: (id: string, autoLand: boolean | null) => Promise<AgentSummary | undefined>;
    // Same grammar as `setAutoLand`; read by the resume pass after the turn has already died, so arming it mid-unwind
    // is the ordinary case.
    readonly setResumeAfterOutage: (id: string, resumeAfterOutage: boolean | null) => Promise<AgentSummary | undefined>;
    // Same grammar again, for a fire that can be scheduled hours out: the press is often made on a card whose turn died
    // hours ago.
    readonly setResumeAfterLimit: (id: string, resumeAfterLimit: boolean | null) => Promise<AgentSummary | undefined>;
    // Third of the same grammar, for a spent allowance that moves accounts instead of waiting.
    readonly setMoveAfterLimit: (id: string, moveAfterLimit: boolean | null) => Promise<AgentSummary | undefined>;
    // Stamps a collaborator's ask to land; leaves `updatedAt` alone. Re-asking re-stamps rather than queuing; the land
    // or discard that answers it clears the ask.
    readonly requestLand: (id: string, by: { email: string; name?: string }, at: number) => Promise<AgentSummary | undefined>;
    // Drops the resumed-session pointer after a rewind restores files, so the next turn opens a fresh thread instead of
    // one describing edits no longer on disk. Only the pointer goes.
    readonly clearSession: (id: string) => Promise<void>;
    // Stamps every card's read marker at once, the board's one escape hatch for unread badges.
    readonly markAllSeen: (now: number) => Promise<void>;
    // Persists a land's outcome (advanced landedTips, diffstat, conflict report) as one unit, so the report cannot
    // drift from the tips it belongs to; an outcome with no conflicts clears the stored one.
    readonly recordLanded: (id: string, outcome: LandOutcome) => Promise<void>;
    // Records once that a landing is fully absorbed, instead of re-deriving it from git on every scan; the (landedHead,
    // landedTip) pair guards it. No broadcast: nothing visible changes.
    readonly markLandingAbsorbed: (id: string, repo: string, landedHead: string, landedTip: string, size: number) => Promise<void>;
    // Folds one frame into runtime state; broadcasts only when something card-visible changed.
    readonly observe: (id: string, event: AgentEvent) => void;
    // Records how the end-of-turn check went; last run wins, so a repaired tree passes. Kept here rather than read from
    // turn-checks.ts, since that store is consumed before `finish` runs.
    readonly noteCheck: (id: string, check: { label: string; failed: boolean }) => void;
    // Records a stop/dismiss the instant it lands, ahead of the seconds-long unwind, so the roster stops reading
    // `running` on a turn already ending. `finish` moves the card once, afterward.
    readonly stopping: (id: string, ending: "stopped" | "dismissed") => void;
    // Flushes pending usage and session, releases the mutex, and writes how the turn ended (error, stopped, or idle).
    // Says nothing about where the work now stands; that comes from standing.ts.
    readonly finish: (id: string, now: number) => Promise<void>;
    // Marks a resume as coming for the one path an error frame can't see: a restored card's placeholder turn settling
    // seconds before the real resumed turn begins. Cleared by that turn's own `begin`, or by `abandonResume`.
    readonly markResuming: (id: string) => void;
    // Ends a resume that is not coming, settling the card into the failure it was holding open, never back into a clean
    // `idle`. Answers whether the wait is over, not whether anything was written.
    readonly abandonResume: (id: string, now: number, reason: string) => Promise<boolean>;
    // Re-derives every live agent's land standing and publishes if any moved; called wherever the answer could have
    // changed outside the daemon. Cheap when nothing moved: one rev-parse per repo, no broadcast.
    readonly refreshStandings: () => Promise<void>;
    // Stamps/clears the archive marker; the caller must have already retired or restored the checkout
    // (agents/archive.ts owns that order).
    readonly setArchived: (ids: readonly string[], now: number) => Promise<void>;
    readonly clearArchived: (ids: readonly string[]) => Promise<void>;
    // Forgets agents outright. Takes a set rather than one id at a time, so a batch costs one persist and one
    // broadcast.
    readonly remove: (ids: readonly string[]) => Promise<void>;
    // Delivers an immediate snapshot on subscribe, tagged with the revision it was taken at, so a fresh connection
    // paints without waiting.
    readonly subscribe: (listener: (agents: AgentSummary[], rev: number) => void) => () => void;
    // Bumped on every broadcast, so a browser reconciling this stream against its own GET and optimistic writes can
    // tell which snapshot is newer. Resets to 0 on reboot; a fresh connection adopts the first roster it sees.
    readonly revision: () => number;
}

export const createAgentsRegistry = (store: AgentsStore, standings: LandStandings, presences: LandedPresences): AgentsRegistry => {
    let entries: PersistedAgent[] = [];
    const runtime = new Map<string, RuntimeState>();
    // The other half of the turn mutex: conversations a rewind is restoring. Kept outside `RuntimeState`, which is
    // rebuilt on every `begin`, so nothing here could accidentally clear the lease.
    const rewinding = new Set<string>();
    // Each conversation's land chain (the last queued land) and how many are held or queued on it.
    const landChains = new Map<string, Promise<unknown>>();
    const landQueued = new Map<string, number>();
    // Live account of each agent's commit message being drafted, kept outside `RuntimeState` since drafting starts
    // after the landing turn has already ended. A finished report stays until the next land replaces it.
    const messageDrafts = new Map<string, LandedMessageDraft>();
    const listeners = new Set<(agents: AgentSummary[], rev: number) => void>();
    // Bumped by `broadcast()`, once per published change; see `revision` on the interface.
    let revision = 0;

    const runtimeOf = (id: string): RuntimeState => {
        const existing = runtime.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const fresh = freshRuntime();
        runtime.set(id, fresh);
        return fresh;
    };

    const summaryOf = (entry: PersistedAgent): AgentSummary => {
        const state = runtime.get(entry.id);
        // A turn holding any unanswered card reads as `awaiting`, whatever else is in flight beside it.
        const parked = state === undefined ? [] : [...state.pauses.values()];
        const landing = entry.branch === undefined ? "idle" : standings.of(entry.id);
        const status = statusOf(state, parked, entry.status, landing);
        const base = (entry.repos.find((repo) => repo.repo === "root") ?? entry.repos[0])?.base.slice(0, 7);
        // Live totals: persisted amount plus the running turn's not-yet-flushed usage.
        const costUsd = entry.costUsd + (state?.pendingCostUsd ?? 0);
        const inputTokens = entry.inputTokens + (state?.pendingInputTokens ?? 0);
        const outputTokens = entry.outputTokens + (state?.pendingOutputTokens ?? 0);
        // Running count comes from the live subagent registry; the lifetime total comes from the entry, since the live
        // registry sweeps a finished child and forgets everything across a restart.
        const subagents = { running: subagentCountsOf(entry.id).running, total: (entry.subagents ?? 0) + (state?.pendingSubagents ?? 0) };
        const loop = loopProjection.of(entry.id);
        const workflow = workflowProjection.of(entry.id);
        // Empty means every watch has ended; turned into an absent field below, indistinguishable from never having
        // watched.
        const watches = watchProjection.of(entry.id);
        // Branch-backed agents only: a workspace conversation reaches main by typing in it, never by landing.
        const landedPresence = entry.branch === undefined ? undefined : presences.of(entry.id);
        const landedMessage = landedMessageOf(entry);
        return {
            id: entry.id,
            status,
            provider: entry.provider,
            harness: entry.harness,
            ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
            ...(entry.runner !== undefined ? { runner: entry.runner } : {}),
            updatedAt: Math.max(entry.updatedAt, state?.lastAt ?? 0),
            attention: {
                plan: parked.includes("plan"),
                question: parked.includes("question"),
                permission: parked.includes("permission"),
                capability: parked.includes("capability_offer"),
                // Its own lane, not folded into `permission`: the reader looking at the board often cannot be the one
                // who clears it.
                credential: parked.includes("credential_offer"),
                // Reads the derived verdict, not a stored status; a cached status here was the original bug's shape.
                conflict: status === "conflict",
            },
            ...reportedUnfinished(entry, state),
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
            ...reportedFailure(entry, status),
            ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
            ...opt("startedBy", entry.startedBy),
            ...(entry.forkedFrom !== undefined ? { forkedFrom: entry.forkedFrom } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
            ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
            ...(entry.fast !== undefined ? { fast: entry.fast } : {}),
            // `tier` and `tierHold`: what the composer's pre-send preview needs to judge a follow-up and restore the
            // user's toggle.
            ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
            ...(entry.tierHold !== undefined ? { tierHold: entry.tierHold } : {}),
            ...(entry.account !== undefined ? { account: entry.account } : {}),
            ...postures(entry),
            ...(entry.landRequested !== undefined ? { landRequested: entry.landRequested } : {}),
            ...(base !== undefined ? { base } : {}),
            ...(costUsd > 0 ? { costUsd } : {}),
            ...(inputTokens > 0 ? { inputTokens } : {}),
            ...(outputTokens > 0 ? { outputTokens } : {}),
            ...(state?.contextTokens !== undefined ? { contextTokens: state.contextTokens } : {}),
            ...(state?.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
            ...(state?.activity !== undefined ? { activity: state.activity } : {}),
            // Live account of the commit message being drafted; kept until the next land replaces it.
            ...(messageDrafts.has(entry.id) ? { landedMessageDraft: messageDrafts.get(entry.id) } : {}),
            // The finished sentence itself, the moment it exists; the Changes panel's 'From' chip reads it straight off
            // this frame instead of re-scanning the whole review to find it.
            ...(landedMessage === undefined ? {} : { landedMessage }),
            ...(state?.running === true && state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
            ...(entry.seenAt !== undefined ? { seenAt: entry.seenAt } : {}),
            ...(entry.archivedAt !== undefined ? { archivedAt: entry.archivedAt } : {}),
            ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
            // Live count: the running turn's tool calls show on the card as they happen.
            ...((entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) > 0 ? { toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0) } : {}),
            // Absent for agents that never delegated, so the chip appears on content, not as a column of zeros.
            ...(subagents.total > 0 ? { subagents } : {}),
            ...(entry.diffFiles !== undefined
                ? { diff: { files: entry.diffFiles, insertions: entry.diffInsertions ?? 0, deletions: entry.diffDeletions ?? 0 } }
                : {}),
            // Present only when some of what this agent landed is no longer in the tree; absence says nothing.
            ...(landedPresence !== undefined ? { landedPresence } : {}),
            // Read off the loop pump's own live state; one projection, no second copy to drift.
            ...(loop !== undefined ? { loop } : {}),
            ...(workflow !== undefined ? { workflow } : {}),
            // An empty list would still have to be read before dismissal; turned absent instead when nothing is
            // watching.
            ...(watches !== undefined && watches.length > 0 ? { watches: [...watches] } : {}),
        };
    };

    const list = (): AgentSummary[] => entries.filter((entry) => entry.archivedAt === undefined).map(summaryOf);

    // Bumped once per broadcast, before the fan-out, so every listener sees the same revision and a route reading
    // `revision()` right after gets the one its own change produced.
    const broadcast = (): void => {
        const agents = list();
        revision += 1;
        for (const listener of listeners) {
            listener(agents, revision);
        }
    };

    // Loop/workflow state can change between turns, with no frame to announce it; without this hook the card would show
    // a stale step until some unrelated broadcast moved the fleet. Never unsubscribed.
    loopProjection.onChange(broadcast);
    workflowProjection.onChange(broadcast);
    // Every watch transition happens between turns (armed as one ends, resolved hours later); without this, a card
    // would keep showing a condition met hours ago until an unrelated broadcast came along.
    watchProjection.onChange(broadcast);

    // Two independent, best-effort readings (standing, landed presence) run together rather than chained, and must
    // never throw: this runs inside `finish`'s `finally`. `allSettled`, so a failing half costs only its own reading.
    const reprobe = async (): Promise<boolean> => {
        const live = entries.filter(isIsolated).filter((entry) => entry.archivedAt === undefined);
        const probes = await Promise.allSettled([standings.refresh(live), presences.refresh(live)]);
        return probes.some((probe) => probe.status === "fulfilled" && probe.value);
    };

    // Chained, not fire-and-forget: `entries` is replaced wholesale on every write, so two overlapping persists would
    // each serialize a stale snapshot. `.then(save, save)` keeps a rejected write from poisoning the queue.
    let writes: Promise<unknown> = Promise.resolve();
    // The one place the title-rank comparison is applied, so every caller agrees on who may rename what. A rename
    // always lands, even a second one; anything else must strictly outrank what's there.
    const promoteTitle = (id: string, title: string | undefined, source: AgentTitleSource): boolean => {
        const entry = entryOf(id);
        const clean = title === undefined ? undefined : sanitizeTitle(title);
        if (entry === undefined || clean === undefined) {
            return false;
        }
        // A failure sentence or tool-call stand-in is never a name, however it arrived; refused here, and a stored one
        // loses its rank (see cannotBeAName).
        if (source !== "user" && cannotBeAName(clean)) {
            return false;
        }
        const currentRank = entry.title !== undefined && cannotBeAName(entry.title) ? -1 : TITLE_RANK[entry.titleSource ?? "derived"];
        if (source !== "user" && TITLE_RANK[source] <= currentRank) {
            return false;
        }
        if (entry.title === clean && entry.titleSource === source) {
            return false;
        }
        replace({ ...entry, title: clean, titleSource: source });
        return true;
    };

    const persist = (): Promise<void> => {
        const next = writes.then(
            () => store.save(entries),
            () => store.save(entries),
        );
        writes = next.catch(() => undefined);
        return next;
    };

    const entryOf = (id: string): PersistedAgent | undefined => entries.find((entry) => entry.id === id);

    const replace = (next: PersistedAgent): void => {
        entries = [...entries.filter((entry) => entry.id !== next.id), next];
    };

    return {
        init: async () => {
            // `limitHeld` names a turn waiting in this process's memory for a re-run press; a fresh daemon holds none,
            // whatever the file says, so it is stripped on load.
            entries = (await store.load()).map(({ limitHeld: _held, limitScheduled: _booked, limitMoving: _moving, ...carried }) => carried);
            // Broadcasts immediately on load, before standings are probed, since a fresh boot's verdict cache is empty
            // and probing first would hold the whole boot behind a git spawn per live agent.
            broadcast();
            void reprobe()
                .then((moved) => {
                    if (moved) {
                        broadcast();
                    }
                })
                .catch(() => undefined);
        },
        refreshStandings: async () => {
            if (await reprobe()) {
                broadcast();
            }
        },
        ids: () => entries.map((entry) => entry.id),
        list,
        listArchived: () =>
            entries
                .filter((entry) => entry.archivedAt !== undefined)
                .toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
                .map(summaryOf),
        get: (id) => {
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        entry: entryOf,
        running: (id) => runtime.get(id)?.running === true,
        inFlightByRunner: () => {
            const counts = new Map<string, number>();
            for (const [id, state] of runtime) {
                const runner = entryOf(id)?.runner;
                if (state.running && runner !== undefined) {
                    counts.set(runner, (counts.get(runner) ?? 0) + 1);
                }
            }
            return counts;
        },
        writing: (id) => {
            const state = runtime.get(id);
            return state?.running === true && state.stopping === undefined && state.pauses.size === 0;
        },
        sessionIdOf: (id) => runtime.get(id)?.pendingSessionId ?? entryOf(id)?.sessionId,
        liveSessionIds: () =>
            [...runtime]
                .filter(([, state]) => state.running)
                .flatMap(([id, state]) => {
                    const sessionId = state.pendingSessionId ?? entryOf(id)?.sessionId;
                    return sessionId === undefined ? [] : [sessionId];
                }),
        landing: (id) => runtime.get(id)?.landing === true,
        withLandLease: async (id, fn) => {
            const state = runtimeOf(id);
            const ahead = landChains.get(id) ?? Promise.resolve();
            landQueued.set(id, (landQueued.get(id) ?? 0) + 1);
            if (!state.landing) {
                state.landing = true;
                broadcast();
            }
            // Queued behind whatever is ahead, whichever way that ended; `fn` takes no argument, so the settled value is
            // dropped.
            const turn = ahead.then(
                () => fn(),
                () => fn(),
            );
            landChains.set(
                id,
                turn.catch(() => undefined),
            );
            try {
                return await turn;
            } finally {
                const left = (landQueued.get(id) ?? 1) - 1;
                landQueued.set(id, left);
                if (left === 0) {
                    landQueued.delete(id);
                    landChains.delete(id);
                    state.landing = false;
                    broadcast();
                }
            }
        },
        withRewindLease: async (conversationId, fn) => {
            // The claim: `running` is read and `rewinding` is written with no `await` between them, one atomic step.
            // Adding an await here, however harmless it looks, reopens the race this function exists to close.
            if (runtime.get(conversationId)?.running === true) {
                return undefined;
            }
            rewinding.add(conversationId);
            try {
                return await fn();
            } finally {
                rewinding.delete(conversationId);
            }
        },
        begin: async (turn, now) => {
            // Both arms of the mutex, read together; everything through the `runtime.set` below is synchronous, a claim
            // rather than a hopeful check.
            if (runtime.get(turn.conversationId)?.running === true || rewinding.has(turn.conversationId)) {
                return false;
            }
            const existing = entryOf(turn.conversationId);
            // Placement latches with identity: an existing conversation keeps its workspace/worktree placement
            // regardless of what a stale request's `isolated` says.
            const isolated = existing === undefined ? turn.isolated : existing.branch !== undefined;
            // Runner latches the same way: it's part of the conversation's identity, and a remote conversation is
            // isolated by construction.
            const runner = existing === undefined ? turn.runner : existing.runner;
            // An authored title, a browser derivation, or a mid-turn rename all stand as written; a turn naming none is
            // titled the same way the browser would derive it.
            const title =
                existing?.title ?? (turn.title !== undefined ? sanitizeTitle(turn.title) : undefined) ?? sanitizeTitle(deriveTitle(turn.prompt));
            // Each setting falls back to the last turn's, so a caller naming none keeps describing the agent by what it
            // actually ran.
            const model = turn.model ?? existing?.model;
            const effort = turn.effort ?? existing?.effort;
            const thinking = turn.thinking ?? existing?.thinking;
            const fast = turn.fast ?? existing?.fast;
            const tierHold = turn.tierHold ?? existing?.tierHold;
            const account = turn.account ?? existing?.account;
            // Provenance belongs to the turn that created the conversation, never re-derived, so a user's own follow-up
            // can't strip the origin that opened it.
            const origin = existing?.origin ?? turn.origin;
            replace({
                id: turn.conversationId,
                ...(isolated || runner !== undefined ? { branch: existing?.branch ?? `agent/${turn.conversationId}` } : {}),
                ...(runner !== undefined ? { runner } : {}),
                provider: turn.provider,
                harness: turn.harness,
                repos: existing?.repos ?? [],
                // Resting state if this turn never reports back; `finish` overwrites it moments later in every ordinary
                // case, so only a daemon killed mid-turn ever sees it.
                status: "interrupted",
                costUsd: existing?.costUsd ?? 0,
                inputTokens: existing?.inputTokens ?? 0,
                outputTokens: existing?.outputTokens ?? 0,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                // Source rides with the title: a rebuilt entry keeps whatever promoted it, a fresh one starts at the
                // bottom of the ranking.
                ...(title !== undefined ? { title, titleSource: existing?.titleSource ?? "derived" } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(effort !== undefined ? { effort } : {}),
                ...(thinking !== undefined ? { thinking } : {}),
                ...(fast !== undefined ? { fast } : {}),
                ...(tierHold !== undefined ? { tierHold } : {}),
                // Carried, never taken from the turn; an explicit field list means omitting it here would reset the
                // tier every single turn.
                ...(existing?.tier !== undefined ? { tier: existing.tier } : {}),
                ...(account !== undefined ? { account } : {}),
                ...(origin !== undefined ? { origin } : {}),
                ...startedByOf(existing, turn),
                ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
                // Survives the rebuild; `updatedAt` moving past it is what makes the agent unread again, not clearing
                // this.
                ...(existing?.seenAt !== undefined ? { seenAt: existing.seenAt } : {}),
                // `archivedAt` is dropped: messaging an archived agent un-archives it, and `ensure()` re-attaches the
                // checkout. `autoLand` survives, as a standing choice about the conversation.
                ...(existing?.autoLand !== undefined ? { autoLand: existing.autoLand } : {}),
                // Survives for the same reason as the land posture: a standing choice the next turn is exactly when it
                // matters.
                ...(existing?.resumeAfterOutage !== undefined ? { resumeAfterOutage: existing.resumeAfterOutage } : {}),
                // Omission is deletion, and here it had teeth: only `recordLanded` may retire a conflict report, and
                // dropping it here retired one on the very follow-up turn meant to resolve it.
                ...(existing?.conflicts !== undefined ? { conflicts: existing.conflicts } : {}),
                ...(existing?.landRequested !== undefined ? { landRequested: existing.landRequested } : {}),
                // Survives the rebuild: it describes a claim on the main tree, not the turn that made it, and only a
                // commit retires it. Dropping it here was silent: a follow-up message would erase the drafted message.
                ...opt("landedSubject", existing?.landedSubject),
                ...opt("landedNote", existing?.landedNote),
                ...opt("landedBreaking", existing?.landedBreaking),
                // Lifetime counters and diffstat survive the rebuild.
                ...opt("turns", existing?.turns),
                ...opt("toolUses", existing?.toolUses),
                ...opt("subagents", existing?.subagents),
                ...opt("diffFiles", existing?.diffFiles),
                ...opt("diffInsertions", existing?.diffInsertions),
                ...opt("diffDeletions", existing?.diffDeletions),
                // Survives the rebuild for the same reason; the turn beginning here is often exactly about this work.
                // The fresh runtime state starts blank until the agent touches its list again.
                ...opt("unfinished", existing?.unfinished),
            });
            const state = freshRuntime();
            state.running = true;
            state.startedAt = now;
            state.lastAt = now;
            // Filed against the session immediately if one exists, else on the frame that mints it; a long turn is a
            // slow way for the transcript's own copy to arrive.
            if (existing?.sessionId !== undefined) {
                recordPrompt(existing.sessionId, turn.prompt);
            } else {
                state.pendingPrompt = turn.prompt;
            }
            runtime.set(turn.conversationId, state);
            recordConversationPrompt(turn.conversationId, turn.prompt);
            await persist();
            broadcast();
            return true;
        },
        recordWorktree: async (id, repos, composition) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            replace({ ...entry, repos: [...repos], ...(composition === undefined ? {} : { composition }) });
            await persist();
        },
        dropRepos: async (repos) => {
            const gone = new Set(repos);
            // Snapshotted before the first `replace` rebuilds `entries`; rows are copied, never mutated, since readers
            // keep the array they read.
            const touched = entries.filter((entry) => entry.repos.some(({ repo }) => gone.has(repo)));
            if (touched.length === 0) {
                return [];
            }
            for (const entry of touched) {
                replace({ ...entry, repos: entry.repos.filter(({ repo }) => !gone.has(repo)) });
            }
            // One persist and broadcast for the whole sweep; nothing on a card moves, but the roster should stop naming
            // a repo that's gone.
            await persist();
            broadcast();
            return touched.map((entry) => entry.id);
        },
        recordTier: async (id, tier) => {
            const entry = entryOf(id);
            // Entry gone mid-turn (archived, purged) is not worth surfacing; there is no next turn to read the value.
            if (entry === undefined || entry.tier === tier) {
                return;
            }
            replace({ ...entry, tier });
            await persist();
        },
        setTitle: async (id, title, source) => {
            if (entryOf(id) === undefined || sanitizeTitle(title) === undefined) {
                return undefined;
            }
            if (promoteTitle(id, title, source)) {
                await persist();
                broadcast();
            }
            const entry = entryOf(id);
            return entry === undefined ? undefined : summaryOf(entry);
        },
        setLandedSubject: async (id, draft) => {
            const entry = entryOf(id);
            const clean = sanitizeSubject(draft.subject);
            // Bounded to the subject's own ceiling, not the card's; an empty draft writes nothing rather than clearing
            // the last one.
            if (entry === undefined || clean === undefined) {
                return;
            }
            // Both notes clear when this land wrote none; they describe the claim as it now stands, not a leftover from
            // an earlier land.
            const cleanNote = draft.note === undefined ? undefined : sanitizeNote(draft.note);
            const cleanBreaking = draft.breaking === undefined ? undefined : sanitizeNote(draft.breaking);
            replace({
                ...entry,
                landedSubject: clean,
                ...(cleanNote === undefined ? { landedNote: undefined } : { landedNote: cleanNote }),
                ...(cleanBreaking === undefined ? { landedBreaking: undefined } : { landedBreaking: cleanBreaking }),
            });
            broadcast();
            await persist();
        },
        // The draft's whole story, re-sent complete on every beat, so a browser that missed one frame is merely late,
        // never wrong. Runtime only, never persisted.
        setLandedMessageDraft: (id, draft) => {
            if (entryOf(id) === undefined) {
                return;
            }
            if (draft === undefined) {
                if (!messageDrafts.delete(id)) {
                    return;
                }
            } else {
                messageDrafts.set(id, draft);
            }
            broadcast();
        },
        markSeen: async (id, now) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const next = { ...entry, seenAt: now };
            replace(next);
            await persist();
            // Broadcasts so the badge clears on every connected surface at once.
            broadcast();
            return summaryOf(next);
        },
        markAllSeen: async (now) => {
            entries = entries.map((entry) => ({ ...entry, seenAt: now }));
            await persist();
            broadcast();
        },
        setAutoLand: async (id, autoLand) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            // null strips the key entirely; absent is the inherit state, so the agent keeps following the sandbox
            // toggle.
            const { autoLand: _cleared, ...carried } = entry;
            const next = { ...carried, ...(autoLand !== null ? { autoLand } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        setResumeAfterOutage: async (id, resumeAfterOutage) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            // Same as `setAutoLand`: null strips the key, since absent is the only state that means inherit.
            const { resumeAfterOutage: _cleared, ...carried } = entry;
            const next = { ...carried, ...(resumeAfterOutage !== null ? { resumeAfterOutage } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        setResumeAfterLimit: async (id, resumeAfterLimit) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            // Same three states as its neighbors: on, off, or (absent) inherit.
            const { resumeAfterLimit: _cleared, ...carried } = entry;
            const next = { ...carried, ...(resumeAfterLimit !== null ? { resumeAfterLimit } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        setMoveAfterLimit: async (id, moveAfterLimit) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const { moveAfterLimit: _cleared, ...carried } = entry;
            const next = { ...carried, ...(moveAfterLimit !== null ? { moveAfterLimit } : {}) };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        requestLand: async (id, by, at) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return undefined;
            }
            const next = { ...entry, landRequested: { email: by.email, ...(by.name !== undefined ? { name: by.name } : {}), at } };
            replace(next);
            await persist();
            broadcast();
            return summaryOf(next);
        },
        clearSession: async (id) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            // Clears the runtime's pending id too, not just the persisted one; leaving either behind would let the next
            // turn resume through whichever half survived.
            const state = runtime.get(id);
            if (state !== undefined) {
                state.pendingSessionId = undefined;
            }
            const { sessionId: _dropped, ...carried } = entry;
            replace(carried);
            await persist();
            broadcast();
        },
        observe: (id, event) => {
            const state = runtimeOf(id);
            state.lastAt = Date.now();
            // Promoted here rather than inside the switch, so the `plan` case still falls through to the shared pause
            // registration below. Fire-and-forget, like the session write below.
            if (event.kind === "plan" && promoteTitle(id, planParts(event.text).title, "plan")) {
                void persist();
            }
            switch (event.kind) {
                case "session": {
                    state.pendingSessionId = event.sessionId;
                    // Written to the persisted entry immediately, not only held in memory until finish: a daemon killed
                    // mid-turn otherwise loses the only key into the provider's session store. Fire-and-forget.
                    // Written together with the session id (sessionBinding), so a reopened tab can tell if its next
                    // message resumes this thread.
                    const entry = entryOf(id);
                    const binding = sessionBinding(entry, event);
                    if (entry !== undefined && binding !== undefined) {
                        replace({ ...entry, ...binding });
                        void persist();
                    }
                    // Files the prompt that was waiting for this id, so the agent is findable by what started it, not
                    // just its latest message.
                    if (state.pendingPrompt !== undefined) {
                        recordPrompt(event.sessionId, state.pendingPrompt);
                        state.pendingPrompt = undefined;
                    }
                    return;
                }
                case "usage":
                    state.pendingCostUsd += event.costUsd ?? 0;
                    state.pendingInputTokens += event.inputTokens ?? 0;
                    state.pendingOutputTokens += event.outputTokens ?? 0;
                    break;
                case "context_usage":
                    state.contextTokens = event.tokens;
                    state.contextWindow = event.contextWindow;
                    break;
                case "plan":
                case "question":
                case "permission":
                case "browser_help":
                case "terminal_help":
                case "capability_offer":
                case "credential_offer":
                    // A turn being torn down cannot park on anything; a card raised behind the stop would ask a
                    // question with nowhere to go.
                    if (state.stopping) {
                        return;
                    }
                    state.pauses.set(event.requestId, event.kind);
                    break;
                case "resolved":
                    // Nothing to release means nothing to publish; a daemon restarted mid-park never saw the card go
                    // up.
                    if (!state.pauses.delete(event.requestId)) {
                        return;
                    }
                    break;
                case "tool_call":
                    state.pendingToolUses += 1;
                    state.activity = {
                        tool: event.name,
                        ...(event.target !== undefined ? { target: event.target } : {}),
                        ...(state.activity?.todo !== undefined ? { todo: state.activity.todo } : {}),
                    };
                    break;
                case "todos": {
                    const current = event.items.find((item) => item.status === "in_progress")?.content;
                    state.activity = { ...state.activity, ...(current !== undefined ? { todo: current } : {}) };
                    // Kept whole for `finish`: every `todos` frame carries the complete list, never a patch, so the
                    // last one is the final word.
                    state.checklist = event.items;
                    break;
                }
                // The lifetime count is taken only at birth; the live registry sweeps a settled child and forgets it.
                // Flushed at finish like tool calls; an update publishes only with a status change.
                case "subagent":
                    state.pendingSubagents += 1;
                    break;
                // Filed on the entry so the next turn's plan can restate what a compaction summarized away; written
                // once per turn even if it compacts repeatedly. Fire-and-forget, no broadcast.
                case "compact": {
                    const compacted = entryOf(id);
                    const at = compacted?.turns ?? 0;
                    if (compacted !== undefined && compacted.compactedTurn !== at) {
                        replace({ ...compacted, compactedTurn: at });
                        void persist();
                    }
                    return;
                }
                case "subagent_update":
                    if (event.status === undefined) {
                        return;
                    }
                    break;
                case "error":
                    // A scheduled resume is not how the turn ended; it must still read as work in progress. Keyed on
                    // the frame's own verdict; `available` is not covered, nothing is armed.
                    if (comingBackNow(event)) {
                        state.resuming = true;
                        return;
                    }
                    state.errored = true;
                    Object.assign(state, failureOf(event));
                    break;
                default:
                    return; // delta/thinking etc: not card-visible, skip the broadcast.
            }
            broadcast();
        },
        stopping: (id, ending) => {
            const state = runtime.get(id);
            // Nothing running means nothing to say; marking an already-settled conversation would leak `stopping` onto
            // its next turn.
            if (state === undefined || !state.running || state.stopping !== undefined) {
                return;
            }
            state.stopping = ending;
            // Clears every parked card here, before finish, since a `resolved` frame may never make it out of a dying
            // stream.
            state.pauses.clear();
            // Published for both endings, since the roster now names which lane the card is heading for. A shared value
            // used to make a dismissal read as work in progress for the blink before `finish` landed.
            broadcast();
        },
        noteCheck: (id, check) => {
            // `runtimeOf`, not `get`: a check only runs inside a live turn, and a verdict with nowhere to land would
            // report nothing.
            runtimeOf(id).check = check;
        },
        finish: async (id, now) => {
            const entry = entryOf(id);
            const state = runtime.get(id);
            // Captured before the reset; a manual land finishes outside any turn and must not inflate `turns`.
            const ranTurn = state?.running === true;
            // Captured for the same reason: a manual land's finish has no runtime state and chose no ending.
            const ended = state?.stopping;
            if (state !== undefined) {
                state.running = false;
                state.stopping = undefined;
                // A turn that ended holds nobody up, however it ended; an aborted waiter is already settled.
                state.pauses.clear();
                state.startedAt = undefined;
                // Deliberately not reset here, unlike the rest of this state: it says this ending isn't one.
            }
            // Tolerates a missing runtime state: a manual land finishes outside any turn and must still write the
            // status.
            if (entry !== undefined) {
                const sessionId = state?.pendingSessionId ?? entry.sessionId;
                // Dropped and re-added only under the status this finish decides; an explanation it did not write would
                // describe a death no longer being reported.
                const {
                    failure: _ended,
                    failureCode: _coded,
                    limitResetsAt: _reopens,
                    limitHeld: _held,
                    limitScheduled: _booked,
                    limitMoving: _moving,
                    // Dropped for the same reason; `unfinishedOf` itself carries forward whatever is still true.
                    unfinished: _open,
                    ...carried
                } = entry;
                replace({
                    ...carried,
                    // The one field here that can be true even of a turn that ended perfectly cleanly.
                    ...opt("unfinished", unfinishedOf(entry, state, now)),
                    // How the turn ended: an error, the user's stop, or the clean ending that hands off to standing.ts.
                    // A dismissal takes the clean ending too, settling with the finished ones.
                    status: state?.errored === true ? "error" : ended === "stopped" ? "stopped" : "idle",
                    ...endedFailure(state),
                    costUsd: entry.costUsd + (state?.pendingCostUsd ?? 0),
                    inputTokens: entry.inputTokens + (state?.pendingInputTokens ?? 0),
                    outputTokens: entry.outputTokens + (state?.pendingOutputTokens ?? 0),
                    turns: (entry.turns ?? 0) + (ranTurn ? 1 : 0),
                    toolUses: (entry.toolUses ?? 0) + (state?.pendingToolUses ?? 0),
                    subagents: (entry.subagents ?? 0) + (state?.pendingSubagents ?? 0),
                    updatedAt: now,
                    ...(sessionId !== undefined ? { sessionId } : {}),
                });
                if (state !== undefined) {
                    state.pendingCostUsd = 0;
                    state.pendingInputTokens = 0;
                    state.pendingOutputTokens = 0;
                    state.pendingToolUses = 0;
                    state.pendingSubagents = 0;
                    state.pendingSessionId = undefined;
                    state.errored = false;
                    state.failure = undefined;
                    state.failureCode = undefined;
                    state.limitResetsAt = undefined;
                    state.limitHeld = false;
                    state.limitScheduled = false;
                    // Spent with the turn that earned it; the checklist beside it is left alone, being the harness's
                    // own state.
                    state.check = undefined;
                }
                await persist();
            }
            // Re-derives before the roster goes out, so the settling card carries the new standing, not the one from
            // before this turn.
            await reprobe();
            broadcast();
        },
        markResuming: (id) => {
            // `runtimeOf`, not `get`: this only has to exist before the placeholder's own finish resets everything
            // else.
            runtimeOf(id).resuming = true;
        },
        abandonResume: async (id, now, reason) => {
            const entry = entryOf(id);
            const state = runtime.get(id);
            // Still unwinding; its own `finish` is about to overwrite anything written here.
            if (state?.running === true) {
                return false;
            }
            // Nothing left to end: a fresh `begin` already cleared the wait, or the entry is gone.
            if (entry === undefined || state?.resuming !== true) {
                return true;
            }
            state.resuming = false;
            const failure = sanitizeFailure(reason);
            // The daemon's own sentence about a resume that never came; the original failure's classification is
            // dropped with it.
            const { failureCode: _coded, limitResetsAt: _reopens, limitHeld: _held, limitScheduled: _booked, ...carried } = entry;
            replace({ ...carried, status: "error", ...(failure !== undefined ? { failure } : {}), updatedAt: now });
            await persist();
            broadcast();
            return true;
        },
        recordLanded: async (id, outcome) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            // A land answers any pending ask too; letting it outlive the land would read as a second, phantom ask.
            const { conflicts: cleared, landRequested: _answered, ...carried } = entry;
            // Only a verdict may replace a verdict: a measure land touches no conflict gate and reports none, so it
            // carries the stored report across rather than reading silence as resolved.
            const verdict = outcome.adjudicated ? outcome.conflicts : (outcome.conflicts ?? cleared);
            replace({
                ...carried,
                repos: [...outcome.repos],
                diffFiles: outcome.diff.files,
                diffInsertions: outcome.diff.insertions,
                diffDeletions: outcome.diff.deletions,
                ...(verdict !== undefined ? { conflicts: [...verdict] } : {}),
            });
            await persist();
            // landedTips just moved, half of what every standing is measured against.
            await reprobe();
            broadcast();
        },
        markLandingAbsorbed: async (id, repo, landedHead, landedTip, size) => {
            const entry = entryOf(id);
            if (entry === undefined) {
                return;
            }
            const row = entry.repos.find((composed) => composed.repo === repo);
            // Only the exact landing the caller measured; a newer land's fresh shas, or an already-marked row, are left
            // alone.
            if (row === undefined || row.landedHead !== landedHead || row.landedTip !== landedTip || row.absorbed !== undefined) {
                return;
            }
            // Copy-on-write: the array is shared with readers already holding it, so the row is replaced, not mutated.
            const repos = [...entry.repos];
            repos[entry.repos.indexOf(row)] = { ...row, absorbed: size };
            replace({ ...entry, repos });
            await persist();
        },
        setArchived: async (ids, now) => {
            const targets = new Set(ids);
            entries = entries.map((entry) => (targets.has(entry.id) ? { ...entry, archivedAt: now } : entry));
            await persist();
            // Excluding them from this broadcast's roster is how every connected surface learns the cards left the
            // board.
            broadcast();
        },
        clearArchived: async (ids) => {
            const targets = new Set(ids);
            entries = entries.map((entry) => {
                if (!targets.has(entry.id)) {
                    return entry;
                }
                const { archivedAt: _archived, ...live } = entry;
                return live;
            });
            await persist();
            broadcast();
        },
        remove: async (ids) => {
            const targets = new Set(ids);
            entries = entries.filter((entry) => !targets.has(entry.id));
            for (const id of targets) {
                runtime.delete(id);
            }
            standings.forget(ids);
            presences.forget(ids);
            loopProjection.forget(ids);
            workflowProjection.forget(ids);
            // Forgets the projection only; disarming the watch timers themselves is the caller's job
            // (agent/watchers.ts), to avoid a dependency cycle back into this module.
            await persist();
            broadcast();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            // Carries the current revision without bumping it; subscribing is not a change, and a bumped one would look
            // newer than already-applied rosters.
            listener(list(), revision);
            return () => listeners.delete(listener);
        },
        revision: () => revision,
    };
};
