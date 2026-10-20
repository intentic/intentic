import {
    type AgentAttention,
    type AgentJob,
    type AgentStatus,
    type AgentWatch,
    awaitsWake,
    type LandConflictReason,
    type LandFailure,
} from "../schemas/agents.js";
import { type AgentNext, goesBySelf } from "../schemas/agent-next.js";

// (2026-10-16) Moved here from the editor (_editor/web/src/models/agent-status/agentStatus-standing.ts, which re-exports
// it), so the daemon counts what needs the person by the very rules the board draws with (models/agent-lanes.ts): the
// desktop app's status bar asks the daemon (`agents.attention`), and the board and the bar must never disagree.

// Every projection of a fleet agent's state (lane, attention label, drill-in verb, glyphs). Nothing else may
// derive these from `status` alone: a parked turn is `idle` with an attention flag raised. Pure functions over
// plain data, no store, no Vue.

// Four standings a conversation gets when the daemon has not registered it. `draft`: not sent yet. `starting`:
// sent but not yet filed as an agent. `failed`: send refused, never became an agent. `resumed`: a past conversation
// reopened from History with no surviving registry entry. All four have no registry entry, so nothing to archive,
// review, land or drop (`unregistered` below). None may be widened into `AgentStatus`: that enum is only the
// daemon's account of agents it has.
export type ClientAgentStatus = "draft" | "starting" | "failed" | "resumed";

// Enough of an agent to place one; every predicate below takes only this, so a FleetAgent, a roster AgentSummary,
// or a test literal can all answer the same question. Each optional field also takes `undefined`, as the contract's own
// AgentSummary spells it, so the daemon (strict about the difference) hands its roster over as it is.
export interface AgentStanding {
    readonly status: AgentStatus | ClientAgentStatus;
    readonly attention: AgentAttention;
    // Outside conditions this conversation is parked on (AgentSummary.watches); `laneOf` reads it alongside `status`
    // and `attention`. Absent for nearly every conversation.
    readonly watches?: readonly AgentWatch[] | undefined;
    // Whether it runs again by itself (AgentSummary.awaitingWake): the daemon's one reading, which `watching` asks.
    readonly awaitingWake?: boolean | undefined;
    // The commands it left running and how the recent ones ended (AgentSummary.jobs); `heldByPrompt` reads which of its
    // watches a job at a prompt holds. Absent for nearly every conversation.
    readonly jobs?: readonly AgentJob[] | undefined;
    // Why a refused land is still refusing (AgentSummary.conflictCauses), which decides whose press can clear it.
    // Absent for every card but one refusing to merge.
    readonly conflictCauses?: readonly LandConflictReason[] | undefined;
    // Which kind of failure ended the last turn. `status: "error"` alone conflates a broken harness with a spent
    // allowance; both belong in Attention, but this says which so the card can tell them apart. `laneOf` reads it too,
    // so the lane, badge and chip stay in agreement.
    readonly failureCode?: string | undefined;
    // The words that turn died on (AgentSummary.failure), cleared with the code when it runs again.
    readonly failure?: string | undefined;
    // Whether those words are the sandbox's own sentence (AgentSummary.failureOwn): what a card may lead with.
    readonly failureOwn?: boolean | undefined;
    /** When the spent allowance reopens, in epoch SECONDS (the wire's unit). Absent when nobody published one. */
    readonly limitResetsAt?: number | undefined;
    /** Whether the refused turn is held whole, so a press re-runs it rather than sending a new message after it. */
    readonly limitHeld?: boolean | undefined;
    // What carries it on with nobody pressing anything, and when (AgentSummary.next): the daemon's one reading, which
    // every lane, chip and corner below asks, never the hold, the queue or an answer it was derived from.
    readonly next?: AgentNext | undefined;
    // A land that broke (AgentSummary.landFailure), standing until one goes through whatever turns run after it. Absent
    // from a sandbox older than it, where only a turn's own `failure` can say so.
    readonly landFailure?: LandFailure | undefined;
    // The conversation whose work this one was opened on, for a fresh session (AgentSummary.fresh): a person's own
    // review, test or ask, which hangs under that conversation's card and is never reported to it
    // (subagents/child-report.ts), so nothing it stops on is that conversation's news. Absent for every other one.
    readonly fresh?: { readonly of: string } | undefined;
}

// A spent allowance, not a failure to fix: nothing broken, and it comes back. Read off `failureCode` rather than
// the provider's own sentence, which varies per provider; the code is the daemon's own classification
// (error-frames.ts).
export const limited = (agent: AgentStanding): boolean => agent.status === "error" && agent.failureCode === "rate_limit";

// A message held at the door because the sandbox is short of memory (turn-admission): nothing ran and nothing failed.
// The daemon files it as an `error`, so this is read off the code, as `limited` is, and the chip and glyph say held
// rather than error. Its lane is any ending's: Attention until something carries it on (`next`, a send once memory
// frees or a booking for later), Active from then.
export const memoryHeld = (agent: Pick<AgentStanding, "status" | "failureCode">): boolean =>
    agent.status === "error" && agent.failureCode === "sandbox-memory-low";

// Whether the window is still shut, feeding only the card's countdown, never the lane: a stranded card stays in
// Attention shut or open. No published instant means never closed, not a guessed one.
export const limitClosed = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limited(agent) && agent.limitResetsAt !== undefined && agent.limitResetsAt * 1_000 > now;

// A refused land nothing the agent does can clear: every blocker left is a file the user has uncommitted edits on,
// which only a commit or stash releases (git cannot merge through unstaged work, and the agent's checkout cannot
// even see it). The distinction the board used to lack: it offered "have the agent resolve it" for every conflict,
// including the ones where that press was refused the moment it was made.
// False when the daemon named no causes, which is a build that predates them or a refusal it could not attribute;
// the board then falls back to offering the agent, as it always did.
export const conflictIsYours = (agent: AgentStanding): boolean =>
    agent.conflictCauses !== undefined && agent.conflictCauses.length > 0 && agent.conflictCauses.every((cause) => cause === "workspace");

// This conversation runs again by itself, with nobody pressing anything: its last turn ended (status is `idle`/`landed`,
// never `ready`, since the daemon holds the land for the wake), but the conversation is not over. The daemon's own
// reading (a watch, or a wake waiting in its queue); a daemon older than it is read by its watches.
export const watching = (agent: AgentStanding): boolean => awaitsWake(agent);

// The running job behind one of its armed watches that sits at a prompt (AgentJob.inputWait: blocked reading its
// terminal, nothing moving), the first such where there are several. Its watch fires only on an exit that will not
// come, so the card names it and offers to end it.
export const promptHeldJob = (agent: AgentStanding): AgentJob | undefined => {
    const armed = new Set((agent.watches ?? []).map((watch) => watch.id));
    return agent.jobs?.find((job) => job.endedAt === undefined && job.inputWait !== undefined && job.watch !== undefined && armed.has(job.watch));
};

// Parked only on jobs at a prompt: every watch it holds waits on an exit nobody in the sandbox will bring about, so the
// conversation is not resuming by itself, it is stuck until the reader ends the command (or types into its terminal).
// Not while a turn runs, whose own readout says what it is doing. On 2026-10-04 such a card sat in Active for hours
// under a six-hour countdown, with its Land press hidden behind the wake it was waiting for.
export const heldByPrompt = (agent: AgentStanding): boolean => {
    const watches = agent.watches ?? [];
    if (watches.length === 0 || turnInFlight(agent)) {
        return false;
    }
    const prompts = new Set(
        (agent.jobs ?? [])
            .filter((job) => job.endedAt === undefined && job.inputWait !== undefined && job.watch !== undefined)
            .map((job) => job.watch),
    );
    return watches.every((watch) => prompts.has(watch.id));
};

// No registry entry behind this card: archiving, reviewing, landing, discarding and dropping all address an agent
// by id through the daemon, and none of these ids name anything there.
// Takes the status alone, unlike the lane predicates: callers like the tab's `open` and the detail page's
// `registered` hold a status without an attention block to pair it with.
export const unregistered = (status: AgentStatus | ClientAgentStatus): boolean =>
    status === "draft" || status === "starting" || status === "failed" || status === "resumed";

// A turn is in flight: running, unwinding after a Stop, or repairing itself after its daemon died. Every hands-off
// guard (its worktree is a live turn's working state) and the live readouts (elapsed, activity line) key off this.
// `starting` counts even though nothing is registered yet, elapsed should tick from the send. `dismissing` and
// `landing` count for the guards only; both settle in Finished, so their lane is decided separately (see laneOf).
// A land runs no turn, but the daemon holds the worktree exactly as a turn would, and every guard wants the same answer.
// `awaiting` is deliberately excluded: it's live but parked, handled by `awaitingUser` instead.
export const turnInFlight = (agent: AgentStanding): boolean =>
    agent.status === "running" ||
    agent.status === "starting" ||
    agent.status === "stopping" ||
    agent.status === "dismissing" ||
    agent.status === "resuming" ||
    agent.status === "landing";

// The two standings a person's ending unwinds as, from the press until the turn has let go: Stop, or waving away the
// question it was parked on. Both differ only in the lane they settle in (see laneOf).
export type EndingByHand = Extract<AgentStatus, "stopping" | "dismissing">;

// How a person ended this turn, while it unwinds; undefined for a turn nobody ended. The one reading both the board's
// card and the chat's live line are drawn from, so the two say the same word about the same press.
export const endingOf = (agent: AgentStanding): EndingByHand | undefined =>
    agent.status === "stopping" || agent.status === "dismissing" ? agent.status : undefined;

// A person already ended this turn and it's unwinding. Narrower than `turnInFlight`, which also covers turns nobody
// ended.
export const endingByHand = (agent: AgentStanding): boolean => endingOf(agent) !== undefined;

// A turn actually producing something, as a card's readouts mean it: `landing` is in flight for the hands-off guards
// but spends no model, and its `startedAt` belongs to the turn before it, so an elapsed clock would be someone else's.
// A turn a person already ended produces nothing more either: its readout is the ending itself (the card's chip, the
// chat's line), not the step it was on under a clock still counting, which reads as a Stop that did not take.
export const turnWorking = (agent: AgentStanding): boolean => turnInFlight(agent) && agent.status !== "landing" && !endingByHand(agent);

// The browser's copy of the daemon's `writing` guard (agents-registry.ts); exists for Land, where typing vs.
// parked matters (everything else treats them alike). `stopping` and `resuming` are excluded because the provider
// isn't producing anything then; the two sides must stay in step or the UI offers a press the daemon refuses.
export const writingNow = (agent: AgentStanding): boolean => agent.status === "running" || agent.status === "starting";

// "Blocked on you": the agent cannot proceed (or has failed) until the user acts. Not the same as unread.
// `stopped`/`interrupted` leave a half-written worktree only a new message can carry forward; `stopping` is
// counted the moment the press lands rather than once the unwind finishes, since it settles in the same lane
// either way; `failed` is the same kind of dead end one step earlier, before a worktree existed.
const BLOCKING_ENDINGS: ReadonlySet<AgentStatus | ClientAgentStatus> = new Set(["error", "interrupted", "stopping", "stopped", "failed"]);

// A land that broke and still stands: its work is stuck on the branch, whatever the turn after it did, so the card is
// the reader's to look at. Not while a turn or a land is under way, which ends in another land of its own.
export const landBroken = (agent: AgentStanding): boolean => agent.landFailure !== undefined && !turnInFlight(agent);

/**
 * A turn that ended badly, with nothing set to carry it on: a dead end the reader owes a press. Once something will
 * (`next`: a held turn re-run at its reopen or moved, a send once memory frees, a message booked for later), that is the
 * answer to the ending, the person's or the sandbox's on their standing word, so the card is Active and its corner says
 * when it goes. Before 2026-10-20 the lane asked two of those, the card's corner three, the chat's bar one more, and
 * they disagreed. Not `stopping`, still unwinding, which rests in Attention whatever waits behind it. Answers only the
 * ending: an ask (a plan, a question, a permission, a land only the reader can clear) still calls the reader.
 */
const deadEnd = (agent: AgentStanding): boolean => agent.status === "stopping" || (BLOCKING_ENDINGS.has(agent.status) && !goesBySelf(agent));

export const blocked = (agent: AgentStanding): boolean =>
    agent.attention.plan ||
    agent.attention.question ||
    agent.attention.permission ||
    agent.attention.capability ||
    agent.attention.conflict ||
    // A need outlives its turn (docs/architecture/needs.md): a conversation still running carries on beside it and
    // stays in Active, one that stopped is waiting on nothing but the answer.
    (agent.attention.need === true && agent.status !== "running") ||
    landBroken(agent) ||
    heldByPrompt(agent) ||
    deadEnd(agent);

// The half of `blocked` that is literally waiting on an answer (plan, question, permission, capability), narrower
// than `blocked`: dead ends (a failed turn, an unlandable conflict) want looking at but owe the user nothing, so
// ending the agent loses no answer.
export const awaitingUser = (agent: AgentStanding): boolean =>
    agent.attention.plan || agent.attention.question || agent.attention.permission || agent.attention.capability || agent.status === "awaiting";

// An ask only the owner may answer: a plan to approve, a permission, a setup, a credential release, a hand-off to a
// browser or terminal (a bare `awaiting`), or a refused land only their own commit clears. The parent a child agent
// works for can answer its question (subagents/children.ts) and hears how its turns end, but none of these, so these
// are what reach the reader from a child whatever its parent is doing (callsOwner).
export const onlyOwnerCanAnswer = (agent: AgentStanding): boolean =>
    agent.attention.plan ||
    agent.attention.permission ||
    agent.attention.capability ||
    agent.attention.credential ||
    agent.attention.need === true ||
    (agent.status === "awaiting" && !agent.attention.question) ||
    ((agent.attention.conflict || agent.status === "conflict") && conflictIsYours(agent));

// Whether a child agent's stop is news its parent has already had. Every ending of a turn the parent started reaches
// the parent (subagents/child-report.ts: a parked `wait` takes it, or it wakes the parent like any wake), so a parent
// that moved after the child stopped (ran a turn, landed) heard it, and its own ending is the account the reader gets:
// an orchestrator that worked around three spent allowances and landed is done, not stuck. Only a turn's ending
// counts. A question is still parked and waits for an answer whoever has moved since, and a land refused or broken
// leaves work stuck on the child's branch that no report settles. A turn a person ran in the child's own chat is never
// reported to the parent, and it ends after the parent's last move, so it still reads as unheard here. Nor is anything a
// fresh session does, whenever its origin moved: it is the person's, so its stops are never the origin's to have heard.
// `updatedAt` is the clock on both sides: a rename keeps it (agents-registry), and reading does not move it.
export const heardByParent = (child: AgentStanding & { readonly updatedAt: number }, parentAt: number): boolean =>
    child.fresh === undefined &&
    BLOCKING_ENDINGS.has(child.status) &&
    // Still unwinding: its ending has not reached anyone yet.
    child.status !== "stopping" &&
    // Carried on by itself: not over, whatever its parent made of the pause.
    !goesBySelf(child) &&
    !child.attention.question &&
    !child.attention.conflict &&
    !landBroken(child) &&
    child.updatedAt < parentAt;
