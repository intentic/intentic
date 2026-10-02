import type { IconName, Tip } from "@intentic/ui";
import { briefDuration } from "@intentic/base/format";
import { formatClock, formatWhen } from "@intentic/ui/format";
import {
    type AgentAttention,
    type AgentOrigin,
    type AgentProvider,
    type AgentStatus,
    type AgentSummary,
    type AgentWatch,
    awaitsWake,
    type LandConflictReason,
    type LandedRemover,
    type LandFailure,
    type LoopState,
    type QueuePause,
    type SubagentStatus,
} from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { useVocabulary } from "../../../core-views/vocabulary";
import { parentOf } from "../board/ownership";

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
// or a test literal can all answer the same question.
export interface AgentStanding {
    readonly status: AgentStatus | ClientAgentStatus;
    readonly attention: AgentAttention;
    // Outside conditions this conversation is parked on (AgentSummary.watches); `laneOf` reads it alongside `status`
    // and `attention`. Absent for nearly every conversation.
    readonly watches?: readonly AgentWatch[];
    // Whether it runs again by itself (AgentSummary.awaitingWake): the daemon's one reading, which `watching` asks.
    readonly awaitingWake?: boolean;
    // Why a refused land is still refusing (AgentSummary.conflictCauses), which decides whose press can clear it.
    // Absent for every card but one refusing to merge.
    readonly conflictCauses?: readonly LandConflictReason[];
    // Which kind of failure ended the last turn. `status: "error"` alone conflates a broken harness with a spent
    // allowance; both belong in Attention, but this says which so the card can tell them apart. `laneOf` reads it too,
    // so the lane, badge and chip stay in agreement.
    readonly failureCode?: string;
    // The words that turn died on (AgentSummary.failure), cleared with the code when it runs again.
    readonly failure?: string;
    /** When the spent allowance reopens, in epoch SECONDS (the wire's unit). Absent when nobody published one. */
    readonly limitResetsAt?: number;
    /** Whether the refused turn is held whole, so a press re-runs it rather than sending a new message after it. */
    readonly limitHeld?: boolean;
    /** Whether a fire is already booked for it (at the reset, or a move now), so no press is needed. */
    readonly limitScheduled?: boolean;
    /** The account the owner's policy is moving the held turn to, while that move is booked (a scheduled card's sentence). */
    readonly limitMoving?: string;
    // A land that broke (AgentSummary.landFailure), standing until one goes through whatever turns run after it. Absent
    // from a sandbox older than it, where only a turn's own `failure` can say so.
    readonly landFailure?: LandFailure;
    // What waits for its next turn (AgentSummary.queue), read here only for its hold: messages booked to go by
    // themselves at a time or once another agent's work lands (`scheduled`), which make the conversation one that runs
    // again by itself. Never the words.
    readonly queue?: QueueHold | undefined;
}

// The part of a conversation's queue the board reads: why it holds, and what a scheduled hold waits for.
export interface QueueHold {
    readonly paused?: QueuePause | undefined;
    readonly until?: number | undefined;
    readonly after?: string | undefined;
}

// Messages booked to go by themselves (sendLater.ts, or a spent allowance's reopen): the conversation runs again with
// nobody pressing anything, so it is not finished, and nothing is owed by the reader for it to.
export const scheduledSend = (agent: Pick<AgentStanding, "queue">): boolean => agent.queue?.paused === `scheduled`;

// The scheduled hold alone, copied for a standing that outlives its card (standingFrom); undefined for any other queue.
const scheduledHold = (agent: Pick<AgentStanding, "queue">): QueueHold | undefined => {
    if (!scheduledSend(agent)) {
        return undefined;
    }
    // A scheduled hold waits on exactly one thing: another agent's land, or an instant.
    const { until, after } = agent.queue ?? {};
    if (after !== undefined) {
        return { paused: `scheduled`, after };
    }
    return until === undefined ? { paused: `scheduled` } : { paused: `scheduled`, until };
};

// A spent allowance, not a failure to fix: nothing broken, and it comes back. Read off `failureCode` rather than
// the provider's own sentence, which varies per provider; the code is the daemon's own classification
// (error-frames.ts).
export const limited = (agent: AgentStanding): boolean => agent.status === `error` && agent.failureCode === `rate_limit`;

// A message held at the door because the sandbox is short of memory (turn-admission): nothing ran and nothing failed,
// it waits for a person's "send anyway". The daemon files it as an `error`, so this is read off the code, as `limited`
// is, and the chip and glyph say held rather than error; the lane stays Attention, since the press is the reader's.
export const memoryHeld = (agent: Pick<AgentStanding, "status" | "failureCode">): boolean =>
    agent.status === `error` && agent.failureCode === `sandbox-memory-low`;

// Whether the window is still shut, feeding only the card's countdown, never the lane: a stranded card stays in
// Attention shut or open. No published instant means never closed, not a guessed one.
export const limitClosed = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limited(agent) && agent.limitResetsAt !== undefined && agent.limitResetsAt * 1_000 > now;

// A booked fire needs no press: the held turn goes again at the reset by itself. Only where this conversation's answer
// for the limit says so (`resend` or `move`); that answer starts at `wait`. Nothing is owed then, so it leaves Attention
// for Active, as an armed watch does: a card counted in the badge and the tab title for the hours until a reset the
// reader already answered was a call nobody could answer. The stall still shows, on the card's own chip and clock.
export const limitScheduled = (agent: AgentStanding): boolean => limited(agent) && agent.limitScheduled === true;

// Agents one provider's spent allowance stopped, each holding its refused turn and none booked to go again, gathered
// for the board's one press instead of a walk down the lane pressing each (seven presses on seven cards, on a phone).
// Only groups of two or more: one card already carries its own press. `reopensAt` is the latest reset among them (ms)
// when every one of them published one still ahead, which is when "Resume all when it's back" can book them all
// (the resume pass fires a held turn at its reset once the conversation answers the limit with a resend); otherwise
// the press sends them all now, and one still refused says so on its own card.
export interface LimitGroup {
    readonly provider: AgentProvider;
    readonly ids: readonly string[];
    readonly reopensAt?: number;
}
export const limitGroups = (
    agents: readonly (AgentStanding & {
        readonly id: string;
        readonly provider: AgentProvider;
        readonly archivedAt?: number | undefined;
        readonly sandboxId?: string | undefined;
    })[],
    now: number,
): LimitGroup[] => {
    const byProvider = new Map<AgentProvider, (typeof agents)[number][]>();
    for (const agent of agents) {
        if (limited(agent) && agent.limitHeld === true && !limitScheduled(agent) && agent.archivedAt === undefined && agent.sandboxId === undefined) {
            byProvider.set(agent.provider, [...(byProvider.get(agent.provider) ?? []), agent]);
        }
    }
    return [...byProvider.entries()]
        .filter(([, held]) => held.length > 1)
        .map(([provider, held]) => {
            const ahead = held.flatMap((agent) =>
                agent.limitResetsAt === undefined || agent.limitResetsAt * 1_000 <= now ? [] : [agent.limitResetsAt * 1_000],
            );
            const ids = held.map((agent) => agent.id);
            return ahead.length === held.length ? { provider, ids, reopensAt: Math.max(...ahead) } : { provider, ids };
        });
};

// A booked move: the owner's policy is already carrying the held turn to another account, on the resume pass's next
// beat, seconds away, so the card names where it is going rather than when it goes.
export const limitMoveBooked = (agent: AgentStanding): boolean => limitScheduled(agent) && agent.limitMoving !== undefined;

// A refused land nothing the agent does can clear: every blocker left is a file the user has uncommitted edits on,
// which only a commit or stash releases (git cannot merge through unstaged work, and the agent's checkout cannot
// even see it). The distinction the board used to lack: it offered "have the agent resolve it" for every conflict,
// including the ones where that press was refused the moment it was made.
// False when the daemon named no causes, which is a build that predates them or a refusal it could not attribute;
// the board then falls back to offering the agent, as it always did.
export const conflictIsYours = (agent: AgentStanding): boolean =>
    agent.conflictCauses !== undefined && agent.conflictCauses.length > 0 && agent.conflictCauses.every((cause) => cause === `workspace`);

// This conversation runs again by itself, with nobody pressing anything: its last turn ended (status is `idle`/`landed`,
// never `ready`, since the daemon holds the land for the wake), but the conversation is not over. The daemon's own
// reading (a watch, or a wake waiting in its queue); a daemon older than it is read by its watches.
export const watching = (agent: AgentStanding): boolean => awaitsWake(agent);

// No registry entry behind this card: archiving, reviewing, landing, discarding and dropping all address an agent
// by id through the daemon, and none of these ids name anything there.
// Takes the status alone, unlike the lane predicates: callers like the tab's `open` and the detail page's
// `registered` hold a status without an attention block to pair it with.
export const unregistered = (status: AgentStatus | ClientAgentStatus): boolean =>
    status === `draft` || status === `starting` || status === `failed` || status === `resumed`;

// One entry per status, no fallthrough. A table rather than an if-chain: `satisfies` over the full union makes an
// unhandled status a build error instead of silently drawing it as idle.
const statusMeta = () =>
    ({
        // Not `pencil`, that's the card's rename affordance; the draft glyph is a not-yet-started marker.
        draft: { icon: `circle`, label: t(`agents.agentStatus.draft`), class: `text-subtle` },
        // Says where it came from, not how it ended (that's unknowable, the registry entry that would say is gone). Glyph
        // matches the search footer's "In earlier chats".
        resumed: { icon: `history`, label: t(`agents.agentStatus.earlierChat`), class: `text-subtle` },
        // Send was refused: nothing of the user's is at risk, so warning rather than `error`'s danger. This agent doesn't
        // exist; the card is for work that never started.
        failed: { icon: `exclamation-triangle`, label: t(`agents.agentStatus.didntStart`), class: `text-warning` },
        // The turn has gone but the daemon hasn't filed it yet; drawn from what this browser knows, not the registry.
        starting: { icon: `spinner`, spin: true, label: t(`ui.status.starting`), class: `text-link` },
        running: { icon: `spinner`, spin: true, label: t(`shared.running`), class: `text-link` },
        // The Stop press landed and the turn is unwinding. Muted rather than a spinner: this is the tail of something
        // ending, not new work.
        stopping: { icon: `stop`, label: t(`agents.agentStatus.stopping`), class: `text-subtle` },
        // The other way a person ends a turn (waving away what it was parked on). Wears the finish it's about to become
        // rather than a second kind of halt.
        dismissing: { icon: `check-circle`, label: t(`agents.agentStatus.finishing`), class: `text-subtle` },
        // The turn stopped without ending (something underneath broke) and the daemon is already restarting it; running
        // spinner and blue since nothing failed and work is still in progress.
        resuming: { icon: `spinner`, spin: true, label: t(`agents.agentStatus.resuming`), class: `text-link` },
        // The daemon is rebasing the branch and carrying its work into the workspace; nothing has finished yet, nothing has
        // failed, and nothing may act on the branch until it settles, so the running spinner and blue.
        landing: { icon: `spinner`, spin: true, label: useVocabulary().value.landing, class: `text-link` },
        awaiting: { icon: `exclamation-circle`, label: t(`shared.needs`), class: `text-primary-500` },
        landed: { icon: `check-circle`, label: useVocabulary().value.landed, class: `text-success` },
        // Finished with auto-land off: work is safe on the branch, waiting for a deliberate Land. Link-blue, not an
        // attention hue, since the user chose this.
        ready: { icon: `download`, label: useVocabulary().value.readyToLand, class: `text-link` },
        conflict: { icon: `exclamation-triangle`, label: t(`agents.agentStatus.conflict`), class: `text-warning` },
        error: { icon: `exclamation-triangle`, label: t(`agents.agentStatus.error`), class: `text-danger` },
        // Warning, not danger: the daemon died underneath it (rebuild, crash), a fact about the sandbox rather than the
        // work. Glyph matches the Stop button.
        interrupted: { icon: `stop`, label: t(`agents.agentStatus.interrupted`), class: `text-warning` },
        // Same kind of ending, by the user's own hand, so quieter than `interrupted`: the reader already knows, since they
        // pressed Stop.
        stopped: { icon: `stop`, label: t(`agents.agentStatus.stopped`), class: `text-subtle` },
        idle: { icon: `circle-fill`, label: t(`agents.agentStatus.idle`), class: `text-subtle` },
    }) as const satisfies Record<AgentStatus | ClientAgentStatus, { icon: IconName; spin?: boolean; label: string; class: string }>;

// The `??` is unreachable by types but kept: an unhandled status here is `undefined.icon` in a render, which takes
// down the whole board, worse than one card reading `Idle`. The wire isn't runtime-typed, so a newer daemon can
// send a status this build has never heard of.
export const agentStatusMeta = (status: AgentStatus | ClientAgentStatus): { icon: IconName; spin?: boolean; label: string; class: string } =>
    statusMeta()[status] ?? statusMeta().idle;

// A card's glyph, read off its standing rather than its status alone: the one `error` that is not one (a message held for
// memory) wears a hold's glyph and says why, in the reader's language, where the daemon's sentence is English.
export const agentStandingMeta = (
    agent: Pick<AgentStanding, "status" | "failureCode">,
): { icon: IconName; spin?: boolean; label: string; class: string } =>
    memoryHeld(agent) ? { icon: `pause`, label: t(`agents.agentStatus.heldMemory`), class: `text-warning` } : agentStatusMeta(agent.status);

// The same glyphs for a subagent a runtime ran in-process, which has no conversation and so no AgentStatus, only the
// roster's word (SubagentStatus). Where the two vocabularies name the same standing they wear the same glyph, so a tray
// holding both kinds reads as one list: working spins as `running` does, a failure is `error`'s, a stop `stopped`'s.
const subagentMeta = () =>
    ({
        // Waiting for a slot under the sandbox's concurrency ceiling; nothing has started.
        pending: { icon: `clock`, label: t(`agents.childRows.queued`), class: `text-subtle` },
        running: statusMeta().running,
        // Its question goes to its parent's own turn, whose card carries the ask; the row only says it is waiting.
        blocked: { icon: `question-circle`, label: t(`agents.childRows.needsInput`), class: `text-warning` },
        paused: { icon: `clock`, label: t(`agents.childRows.paused`), class: `text-warning` },
        completed: { icon: `check-circle`, label: t(`agents.childRows.completed`), class: `text-success` },
        failed: statusMeta().error,
        killed: statusMeta().stopped,
    }) as const satisfies Record<SubagentStatus, { icon: IconName; spin?: boolean; label: string; class: string }>;

// The `??` for the same reason as agentStatusMeta's: a newer daemon's status this build has never heard of.
export const subagentStatusMeta = (status: SubagentStatus): { icon: IconName; spin?: boolean; label: string; class: string } =>
    subagentMeta()[status] ?? statusMeta().idle;

// What to call a conversation whose title the first turn has not minted yet (a new tab, an untitled history entry).
// The composer's own unsent words beat any placeholder: they are what the reader wrote, and what they will recognise.
// Those words are passed in rather than read off the card: they live in `chatPreviews`, keyed by id, so that typing
// rebuilds nothing but the one thing drawing them (useAgents-fleet.FleetAgent.unsent).
export const agentDisplayTitle = (agent: { readonly title?: string; readonly status: AgentStatus | ClientAgentStatus }, preview?: string): string => {
    if (agent.title !== undefined) {
        return agent.title;
    }
    if (preview !== undefined) {
        return preview;
    }
    if (agent.status === `draft`) {
        return t(`agents.agentStatus.newAgent`);
    }
    return agent.status === `resumed` ? t(`agents.agentStatus.untitledChat`) : t(`agents.agentStatus.untitledAgent`);
};

// A turn is in flight: running, unwinding after a Stop, or repairing itself after its daemon died. Every hands-off
// guard (its worktree is a live turn's working state) and the live readouts (elapsed, activity line) key off this.
// `starting` counts even though nothing is registered yet, elapsed should tick from the send. `dismissing` and
// `landing` count for the guards only; both settle in Finished, so their lane is decided separately (see laneOf).
// A land runs no turn, but the daemon holds the worktree exactly as a turn would, and every guard wants the same answer.
// `awaiting` is deliberately excluded: it's live but parked, handled by `awaitingUser` instead.
export const turnInFlight = (agent: AgentStanding): boolean =>
    agent.status === `running` ||
    agent.status === `starting` ||
    agent.status === `stopping` ||
    agent.status === `dismissing` ||
    agent.status === `resuming` ||
    agent.status === `landing`;

// The two standings a person's ending unwinds as, from the press until the turn has let go: Stop, or waving away the
// question it was parked on. Both differ only in the lane they settle in (see laneOf).
export type EndingByHand = Extract<AgentStatus, `stopping` | `dismissing`>;

// How a person ended this turn, while it unwinds; undefined for a turn nobody ended. The one reading both the board's
// card and the chat's live line are drawn from, so the two say the same word about the same press.
export const endingOf = (agent: AgentStanding): EndingByHand | undefined =>
    agent.status === `stopping` || agent.status === `dismissing` ? agent.status : undefined;

// A person already ended this turn and it's unwinding. Narrower than `turnInFlight`, which also covers turns nobody
// ended.
export const endingByHand = (agent: AgentStanding): boolean => endingOf(agent) !== undefined;

// A turn actually producing something, as a card's readouts mean it: `landing` is in flight for the hands-off guards
// but spends no model, and its `startedAt` belongs to the turn before it, so an elapsed clock would be someone else's.
// A turn a person already ended produces nothing more either: its readout is the ending itself (the card's chip, the
// chat's line), not the step it was on under a clock still counting, which reads as a Stop that did not take.
export const turnWorking = (agent: AgentStanding): boolean => turnInFlight(agent) && agent.status !== `landing` && !endingByHand(agent);

// The browser's copy of the daemon's `writing` guard (agents-registry.ts); exists for Land, where typing vs.
// parked matters (everything else treats them alike). `stopping` and `resuming` are excluded because the provider
// isn't producing anything then; the two sides must stay in step or the UI offers a press the daemon refuses.
export const writingNow = (agent: AgentStanding): boolean => agent.status === `running` || agent.status === `starting`;

// "Blocked on you": the agent cannot proceed (or has failed) until the user acts. Not the same as unread.
// `stopped`/`interrupted` leave a half-written worktree only a new message can carry forward; `stopping` is
// counted the moment the press lands rather than once the unwind finishes, since it settles in the same lane
// either way; `failed` is the same kind of dead end one step earlier, before a worktree existed. A spent allowance
// counts until something is booked to carry it on (limitScheduled): a resend at the reset, or a move now.
const BLOCKING_ENDINGS: ReadonlySet<AgentStatus | ClientAgentStatus> = new Set([`error`, `interrupted`, `stopping`, `stopped`, `failed`]);

// A land that broke and still stands: its work is stuck on the branch, whatever the turn after it did, so the card is
// the reader's to look at. Not while a turn or a land is under way, which ends in another land of its own.
export const landBroken = (agent: AgentStanding): boolean => agent.landFailure !== undefined && !turnInFlight(agent);

export const blocked = (agent: AgentStanding): boolean =>
    limitScheduled(agent)
        ? false
        : agent.attention.plan ||
          agent.attention.question ||
          agent.attention.permission ||
          agent.attention.capability ||
          agent.attention.conflict ||
          // A need outlives its turn (docs/architecture/needs.md): a conversation still running carries on beside it
          // and stays in Active, one that stopped is waiting on nothing but the answer.
          (agent.attention.need === true && agent.status !== `running`) ||
          landBroken(agent) ||
          BLOCKING_ENDINGS.has(agent.status);

// The half of `blocked` that is literally waiting on an answer (plan, question, permission, capability), narrower
// than `blocked`: dead ends (a failed turn, an unlandable conflict) want looking at but owe the user nothing, so
// ending the agent loses no answer.
export const awaitingUser = (agent: AgentStanding): boolean =>
    agent.attention.plan || agent.attention.question || agent.attention.permission || agent.attention.capability || agent.status === `awaiting`;

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
    (agent.status === `awaiting` && !agent.attention.question) ||
    ((agent.attention.conflict || agent.status === `conflict`) && conflictIsYours(agent));

// Whether a child agent's stop is news its parent has already had. Every ending of a turn the parent started reaches
// the parent (subagents/child-report.ts: a parked `wait` takes it, or it wakes the parent like any wake), so a parent
// that moved after the child stopped (ran a turn, landed) heard it, and its own ending is the account the reader gets:
// an orchestrator that worked around three spent allowances and landed is done, not stuck. Only a turn's ending
// counts. A question is still parked and waits for an answer whoever has moved since, and a land refused or broken
// leaves work stuck on the child's branch that no report settles. A turn a person ran in the child's own chat is never
// reported to the parent, and it ends after the parent's last move, so it still reads as unheard here.
// `updatedAt` is the clock on both sides: a rename keeps it (agents-registry), and reading does not move it.
export const heardByParent = (child: AgentStanding & { readonly updatedAt: number }, parentAt: number): boolean =>
    BLOCKING_ENDINGS.has(child.status) &&
    // Still unwinding: its ending has not reached anyone yet.
    child.status !== `stopping` &&
    // Booked to run again by itself: not over, whatever its parent made of the pause.
    !limitScheduled(child) &&
    !child.attention.question &&
    !child.attention.conflict &&
    !landBroken(child) &&
    child.updatedAt < parentAt;

// Whether what a child agent stopped on is the reader's to answer rather than its parent's, given the lanes both stand
// in and when the parent last moved. An ask only the owner can answer always is; anything else it stopped on (a spent
// allowance, a failure, a stop, a question, a land conflict) is its parent's news while the parent supervises, and the
// reader's once it no longer does: nothing running there to hear it and nothing armed to wake it, which is a parent out
// of Active. That holds only until the parent moves past it (heardByParent). After that the stop is the family's
// history, drawn in the tray, and no longer something the reader owes a press. The sandbox draws the same line for a
// child's land news (subagents/child-lands.ts): the parent's while it has a live turn, the owner's after.
export const callsOwner = (
    child: AgentStanding & { readonly updatedAt: number },
    family: { readonly child: FleetLane; readonly parent: FleetLane; readonly parentAt: number },
): boolean => onlyOwnerCanAnswer(child) || (family.child === `attention` && family.parent !== `active` && !heardByParent(child, family.parentAt));

// One table for the chip word and drill-in verb per attention flag, in display rank order, so the two can't drift
// apart as they did before. `satisfies Record<keyof AgentAttention, …>` makes a new wire flag a build error until
// both words exist. Kept short: the chip is `shrink-0` beside the title, so every character taken grows at the
// agent name's expense.
const attentionWords = () =>
    ({
        plan: { chip: t(`agents.agentStatus.approvalNeeded`), verb: t(`agents.agentStatus.reviewPlan`) },
        // Outranks a question: parked on a setup only the user can do. Verb names the work, since this click leads into a
        // flow rather than a one-press approval.
        capability: { chip: t(`agents.agentStatus.setupNeeded`), verb: t(`agents.words.setUp`) },
        // Waits for an exact list of addresses the owner named; the daemon refuses everybody else
        // (secrets/credential-gate.ts). Ranked above a question, below setup: it blocks outright like a setup but is a
        // yes/no rather than a decision to read. Verb names the destination, not the action ("Release" would promise
        // something the reader may be unable to do).
        credential: { chip: t(`agents.agentStatus.releaseNeeded`), verb: t(`agents.agentStatus.seeRequest`) },
        // Something the agent asked a person for that outlives the turn (a connection, a secret, reach, a tool): ranked
        // with a setup, since it is one, and worded for what the reader does, which is answer it where it is drawn.
        need: { chip: t(`agents.agentStatus.needsYou`), verb: t(`agents.agentStatus.seeWhatItNeeds`) },
        question: { chip: t(`agents.agentStatus.question`), verb: t(`ui.action.answer`) },
        // Ranked last, the most routine and cheapest park to clear: a plan, a spend or a setup wants reading first. Chip
        // reads "Permission" alone, not "Approval needed" (a plan's word) or "Permission needed" (too long at the card's
        // lane width, and the only thing naming the state on mobile where the drill-in verb doesn't render).
        permission: { chip: t(`agents.agentStatus.permission`), verb: t(`ui.action.approve`) },
        // Verb names the report, not the fix: the fix is its own button one line above the drill-in (AgentCard). Two
        // controls both promising to resolve the conflict, only one of which does, is worse than one of each.
        conflict: { chip: t(`agents.agentStatus.landConflict`), verb: t(`agents.agentStatus.seeWhatBlocked`) },
    }) as const satisfies Record<keyof AgentAttention, { chip: string; verb: string }>;

// The rank for both readings. Spelled out rather than read off the table above, which is a function now: calling it
// here, while this module is still being imported, would ask for words before any catalog is registered.
const ATTENTION_RANK = [
    `plan`,
    `capability`,
    `need`,
    `credential`,
    `question`,
    `permission`,
    `conflict`,
] as const satisfies readonly (keyof AgentAttention)[];

// The flag this card leads with, read once so the chip and verb are always about the same park. Raised flags are
// checked before the `conflict` status; a live park with someone waiting outranks a fact about where work came to
// rest.
const leadingPark = (agent: AgentStanding): keyof AgentAttention | undefined =>
    ATTENTION_RANK.find((flag) => agent.attention[flag]) ?? (agent.status === `conflict` ? `conflict` : undefined);

// The one refusal whose chip reads "Your edits": the card leads with a land conflict only the reader's own uncommitted
// edits stand in. What a surface that names the Sandbox pages behind such a refusal keys off (settingsChip), never the
// word itself.
export const editsRefusal = (agent: AgentStanding): boolean =>
    !limited(agent) && !memoryHeld(agent) && leadingPark(agent) === `conflict` && conflictIsYours(agent);

// The one-line "why this card needs you" label, shared by the card chip, the Changes legend's hover card, and any
// future toast.
export const attentionReason = (agent: AgentStanding): string | undefined => {
    // "Usage limit": the vendor's own phrase, not "allowance" which reads as jargon. Naming the condition here is the
    // whole fix; the card's body is left to say what the card is rather than what happened to it. Short, since the
    // chip is `shrink-0` beside the agent's name.
    if (limited(agent)) {
        return t(`agents.agentStatus.usageLimit`);
    }
    // Held, not failed: the chip is the word the reader acts on ("send anyway"), and "error" sent people hunting a fault.
    if (memoryHeld(agent)) {
        return t(`agents.agentStatus.held`);
    }
    const park = leadingPark(agent);
    if (park !== undefined) {
        // Same length as the generic word it replaces, and it names the half of the report the reader can act on:
        // "Land conflict" beside a button only they can press read as the agent's problem.
        return editsRefusal(agent) ? t(`agents.agentStatus.edits`) : attentionWords()[park].chip;
    }
    // A land that broke says so rather than "Error": the turn itself finished, and its work is what is stuck.
    if (landFailure(agent) !== undefined) {
        return useVocabulary().value.couldntLand;
    }
    // A park the attention block can't name: `awaiting` covers a browser or terminal hand-off, neither of which raises
    // a wire flag, so it arrives as a bare status. Checked last, only once nothing more specific applies.
    return endingReasons()[agent.status] ?? (agent.status === `awaiting` ? t(`agents.agentStatus.waitingOn`) : undefined);
};

// A land that broke: the daemon ran git to carry the work into the workspace and git refused, or the agent's copy lost
// its link to it, which is a different thing from the agent erring, and the one ending a card must never let read as
// finished. The sandbox keeps it on the card until a land goes through (`landFailure`, landBroken); one older than that
// says it only as the turn's failure, the raw `Command failed: git …` it ended on, which the next turn clears.
// Undefined for every other card; otherwise the reason in plain words, git's own last line where no plainer one fits.
// The raw sentence stays in the card's hover.
const GIT_FAILURE = /^Command failed: git\b/u;
// Git's words for a checkout that no longer shares history with the workspace: an object or range it cannot find, or
// a link it cannot follow. Said as what it means to the reader, since "bad object 3e03077" means nothing to them.
const LOST_LINK = /bad object|invalid symmetric difference|unknown revision|not a git repository|\.git file broken|not a valid object/iu;
// Git's refusal as the reader is told it.
const gitReason = (failure: string): string => {
    if (LOST_LINK.test(failure)) {
        return t(`agents.agentStatus.lostLink`);
    }
    const said = /fatal: (.+)$/u.exec(failure)?.[1]?.trim();
    return said === undefined || said === `` ? t(`agents.agentStatus.gitRefused`) : said;
};
export const landFailure = (agent: AgentStanding): string | undefined => {
    const broke = agent.landFailure;
    if (broke !== undefined) {
        if (!landBroken(agent)) {
            return undefined;
        }
        // The sandbox's own sentence for a lost link is long and English; the code says it in the reader's language.
        return broke.code === `unlinked` ? t(`agents.agentStatus.lostLink`) : GIT_FAILURE.test(broke.reason) ? gitReason(broke.reason) : broke.reason;
    }
    const failure = agent.failure;
    if (agent.status !== `error` || limited(agent) || failure === undefined || !GIT_FAILURE.test(failure)) {
        return undefined;
    }
    return gitReason(failure);
};

// The endings, tabled rather than chained since a sixth condition (`limited`) has to be checked ahead of them.
// Absent means the card isn't in Attention for a reason worth a chip.
const endingReasons = (): Partial<Record<AgentStatus | ClientAgentStatus, string>> => ({
    error: t(`agents.agentStatus.error`),
    // Names the whole of what happened, in the right tense: not "failed" (nothing ran) or "error" (no agent to have
    // erred). Stops the card reading as a live agent at all.
    failed: t(`agents.agentStatus.didntStart`),
    // The turn didn't fail or finish, its daemon went away. Sending a message starts a fresh turn on the same session.
    interrupted: t(`agents.agentStatus.interrupted`),
    // The user's own decision, so the chip reports it rather than addressing them ("Stopped", not "Stopped by you").
    // `stopping` is the same ending a beat earlier, in the tense it's actually in: still unwinding.
    stopping: t(`agents.agentStatus.stopping2`),
    stopped: t(`agents.agentStatus.stopped`),
});

export type FleetLane = "attention" | "active" | "finished";

// A card's standing on its own, carried where a whole card can't go (a chat tab, a summons to another window):
// every field `laneOf` reads and nothing else, with absent ones left out rather than spelled as undefined, since
// this is persisted and posted between windows.
export const standingFrom = (agent: AgentStanding): AgentStanding => {
    const copied = standingCopy(agent);
    const standing = agent.landFailure === undefined ? copied : { ...copied, landFailure: agent.landFailure };
    const hold = scheduledHold(agent);
    return hold === undefined ? standing : { ...standing, queue: hold };
};
const standingCopy = (agent: AgentStanding): AgentStanding => ({
    status: agent.status,
    // Copied, not referenced: this outlives the roster entry it was read from, in a tab and in storage.
    attention: { ...agent.attention },
    ...(agent.watches !== undefined ? { watches: agent.watches } : {}),
    ...(agent.awaitingWake !== undefined ? { awaitingWake: agent.awaitingWake } : {}),
    ...(agent.conflictCauses !== undefined ? { conflictCauses: agent.conflictCauses } : {}),
    ...(agent.failureCode !== undefined ? { failureCode: agent.failureCode } : {}),
    ...(agent.limitResetsAt !== undefined ? { limitResetsAt: agent.limitResetsAt } : {}),
    ...(agent.limitHeld !== undefined ? { limitHeld: agent.limitHeld } : {}),
    ...(agent.limitScheduled !== undefined ? { limitScheduled: agent.limitScheduled } : {}),
    ...(agent.limitMoving !== undefined ? { limitMoving: agent.limitMoving } : {}),
});

// Nothing owed to the user. The one "no attention" block in the app: a client-only card has no daemon account of
// what a turn asked, and two copies of this would let two surfaces place the same conversation differently.
export const NO_ATTENTION: AgentAttention = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

// The lane projection every surface must agree with (see the header). Pure reading of the state machine:
// "finished" needs no explicit timer since auto-land already flips a cleanly-completed turn to landed/idle within
// ms, and any follow-up message moves the card back to active. Unread stays a badge, not a lane.
export const laneOf = (agent: AgentStanding): FleetLane => {
    // A spent allowance nothing is booked for reaches Attention through `blocked` alone, no branch of its own, and ahead
    // of the `watching` branch below: a watch is the agent's own plan for waiting, a spent allowance an obstacle in
    // the way of it, and a watch firing into a shut window runs nothing (turn-admission.ts holds its words back).
    if (blocked(agent) || agent.status === `awaiting` || agent.status === `conflict`) {
        return `attention`;
    }
    // Settled from the press, ahead of the in-flight check below, rather than routed through Active: a waved-away turn
    // is one the user is already done with (unlike `stopping`, which rests in Attention), and a land spends no model at
    // all. Active means a turn in progress, so a land must end in the lane it was pressed in.
    if (agent.status === `dismissing` || agent.status === `landing`) {
        return `finished`;
    }
    // `resuming` is why in-flight must outrank the settled readings below: without this order the card would drop
    // into Finished for the seconds a credential takes to re-mint, then climb back out.
    if (turnInFlight(agent) || agent.status === `draft`) {
        return `active`;
    }
    // An armed watch is Active, not Finished: nothing is running, but the conversation restarts itself later, and
    // filing it Finished would announce as over work that resumes at 3am. Active rather than Attention since nothing
    // is owed by the user. Checked after the in-flight readings: an agent that armed a watch and is now running again
    // is running.
    if (watching(agent)) {
        return `active`;
    }
    // A stranded turn booked to go again is Active: at the reset, or on the resume pass's next beat for a move to another
    // account. Reached only because `blocked` let it through; stated explicitly or the card would fall through to
    // Finished, which would announce as over work that resumes by itself.
    if (limitScheduled(agent)) {
        return `active`;
    }
    // Messages booked for later are the same: the conversation starts again by itself, at a time or once the agent it
    // waits for has landed, so filing it Finished would announce as done work that has not started yet.
    if (scheduledSend(agent)) {
        return `active`;
    }
    // `landed`/`idle`/`ready` all finish here: `ready` is work held on the branch because auto-land is off, still
    // finished rather than attention since nothing is failing. `resumed` lands here too: nothing running, nothing
    // owed.
    return `finished`;
};

// How many cards the board's Attention lane draws for one fleet, as the board folds child agents under their parents
// (board/view/childFold.ts): an agent in Attention is a card of its own, except a child agent whose parent is in the
// fleet, which rides under its family's one card and lifts that card to Attention only when it calls the reader
// (callsOwner). A family counts once however many of its children call, and not again when its own card is in
// Attention already; a child with words left in its composer keeps a card of its own, as on the board. The rail
// badge's count, for this sandbox's fleet and another's alike, so the badge cannot disagree with the lane it names.
export const attentionCards = (agents: readonly CallerStanding[]): number => new Set(attentionCalls(agents).map((call) => call.card)).size;

// Enough of a fleet's agent to say whether it calls the reader, and through which card.
export type CallerStanding = AgentStanding & {
    readonly id: string;
    readonly updatedAt: number;
    readonly startedBy?: string | undefined;
    readonly unsent?: boolean | undefined;
};

// Every agent calling the reader, each with the card it is drawn on: its own, or its family's where it rides one. The
// count above is the cards; the browser tab's chime wants the callers, so a second child calling under a family already
// in Attention is news although the lane's count does not move.
export const attentionCalls = (agents: readonly CallerStanding[]): readonly { readonly id: string; readonly card: string }[] => {
    type Standing = (typeof agents)[number];
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    const parentIn = (agent: Standing): Standing | undefined => {
        const id = parentOf(agent.startedBy);
        return id === undefined ? undefined : byId.get(id);
    };
    // The card a child rides under: its eldest ancestor in this fleet, walked with a guard against a record naming its
    // own descendant as its parent.
    const familyOf = (agent: Standing): string => {
        const seen = new Set([agent.id]);
        let top = agent;
        for (let above = parentIn(top); above !== undefined && !seen.has(above.id); above = parentIn(top)) {
            seen.add(above.id);
            top = above;
        }
        return top.id;
    };
    const calls: { readonly id: string; readonly card: string }[] = [];
    for (const agent of agents) {
        const parent = parentIn(agent);
        if (parent === undefined || agent.unsent === true) {
            if (laneOf(agent) === `attention`) {
                calls.push({ id: agent.id, card: agent.id });
            }
        } else if (callsOwner(agent, { child: laneOf(agent), parent: laneOf(parent), parentAt: parent.updatedAt })) {
            calls.push({ id: agent.id, card: familyOf(agent) });
        }
    }
    return calls;
};

// What the card says when landed work is no longer in the workspace, in whole or in part. A land arrives as
// uncommitted changes the user can discard like anything else in the Changes panel, which other readings (taken
// between commits) can't see (landed-presence.ts). A qualifier on `landed`, not a status of its own: the lane
// stays Finished since the user already made that decision, and it's orthogonal to the turn lifecycle (a
// since-resumed agent can equally have had its land discarded). Undefined when nothing is missing, which is nearly
// all agents.
// `me` is the reader's address, so their own discard reads as theirs. `offerReland` is whether the card offers Land
// again: not when an agent took the work out, since that was its doing on purpose (an orchestrator tidying away a
// reviewer's patches), and a press that puts it back is the one this line invited from a reader who could not know. The
// card menu keeps it for whoever does.
export interface LandedAway {
    readonly text: string;
    readonly hint?: string;
    readonly tip: Tip;
    readonly icon: IconName;
    readonly offerReland: boolean;
}
export const landedAway = (
    agent: { readonly landedPresence?: { readonly landed: number; readonly present: number; readonly removedBy?: LandedRemover } },
    me?: string,
): LandedAway | undefined => {
    const presence = agent.landedPresence;
    if (presence === undefined) {
        return undefined;
    }
    // The hint is a clause, not a paragraph: read as the tail of `text` on one line, carrying only the fact "removed"
    // doesn't say, the branch still has it. The hover's card counts the files: how many are still in the workspace.
    const inWorkspace = { label: t(`agents.agentStatus.inWorkspace`), value: `${presence.present}/${presence.landed}` };
    const by = removedBy(presence.removedBy, me);
    const offerReland = presence.removedBy?.kind !== `agent`;
    // The common shape: the whole of it, one discard, no arithmetic to read.
    if (presence.present === 0) {
        return {
            text: by.line ?? t(`agents.agentStatus.removed`),
            hint: t(`agents.agentStatus.onBranch`),
            tip: {
                title: t(`agents.agentStatus.removedAfterLanding`),
                rows: [inWorkspace],
                note: `${t(`agents.agentStatus.stillOnBranch`)}. ${by.note}`,
            },
            icon: `link-broken`,
            offerReland,
        };
    }
    // A partial discard: the fraction is enough to decide whether enough survived.
    return {
        text: `${presence.present}/${presence.landed}`,
        tip: { title: t(`agents.agentStatus.partlyRemoved`), rows: [inWorkspace], note: `${t(`agents.agentStatus.restOnBranch`)}. ${by.note}` },
        icon: `arrows-h`,
        offerReland,
    };
};

// Who took landed work out, as the card's line (absent where "Removed" alone is all it can say) and the hover's
// sentence. The sandbox names someone only when one party acted on the workspace while the work went; otherwise the
// hover says it could have been either, and that Land again puts back what was taken out on purpose.
interface RemovalWords {
    readonly line?: string;
    readonly note: string;
}
const removedBy = (by: LandedRemover | undefined, me: string | undefined): RemovalWords => {
    if (by === undefined) {
        return { note: t(`agents.agentStatus.removedByWhom`) };
    }
    if (by.kind === `agent`) {
        const who = by.title ?? t(`agents.agentStatus.anotherAgent`);
        return { line: t(`agents.agentStatus.removedBy`, { who }), note: t(`agents.agentStatus.takenOutByAgent`, { who }) };
    }
    if (by.email !== undefined && by.email === me) {
        return { line: t(`agents.agentStatus.removedByYou`), note: t(`agents.agentStatus.takenOutByYou`) };
    }
    const who = by.name ?? by.email;
    return who === undefined
        ? { note: t(`agents.agentStatus.takenOutInChanges`) }
        : { line: t(`agents.agentStatus.removedBy`, { who }), note: t(`agents.agentStatus.takenOutBy`, { who }) };
};

// One bit, "this session isn't done yet", for surfaces that name an agent by its output rather than itself (the
// Changes panel's From legend). `laneOf` narrowed to a boolean rather than its own status list, so "finished" means
// the same thing here as on the board. A static dot, not the running spinner or a per-status icon: this is a
// filter control, and a chip per landed session would make the legend the busiest thing on the panel. `undefined`
// means the agent left the roster (archived or retired), which counts as finished.
export const unfinishedMark = (agent: AgentStanding | undefined): { dot: string; label: string } | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    const lane = laneOf(agent);
    if (lane === `finished`) {
        return undefined;
    }
    return lane === `active`
        ? { dot: `bg-link ring-2 ring-link/30`, label: activeLabel(agent) }
        : /* Named by the same reason the board's chip wears — including the bare `awaiting` this used to name
           * for itself. That fallback was the only place in the app that said something for a turn parked with
           * no flag raised, which is why it read as this mark's own quirk rather than as the hole it was; it
           * belongs to `attentionReason`, where every surface gets it. Kept here as a runtime floor for the
           * same reason STATUS_META keeps its `??`: a lane is decided by a status off an untyped wire, so a
           * build one version behind can be handed a standing it has no word for, and a chip reading
           * `undefined` in a legend is worse than one reading the plainest true thing. */
          { dot: `bg-primary-500`, label: attentionReason(agent) ?? t(`agents.agentStatus.waitingOn`) };
};

// "Working" would be wrong for the three Active cards that aren't: one is waiting on the world, one on a spent
// allowance's reset, one is being carried to another account. All restart themselves, so the label says which kind of
// unfinished rather than claiming work.
const activeLabel = (agent: AgentStanding): string => {
    // A booked move names its destination.
    const moving = limitMoveBooked(agent) ? agent.limitMoving : undefined;
    if (moving !== undefined) {
        return t(`agents.agentStatus.movingTo`, { account: moving });
    }
    if (limitScheduled(agent)) {
        return t(`agents.agentCard.resendBooked`);
    }
    return watching(agent) && !turnInFlight(agent) ? t(`agents.agentStatus.waitingOnCondition`) : t(`agents.agentStatus.stillWorking`);
};

// The card's drill-in label (desktop): names the destination rather than a generic "Open". A draft has no
// worktree yet, so no review detail. Order: a pending park first, then a special ending, then the diff, falling
// back to "Review".
export const reviewAction = (agent: AgentStanding & { readonly branch?: string; readonly diff?: { files: number } }): string | undefined => {
    if (unregistered(agent.status) || agent.branch === undefined) {
        return undefined;
    }
    // The same flag the chip led with, so the corner's noun and the card's verb are always about the same park.
    const park = leadingPark(agent);
    if (park !== undefined) {
        return attentionWords()[park].verb;
    }
    // A spent allowance is not an error to view: there's nothing to diagnose in the transcript, and the destination is
    // the conversation itself. Checked before the `error` branch below, which it would otherwise fall into.
    // Neither is a held message: the press that sends it is in the conversation. Nor a bare park on a browser or a
    // terminal, whose hand-off card is drawn there too (drillTarget).
    if (limited(agent) || memoryHeld(agent) || agent.status === `awaiting`) {
        return t(`agents.agentStatus.openChat`);
    }
    return (
        endingActions()[agent.status] ??
        (agent.diff !== undefined && agent.diff.files > 0 ? t(`agents.agentStatus.reviewChanges`) : t(`agents.words.review`))
    );
};

// Where the card's drill-in leads. An ask answered on its own card (a plan, a question, a permission, a setup, a
// release, a need, a hand-off) and a spent allowance lead to the chat, where that card and the way on are drawn: the
// review page draws none of them, and an "Approve" that led there was a round trip to a page with nothing to approve.
// A refused land's report, an error, and a diff to read are the review page's.
export const drillTarget = (agent: AgentStanding): `chat` | `review` => {
    const park = leadingPark(agent);
    if (park !== undefined) {
        return park === `conflict` ? `review` : `chat`;
    }
    return limited(agent) || memoryHeld(agent) || agent.status === `awaiting` ? `chat` : `review`;
};

// Endings whose destination is named by the ending itself rather than by the diff; tabled for the same reason as
// `endingReasons`. Anything absent falls to the diff reading below.
const endingActions = (): Partial<Record<AgentStatus | ClientAgentStatus, string>> => ({
    error: t(`agents.agentStatus.viewError`),
    // Destination is the transcript, where the cut-off tool call is itself the report. One label for both endings:
    // whether the daemon died or the user stopped it, the question is the same, how far did it get?
    interrupted: t(`agents.agentStatus.seeWhereStopped`),
    stopped: t(`agents.agentStatus.seeWhereStopped`),
    // Names both halves of the destination: reading the held work and landing it. The card's own primary button lands
    // without the trip (AgentCard).
    ready: useVocabulary().value.reviewAndLand,
});

// Whether a clean turn's work lands by itself, folding the agent's own override, the sandbox default, and the
// schema default (off) into one answer every surface must agree on. Takes plain values rather than reaching for
// stores; this module is a leaf.
export const effectiveAutoLand = (agent: { readonly autoLand?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.autoLand ?? sandboxDefault ?? false;

// The same two-level fold for what happens when a turn breaks lives in chat/run/turnBreak.ts (`effectivePolicy`),
// beside the words for each answer: one question per ending, asked in one vocabulary by every surface.

// Sources an agent can be opened by, keyed on `AgentOrigin.provider` (an open string; listener sources are
// extension-declared), so an unrecognized one falls back to its own name rather than disappearing.
const originSources = (): Record<string, { icon: IconName; label: string }> => ({
    discord: { icon: `comments`, label: `Discord` },
    slack: { icon: `comments`, label: `Slack` },
    imap: { icon: `envelope`, label: t(`agents.agentStatus.email`) },
    webchat: { icon: `globe`, label: t(`agents.agentStatus.visitorChat`) },
    webhook: { icon: `bolt`, label: t(`agents.agentStatus.webhook`) },
});

// The card's "came in from outside" line: what opened it, who sent it, and which automation was configured to
// answer. The hint carries only what OriginMark doesn't already print (source and sender), so nothing is said
// twice.
export const originMeta = (origin: AgentOrigin): { icon: IconName; label: string; detail: string | undefined; hint: string } => {
    const source = originSources()[origin.provider] ?? { icon: `wave-pulse` as IconName, label: origin.provider };
    const where = origin.channelId !== undefined ? ` in ${origin.channelId}` : ``;
    return {
        icon: source.icon,
        label: source.label,
        detail: origin.author,
        hint: t(`agents.agentStatus.openedByAutomationFirst`, { automationId: origin.automationId, where }),
    };
};

// "New" (never opened) vs. "Updated" (opened, then worked on since); the marker lives on the daemon entry so
// opening it anywhere clears it everywhere. `seenAt` is returned raw for the caller to format; this module owns no
// clock.
export const unreadBadge = (agent: { unread: boolean; seenAt?: number }): { label: string; seenAt?: number } | undefined =>
    !agent.unread
        ? undefined
        : agent.seenAt === undefined
          ? { label: t(`agents.words.new`) }
          : { label: t(`agents.agentStatus.updated`), seenAt: agent.seenAt };

// The unread chip's hover, one sentence wherever that chip is drawn; takes the formatted instant, since this module
// owns no clock (see `unreadBadge`).
export const unreadHint = (when: string): string => `Worked since you last opened it, ${when}`;

// A CARD'S CORNER IS A WORD, NOT A GLYPH, AND THE SAME WORD EVERYWHERE. "Usage limit" and "Stopped" are what the
// reader needs; a triangle in the corner names neither, and the rail and the board each used to decide the word, the
// tint and the seat for themselves. This decides all three once: what it says, how it is tinted, and (by returning
// nothing) when the resting status glyph may have the corner back.
export interface StandingChip {
    readonly label: string;
    // Tailwind fill + ink for `ui-status-pill`. An ink tint, not a surface token: a surface token collides with the
    // selected card's lifted fill and, in the light scheme, with the card fill itself.
    readonly tone: string;
    // When the reader last opened it, raw, for a host with a clock to phrase (`unreadHint`); absent on every reason chip.
    readonly seenAt?: number;
    // What the one word stands for, where it stands for more than itself: when a scheduled card's messages go.
    readonly hint?: Tip;
}

// Muted for a spent allowance: it needs a person, but nothing is wrong and nothing is lost.
const LIMIT_TONE = `bg-content/10 text-muted`;
const REASON_TONE = `bg-warning/15 text-warning`;
const UNREAD_TONE = `bg-primary-600/15 text-link`;

export const standingChip = (
    agent: AgentStanding & { readonly unread: boolean; readonly seenAt?: number },
    titleOf?: (conversationId: string) => string | undefined,
): StandingChip | undefined => {
    const reason = attentionReason(agent);
    if (reason !== undefined) {
        return { label: reason, tone: limited(agent) ? LIMIT_TONE : REASON_TONE };
    }
    // When it goes by itself outranks news: it is what a card that looks idle is waiting for. One word in the corner,
    // which a title shares the row with; when it goes is the word's hover.
    const scheduled = scheduledWhen(agent, titleOf);
    if (scheduled !== undefined) {
        return {
            label: t(`chat.chatHeld.scheduled`),
            tone: LIMIT_TONE,
            hint: { title: t(`chat.chatHeld.scheduled`), rows: [{ label: t(`chat.composerIntent.sendsAt`), value: scheduled }] },
        };
    }
    // Never both at once: "needs you" outranks "there is news".
    const badge = unreadBadge(agent);
    if (badge === undefined) {
        return undefined;
    }
    return { label: badge.label, tone: UNREAD_TONE, ...(badge.seenAt === undefined ? {} : { seenAt: badge.seenAt }) };
};

// When a conversation's booked messages go, as its card's corner says on hover: "Tue 09:00", or "After <agent> lands"
// for work waiting on another agent's land, that agent named by its card when one does (`titleOf`). Undefined for a
// conversation nothing is booked on.
export const scheduledWhen = (agent: Pick<AgentStanding, "queue">, titleOf?: (conversationId: string) => string | undefined): string | undefined => {
    const hold = agent.queue;
    if (!scheduledSend(agent) || hold === undefined) {
        return undefined;
    }
    if (hold.after !== undefined) {
        return t(`chat.sendLater.afterLands`, { title: titleOf?.(hold.after) ?? t(`chat.sendLater.anotherAgent`) });
    }
    return hold.until === undefined ? t(`chat.chatHeld.sendsShortly`) : formatWhen(hold.until);
};

// Children a family chip's hover names before counting the rest.
const CALLS_NAMED = 3;

// The corner a card wears for the children calling the reader through it (callsOwner): the one child's own word, or how
// many call, tinted as an ask (a spent allowance's muted tint when that is all they stopped on); its hover names them,
// one row each: what stopped it, and which child it is.
// The card's own reason outranks it, since that is the ask the card's own presses answer (AgentCard), and it outranks
// the card's unread mark, as any reason does.
export type FamilyChip = StandingChip & { readonly hint: Tip };
export const familyChip = (calls: readonly (AgentStanding & { readonly title?: string })[]): FamilyChip | undefined => {
    const first = calls[0];
    if (first === undefined) {
        return undefined;
    }
    const why = (child: AgentStanding): string => attentionReason(child) ?? t(`shared.needs`);
    const rest = calls.length - CALLS_NAMED;
    return {
        label: calls.length === 1 ? why(first) : t(`agents.childRows.needYou`, { count: calls.length }, calls.length),
        tone: calls.every(limited) ? LIMIT_TONE : REASON_TONE,
        hint: {
            title: t(`agents.words.childAgents`),
            rows: calls.slice(0, CALLS_NAMED).map((child) => ({ label: why(child), value: agentDisplayTitle(child) })),
            note: rest > 0 ? t(`agents.childRows.callsMore`, { count: rest }) : undefined,
        },
    };
};

// The concrete step a turn is on: the tool with what it reached for, else the checklist item it is working through.
export const currentAction = (activity: AgentSummary["activity"]): string | undefined =>
    activity?.tool !== undefined ? [activity.tool, activity.target].filter(Boolean).join(` `) : activity?.todo;

/* A working child's activity takes precedence over its parent's idle tool. */
export const activityLine = (agent: Pick<AgentSummary, "activity" | "subagents">): string | undefined => {
    const activity = agent.activity;
    const own = activity === undefined ? undefined : (activity.todo ?? activity.tool);
    const running = agent.subagents?.running ?? 0;
    if (running === 0) {
        return own;
    }
    return [`${running} subagent${running === 1 ? `` : `s`}`, own].filter(Boolean).join(` · `);
};

// Dollars with sensible precision: sub-cent turns still show something, big totals stay short.
export const formatCost = (usd: number): string => (usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

// Elapsed readout for a running turn's startedAt (ms since epoch).
export const formatElapsed = (startedAt: number, now: number): string => {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// Context-window fill percentage (0–100), clamped; undefined when either side is unknown.
export const contextPct = (tokens: number | undefined, window: number | undefined): number | undefined =>
    tokens === undefined || window === undefined || window === 0 ? undefined : Math.min(100, Math.round((tokens / window) * 100));

// Enough of an agent to draw its identity tile's rim; a FleetAgent, a roster AgentSummary and a test literal all fit.
export type RimAgent = AgentStanding & Pick<AgentSummary, "checklist" | "contextTokens" | "contextWindow">;

interface RimInk {
    // Tailwind text-* class: SegmentRing and ProgressRing both draw in `currentColor`.
    readonly tone: string;
    // One sentence naming both readings, since the rim can only draw one of them.
    readonly hint: string;
}
export type TileRim =
    | (RimInk & { readonly kind: "steps"; readonly segments: number; readonly filled: number })
    | (RimInk & { readonly kind: "context"; readonly percent: number });

const contextSpent = (percent: number): string => `${percent}% of context used`;

// Amber past 80%, the band where a compaction is close; accent below it. A quiet rim states its number without
// arguing for it, which is what a receipt and a destination row both want.
const contextRim = (percent: number, quiet: boolean): TileRim => ({
    kind: `context`,
    percent,
    tone: quiet ? `text-subtle` : percent >= 80 ? `text-warning` : `text-primary-500`,
    hint: contextSpent(percent),
});

// ONE RIM, SO ONE READING, AND THE CHECKLIST WINS IT. "2 of 4 steps" says what a session will do next; a fill
// percentage says only when it will start forgetting, which matters to fewer readers more rarely. So the context arc
// keeps the rim only for the conversations that wrote no list, which is most short ones, and rides the hover for the
// rest.
// SEGMENTS ARE ITEMS PLUS ONE, and the extra closes only once the turn settles with every item done: a list emptied
// mid-turn is not a finished session, and a ring already full while the agent works would claim it was.
export const tileRim = (agent: RimAgent, { quiet }: { quiet: boolean }): TileRim | undefined => {
    const percent = contextPct(agent.contextTokens, agent.contextWindow);
    const list = agent.checklist;
    if (list === undefined) {
        return percent === undefined ? undefined : contextRim(percent, quiet);
    }
    const done = Math.min(list.done, list.total);
    const settled = done === list.total && !turnWorking(agent);
    return {
        kind: `steps`,
        segments: list.total + 1,
        filled: settled ? list.total + 1 : done,
        tone: quiet ? `text-subtle` : `text-primary-500`,
        // Noun agrees with the total, not the count done: '1 of 4 steps', but '1 of 1 step'.
        hint: [`${done} of ${list.total} ${list.total === 1 ? `step` : `steps`} done`, percent === undefined ? undefined : contextSpent(percent)]
            .filter((part): part is string => part !== undefined)
            .join(` · `),
    };
};

// The activity line's icon by tool family, a glanceable "what is it doing" glyph, mock-style.
export const activityIcon = (tool: string | undefined): IconName => {
    if (tool === undefined) {
        return `list-check`; // a todo line without a tool
    }
    if (tool === `Edit` || tool === `Write` || tool.startsWith(`mcp__`)) {
        return `pencil`;
    }
    if (tool === `Bash` || tool === `BashOutput`) {
        return `code`;
    }
    if (tool === `Read`) {
        return `file`;
    }
    if (tool === `Grep` || tool === `Glob` || tool.includes(`search`)) {
        return `search`;
    }
    return `sparkles`;
};

// How a loop reads on a card: one line naming both the destination and the position ("iteration 3/12 · until
// <goal>"), the two facts that separate a loop from an ordinary running agent. Ended states are not folded into
// one "finished": `stalled` needs a person (nothing changed while work remained, a prompt problem, not a capacity
// one), unlike `done` or `exhausted`.
export const loopMeta = (loop: NonNullable<AgentSummary["loop"]>): { readonly text: string; readonly class: string; readonly spin: boolean } => {
    if (loop.state === `running`) {
        return { text: `Iteration ${loop.iteration}/${loop.maxIterations} · until ${loop.goal}`, class: `text-link`, spin: true };
    }
    const ended: Record<Exclude<LoopState, "running">, { readonly text: string; readonly class: string }> = {
        done: { text: `Goal met after ${loop.iteration}`, class: `text-success` },
        // Each names what to do about it: exhausted wants more room, stalled wants a better prompt, overspent wants a
        // decision.
        exhausted: { text: `Ran out of iterations after ${loop.iteration}`, class: `text-warning` },
        stalled: { text: `Stalled after ${loop.iteration}, nothing changed`, class: `text-warning` },
        overspent: { text: `Hit the spend ceiling after ${loop.iteration}`, class: `text-warning` },
        // Wants a priced runtime or no ceiling: its runtime reports no cost, so the ceiling could not hold.
        unpriced: { text: `Stopped after ${loop.iteration}: its runtime reports no cost to hold the ceiling to`, class: `text-warning` },
        stopped: { text: `Loop stopped after ${loop.iteration}`, class: `text-muted` },
        error: { text: `Loop failed after ${loop.iteration}`, class: `text-danger` },
    };
    return { ...ended[loop.state], spin: false };
};

// Threshold between a wait ("in 27m", readable at a glance) and the instant itself ("Thu 14:05", where "in 244m" would
// be arithmetic); same threshold as the chat strip's own switch (chat/pickUp.ts).
export const CLOCK_FROM_MS = 90 * 60 * 1_000;

// When a spent allowance reopens, in the few characters a card's corner has: whole minutes while that is a wait a
// person can hold (rounded up, as the chat's own press counts them), the clock later today, the day past that. Minutes,
// never seconds: the instant is the provider's guess and routinely early, so a corner ticking "26m 26s" claimed a
// precision nobody had. `wait` says which it is, since a wait reads "in 27m" and an instant stands bare ("back 14:05");
// `at` is the instant (ms), for a hover that names it whatever the corner says. Undefined once the window is open, and
// for a provider that published no instant (Grok, Cursor).
export interface LimitClock {
    readonly at: number;
    readonly text: string;
    readonly wait: boolean;
}
export const limitCountdown = (agent: AgentStanding, now: number): LimitClock | undefined => {
    const reopensAt = agent.limitResetsAt;
    if (!limitClosed(agent, now) || reopensAt === undefined) {
        return undefined;
    }
    const at = reopensAt * 1_000;
    if (at - now < CLOCK_FROM_MS) {
        return { at, text: `${Math.max(1, Math.ceil((at - now) / 60_000))}m`, wait: true };
    }
    return { at, text: new Date(at).toDateString() === new Date(now).toDateString() ? formatClock(at) : formatWhen(at, now), wait: false };
};

// "back in 27m", "back Thu 14:05": when the allowance returns, the one thing a card nothing is booked for can plan around.
export const limitBack = (clock: LimitClock): string =>
    clock.wait ? t(`agents.agentCard.backIn`, { limitBackAt: clock.text }) : t(`agents.agentCard.back`, { limitBackAt: clock.text });

// A spent allowance's words for a card's "when" corner, and what they hang on. A booked move names where it is going,
// since it goes on the resume pass's next beat, seconds away, whatever the refused account's reset says. A booked resend
// says when it goes, and that it goes in a moment once that instant has passed (the resume pass lets it go on its next
// beat), which is also what tells a card resting in Active why it is there. One nothing is booked for says when the
// allowance is back, and nothing once it is: the corner is the ordinary date's again, beside the card's own press.
export type LimitCorner =
    | { readonly kind: `moving`; readonly text: string; readonly account: string }
    | { readonly kind: `resend`; readonly text: string; readonly clock?: LimitClock }
    | { readonly kind: `back`; readonly text: string; readonly clock: LimitClock };
export const limitCorner = (agent: AgentStanding, now: number): LimitCorner | undefined => {
    if (!limited(agent)) {
        return undefined;
    }
    const moving = limitMoveBooked(agent) ? agent.limitMoving : undefined;
    if (moving !== undefined) {
        return { kind: `moving`, account: moving, text: t(`agents.agentCard.movingTo`, { account: moving }) };
    }
    const clock = limitCountdown(agent, now);
    if (limitScheduled(agent)) {
        if (clock === undefined) {
            return { kind: `resend`, text: t(`agents.agentCard.resendsShortly`) };
        }
        return {
            kind: `resend`,
            clock,
            text: clock.wait
                ? t(`agents.agentCard.resendsIn`, { limitBackAt: clock.text })
                : t(`agents.agentCard.resends`, { limitBackAt: clock.text }),
        };
    }
    return clock === undefined ? undefined : { kind: `back`, clock, text: limitBack(clock) };
};

// The watch a card's clock counts to: the first deadline to arrive is the next moment the card definitely moves. One
// definition, since the chat's own watch row asks the same question about the same conversation.
export const soonestWatch = (agent: AgentStanding): AgentWatch | undefined =>
    agent.watches?.reduce(
        (first: AgentWatch | undefined, next) => (first === undefined || next.deadlineAt < first.deadlineAt ? next : first),
        undefined,
    );

// Glyph, phrase and clock, matching the shape a running turn's own readout uses (`Bash · 1m 12s`), so the board
// has one grammar for "what is this doing and for how long". The phrase is the agent's own note, not the word
// "Watching", which tells the user nothing actionable; several watches collapse to a count since truncated notes
// in a narrow lane aren't readable. The clock counts to the deadline, the next moment this card definitely moves.
// The hint is a card: one watch's pacing and deadline as two rows, several as one row each (its note, its pacing), and
// the one line that matters about the end of the wait, that it wakes the conversation. The way out is the Stop press
// beside the readout, which says so itself.
export const watchLine = (
    agent: AgentStanding,
    now: number,
): { readonly text: string; readonly countdown: string; readonly hint: Tip } | undefined => {
    const watches = agent.watches;
    const soonest = soonestWatch(agent);
    if (watches === undefined || soonest === undefined) {
        return undefined;
    }
    // `formatElapsed` measures the second argument from the first, so `now → deadline` gives the time left, in the
    // same vocabulary as a running turn's elapsed readout.
    const countdown = formatElapsed(now, soonest.deadlineAt);
    const hint: Tip =
        watches.length === 1
            ? {
                  title: t(`agents.childRows.watching`),
                  tone: `info`,
                  rows: [
                      { label: t(`agents.agentStatus.checksEvery`), value: briefDuration(soonest.intervalSeconds) },
                      { label: t(`agents.agentStatus.givesUpIn`), value: countdown },
                  ],
                  note: t(`agents.agentStatus.wakesThisChat`),
              }
            : {
                  title: t(`agents.childRows.watching`),
                  tone: `info`,
                  rows: watches.map((watch) => ({
                      label: watch.note,
                      value: t(`agents.agentStatus.watchPace`, {
                          interval: briefDuration(watch.intervalSeconds),
                          left: formatElapsed(now, watch.deadlineAt),
                      }),
                  })),
                  note: t(`agents.agentStatus.firstWakesChat`),
              };
    return {
        text: watches.length === 1 ? soonest.note : `Watching ${watches.length} conditions`,
        countdown,
        hint,
    };
};
