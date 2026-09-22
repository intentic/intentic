import type { IconName } from "@intentic/ui";
import { briefDuration } from "@intentic/base/format";
import { formatWeekdayTime } from "@intentic/ui/format";
import type { AgentAttention, AgentOrigin, AgentStatus, AgentSummary, AgentWatch, LandConflictReason, LoopState } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

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
    // Why a refused land is still refusing (AgentSummary.conflictCauses), which decides whose press can clear it.
    // Absent for every card but one refusing to merge.
    readonly conflictCauses?: readonly LandConflictReason[];
    // Which kind of failure ended the last turn. `status: "error"` alone conflates a broken harness with a spent
    // allowance; both belong in Attention, but this says which so the card can tell them apart. `laneOf` reads it too,
    // so the lane, badge and chip stay in agreement.
    readonly failureCode?: string;
    /** When the spent allowance reopens, in epoch SECONDS (the wire's unit). Absent when nobody published one. */
    readonly limitResetsAt?: number;
    /** Whether the refused turn is held whole, so a press re-runs it rather than sending a new message after it. */
    readonly limitHeld?: boolean;
    /** Whether a fire is already booked for it at the reset, so this card needs nobody. The one lane input. */
    readonly limitScheduled?: boolean;
    /** The account the owner's policy is moving the held turn to, while that move is booked (a scheduled card's sentence). */
    readonly limitMoving?: string;
}

// A spent allowance, not a failure to fix: nothing broken, and it comes back. Read off `failureCode` rather than
// the provider's own sentence, which varies per provider; the code is the daemon's own classification
// (error-frames.ts).
export const limited = (agent: AgentStanding): boolean => agent.status === `error` && agent.failureCode === `rate_limit`;

// Whether the window is still shut, feeding only the card's countdown, never the lane: a reopening window sends
// nothing by itself, it only makes a press possible, so a stranded card stays in Attention shut or open. No
// published instant means never closed, not a guessed one.
export const limitClosed = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limited(agent) && agent.limitResetsAt !== undefined && agent.limitResetsAt * 1_000 > now;

// A booked fire needs no person: the held turn goes again at the reset either way. Only where this conversation's
// answer for the limit says so, and that answer starts at `wait`, so on an ordinary board every spent allowance lands
// in Attention.
export const limitScheduled = (agent: AgentStanding): boolean => limited(agent) && agent.limitScheduled === true;

// A refused land nothing the agent does can clear: every blocker left is a file the user has uncommitted edits on,
// which only a commit or stash releases (git cannot merge through unstaged work, and the agent's checkout cannot
// even see it). The distinction the board used to lack: it offered "have the agent resolve it" for every conflict,
// including the ones where that press was refused the moment it was made.
// False when the daemon named no causes, which is a build that predates them or a refusal it could not attribute;
// the board then falls back to offering the agent, as it always did.
export const conflictIsYours = (agent: AgentStanding): boolean =>
    agent.conflictCauses !== undefined && agent.conflictCauses.length > 0 && agent.conflictCauses.every((cause) => cause === `workspace`);

// This conversation runs again by itself, with nobody pressing anything: a watched agent's last turn ended (status
// is `idle`/`landed`/`ready`, correctly), but the conversation is not over.
export const watching = (agent: AgentStanding): boolean => (agent.watches?.length ?? 0) > 0;

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
        starting: { icon: `spinner`, spin: true, label: t(`agents.agentStatus.starting`), class: `text-link` },
        running: { icon: `spinner`, spin: true, label: t(`agents.agentStatus.running`), class: `text-link` },
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
        landing: { icon: `spinner`, spin: true, label: t(`agents.agentStatus.landing`), class: `text-link` },
        awaiting: { icon: `exclamation-circle`, label: t(`agents.agentStatus.needs`), class: `text-primary-500` },
        landed: { icon: `check-circle`, label: t(`agents.agentStatus.landed`), class: `text-success` },
        // Finished with auto-land off: work is safe on the branch, waiting for a deliberate Land. Link-blue, not an
        // attention hue, since the user chose this.
        ready: { icon: `download`, label: t(`agents.agentStatus.readyToLand`), class: `text-link` },
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

// A turn actually producing something, as a card's readouts mean it: `landing` is in flight for the hands-off guards
// but spends no model, and its `startedAt` belongs to the turn before it, so an elapsed clock would be someone else's.
export const turnWorking = (agent: AgentStanding): boolean => turnInFlight(agent) && agent.status !== `landing`;

// A person already ended this turn and it's unwinding, whether by Stop or by waving away the question it was
// parked on; both differ only in the lane they settle in (see laneOf). Narrower than `turnInFlight`, which also
// covers turns nobody ended.
export const endingByHand = (agent: AgentStanding): boolean => agent.status === `stopping` || agent.status === `dismissing`;

// The browser's copy of the daemon's `writing` guard (agents-registry.ts); exists for Land, where typing vs.
// parked matters (everything else treats them alike). `stopping` and `resuming` are excluded because the provider
// isn't producing anything then; the two sides must stay in step or the UI offers a press the daemon refuses.
export const writingNow = (agent: AgentStanding): boolean => agent.status === `running` || agent.status === `starting`;

// "Blocked on you": the agent cannot proceed (or has failed) until the user acts. Not the same as unread.
// `stopped`/`interrupted` leave a half-written worktree only a new message can carry forward; `stopping` is
// counted the moment the press lands rather than once the unwind finishes, since it settles in the same lane
// either way; `failed` is the same kind of dead end one step earlier, before a worktree existed. `limitScheduled`
// is the one exception: an armed spent-allowance card is being handled by a machine, not waiting on a person.
const BLOCKING_ENDINGS: ReadonlySet<AgentStatus | ClientAgentStatus> = new Set([`error`, `interrupted`, `stopping`, `stopped`, `failed`]);

export const blocked = (agent: AgentStanding): boolean =>
    limitScheduled(agent)
        ? false
        : agent.attention.plan ||
          agent.attention.question ||
          agent.attention.permission ||
          agent.attention.capability ||
          agent.attention.conflict ||
          BLOCKING_ENDINGS.has(agent.status);

// The half of `blocked` that is literally waiting on an answer (plan, question, permission, capability), narrower
// than `blocked`: dead ends (a failed turn, an unlandable conflict) want looking at but owe the user nothing, so
// ending the agent loses no answer.
export const awaitingUser = (agent: AgentStanding): boolean =>
    agent.attention.plan || agent.attention.question || agent.attention.permission || agent.attention.capability || agent.status === `awaiting`;

// One table for the chip word and drill-in verb per attention flag, in display rank order, so the two can't drift
// apart as they did before. `satisfies Record<keyof AgentAttention, …>` makes a new wire flag a build error until
// both words exist. Kept short: the chip is `shrink-0` beside the title, so every character taken grows at the
// agent name's expense.
const attentionWords = () =>
    ({
        plan: { chip: t(`agents.agentStatus.approvalNeeded`), verb: t(`agents.agentStatus.reviewPlan`) },
        // Outranks a question: parked on a setup only the user can do. Verb names the work, since this click leads into a
        // flow rather than a one-press approval.
        capability: { chip: t(`agents.agentStatus.setupNeeded`), verb: t(`agents.agentStatus.setUp`) },
        // Waits for an exact list of addresses the owner named; the daemon refuses everybody else
        // (secrets/credential-gate.ts). Ranked above a question, below setup: it blocks outright like a setup but is a
        // yes/no rather than a decision to read. Verb names the destination, not the action ("Release" would promise
        // something the reader may be unable to do).
        credential: { chip: t(`agents.agentStatus.releaseNeeded`), verb: t(`agents.agentStatus.seeRequest`) },
        question: { chip: t(`agents.agentStatus.question`), verb: t(`agents.agentStatus.answer`) },
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

// The one-line "why this card needs you" label, shared by the card chip, the Changes legend's hover card, and any
// future toast.
export const attentionReason = (agent: AgentStanding): string | undefined => {
    // "Usage limit": the vendor's own phrase, not "allowance" which reads as jargon. Naming the condition here is the
    // whole fix; the card's body is left to say what the card is rather than what happened to it. Short, since the
    // chip is `shrink-0` beside the agent's name.
    if (limited(agent)) {
        return t(`agents.agentStatus.usageLimit`);
    }
    const park = leadingPark(agent);
    if (park !== undefined) {
        // Same length as the generic word it replaces, and it names the half of the report the reader can act on:
        // "Land conflict" beside a button only they can press read as the agent's problem.
        return park === `conflict` && conflictIsYours(agent) ? t(`agents.agentStatus.edits`) : attentionWords()[park].chip;
    }
    // A park the attention block can't name: `awaiting` covers a browser or terminal hand-off, neither of which raises
    // a wire flag, so it arrives as a bare status. Checked last, only once nothing more specific applies.
    return endingReasons()[agent.status] ?? (agent.status === `awaiting` ? t(`agents.agentStatus.waitingOn`) : undefined);
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
export const standingFrom = (agent: AgentStanding): AgentStanding => ({
    status: agent.status,
    // Copied, not referenced: this outlives the roster entry it was read from, in a tab and in storage.
    attention: { ...agent.attention },
    ...(agent.watches !== undefined ? { watches: agent.watches } : {}),
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
    // A spent allowance reaches Attention through `blocked` alone, no branch of its own. Distinct from the `watching`
    // branch below: a watch fires and starts a turn by itself, so nothing is owed for that wait; an allowance
    // reopening sends nothing, only makes a press possible.
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
    // A stranded turn with a booked send is Active too, for the same reason as a watch: it starts working again on
    // its own, at a fixed instant. Reached only when `blocked` let it through (`limitScheduled` is its one exception);
    // stated explicitly or the card would fall through to Finished.
    if (limitScheduled(agent)) {
        return `active`;
    }
    // `landed`/`idle`/`ready` all finish here: `ready` is work held on the branch because auto-land is off, still
    // finished rather than attention since nothing is failing. `resumed` lands here too: nothing running, nothing
    // owed.
    return `finished`;
};

// What the card says when landed work is no longer in the workspace, in whole or in part. A land arrives as
// uncommitted changes the user can discard like anything else in the Changes panel, which other readings (taken
// between commits) can't see (landed-presence.ts). A qualifier on `landed`, not a status of its own: the lane
// stays Finished since the user already made that decision, and it's orthogonal to the turn lifecycle (a
// since-resumed agent can equally have had its land discarded). Undefined when nothing is missing, which is nearly
// all agents.
export const landedAway = (agent: {
    readonly landedPresence?: { readonly landed: number; readonly present: number };
}): { text: string; hint?: string; title: string; icon: IconName } | undefined => {
    const presence = agent.landedPresence;
    if (presence === undefined) {
        return undefined;
    }
    // The hint is a clause, not a paragraph: read as the tail of `text` on one line, carrying only the fact "removed"
    // doesn't say, the branch still has it.
    // The common shape: the whole of it, one discard, no arithmetic to read.
    if (presence.present === 0) {
        return {
            text: t(`agents.agentStatus.removed`),
            hint: t(`agents.agentStatus.onBranch`),
            title: t(`agents.agentStatus.removedWorkspaceStillOn`),
            icon: `link-broken`,
        };
    }
    // A partial discard: the fraction is enough to decide whether enough survived; the full sentence is in `title` for
    // hover.
    return {
        text: `${presence.present}/${presence.landed}`,
        title: t(`agents.agentStatus.filesStillInWorkspace`, { present: presence.present, landed: presence.landed }),
        icon: `arrows-h`,
    };
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

// "Working" would be wrong for the two Active cards that aren't: one is waiting on the world, one on a clock. Both
// restart themselves, so the label says which kind of unfinished rather than claiming work in progress.
const activeLabel = (agent: AgentStanding): string => {
    if (limitScheduled(agent)) {
        // A booked move names its destination; the hour is shown separately, in the corner.
        return agent.limitMoving === undefined
            ? t(`agents.agentStatus.sendsItselfAgain`)
            : t(`agents.agentStatus.movingTo`, { account: agent.limitMoving });
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
    if (limited(agent)) {
        return t(`agents.agentStatus.openChat`);
    }
    return (
        endingActions()[agent.status] ??
        (agent.diff !== undefined && agent.diff.files > 0 ? t(`agents.agentStatus.reviewChanges`) : t(`agents.agentStatus.review`))
    );
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
    ready: t(`agents.agentStatus.reviewLand`),
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
          ? { label: t(`agents.agentStatus.new`) }
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
}

// Muted for a spent allowance: it needs a person, but nothing is wrong and nothing is lost.
const LIMIT_TONE = `bg-content/10 text-muted`;
const REASON_TONE = `bg-warning/15 text-warning`;
const UNREAD_TONE = `bg-primary-600/15 text-link`;

export const standingChip = (agent: AgentStanding & { readonly unread: boolean; readonly seenAt?: number }): StandingChip | undefined => {
    const reason = attentionReason(agent);
    if (reason !== undefined) {
        return { label: reason, tone: limited(agent) ? LIMIT_TONE : REASON_TONE };
    }
    // Never both at once: "needs you" outranks "there is news".
    const badge = unreadBadge(agent);
    if (badge === undefined) {
        return undefined;
    }
    return { label: badge.label, tone: UNREAD_TONE, ...(badge.seenAt === undefined ? {} : { seenAt: badge.seenAt }) };
};

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

// Context-window fill percentage (0–100), clamped; undefined when either side is unknown. Private: `tileRim` is the
// only reader, and a second caller would be a second opinion about what the rim says.
const contextPct = (tokens: number | undefined, window: number | undefined): number | undefined =>
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
        stopped: { text: `Loop stopped after ${loop.iteration}`, class: `text-muted` },
        error: { text: `Loop failed after ${loop.iteration}`, class: `text-danger` },
    };
    return { ...ended[loop.state], spin: false };
};

// Threshold between showing an hour-count ("4h 11m", readable at a glance) and a day+hour ("74h 12m" would be
// arithmetic); same threshold as the chat strip's own switch (chat/pickUp.ts). Undefined for a card with no
// published reset instant (Grok, Cursor).
const CLOCK_FROM_MS = 90 * 60 * 1_000;

export const limitCountdown = (agent: AgentStanding, now: number): string | undefined => {
    const reopensAt = agent.limitResetsAt;
    if (!limitClosed(agent, now) || reopensAt === undefined) {
        return undefined;
    }
    const at = reopensAt * 1_000;
    return at - now >= CLOCK_FROM_MS ? formatWeekdayTime(at) : formatElapsed(now, at);
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
// The hint is one flowing line because the tooltip renders via `textContent` in a clamped box
// (ui/styles/tooltip.css) where a newline just becomes a space, and it ends by naming what pressing the card costs
// (nothing but the wait), since a tooltip that explains a mechanism with no stated exit reads as un-endable.
export const watchLine = (
    agent: AgentStanding,
    now: number,
): { readonly text: string; readonly countdown: string; readonly hint: string } | undefined => {
    const watches = agent.watches;
    const soonest = soonestWatch(agent);
    if (watches === undefined || soonest === undefined) {
        return undefined;
    }
    // `formatElapsed` measures the second argument from the first, so `now → deadline` gives the time left, in the
    // same vocabulary as a running turn's elapsed readout.
    const countdown = formatElapsed(now, soonest.deadlineAt);
    const detail = watches
        .map((watch) => `${watch.note} (checked every ${briefDuration(watch.intervalSeconds)}, gives up in ${formatElapsed(now, watch.deadlineAt)})`)
        .join(`; `);
    return {
        text: watches.length === 1 ? soonest.note : `Watching ${watches.length} conditions`,
        countdown,
        hint: t(`agents.agentStatus.watchingFirstThoseTo`, { detail }),
    };
};
