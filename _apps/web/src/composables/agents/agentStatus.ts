import type { IconName } from "@intentic-app/ui";
import type { AgentAttention, AgentOrigin, AgentStatus, AgentSummary, LoopState } from "@intentic/sandbox-contract";

/* WHERE AN AGENT STANDS, and how each surface draws it. Every projection of a fleet agent's state lives here —
 * the lane machine, the "why does this need me" label, the drill-in verb, the glyphs — and NOTHING else in the
 * app is allowed to answer those questions its own way.
 *
 * That rule is load-bearing rather than tidy. The board, the chat rail and the Changes panel each ask some form
 * of "is this session done?", and the moment one of them answers from `status` alone it starts contradicting
 * the other two on screen: an agent parked on a question is `idle` in the registry with an attention flag
 * raised, so a status-only reading calls it finished while the board has it sitting in Attention. The user
 * reads that as the app being confused about its own state, and they are right.
 *
 * So `laneOf` is the single projection (the fleet store's lanes, the rail's groups, the drop targets and the
 * Changes legend's mark all derive from it), and it reads BOTH halves of the state: `status`, the turn
 * lifecycle, and `attention`, the flags a parked turn raises independently of it.
 *
 * This module is deliberately a LEAF — pure functions over plain data, no store, no query, no Vue. That is what
 * lets the panel, the rail and the tests all reach the same answer without any of them dragging in the app
 * shell (useAgents pulls useChat pulls the router). */

// Enough of an agent to place one. Every predicate below takes this and nothing more, so a caller holding a
// FleetAgent, a roster AgentSummary or a test literal can all ask the same question.
export interface AgentStanding {
    readonly status: AgentStatus | "draft";
    readonly attention: AgentAttention;
}

export const agentStatusMeta = (status: AgentStatus | "draft"): { icon: IconName; spin?: boolean; label: string; class: string } => {
    // Not `pencil` — that's the card's rename affordance; the draft glyph is a not-yet-started marker.
    if (status === `draft`) {
        return { icon: `circle`, label: `Draft`, class: `text-subtle` };
    }
    if (status === `running`) {
        return { icon: `spinner`, spin: true, label: `Running`, class: `text-link` };
    }
    // The Stop landed and the turn is walking itself out. STILL, deliberately — a spinner here is the exact
    // thing the user complained about: it says "working on your request" for the seconds between the press and
    // the turn's last breath, which is precisely when they want to be told it is over. Muted for the same
    // reason: this state is the tail of something ending, not an event of its own.
    if (status === `stopping`) {
        return { icon: `stop`, label: `Stopping…`, class: `text-subtle` };
    }
    if (status === `awaiting`) {
        return { icon: `exclamation-circle`, label: `Needs you`, class: `text-primary-500` };
    }
    if (status === `landed`) {
        return { icon: `check-circle`, label: `Landed`, class: `text-success` };
    }
    // Finished with auto-land off: the delta is safe on the branch, waiting for a deliberate Land. Link-blue,
    // not the attention hues — the user CHOSE to hold work for review, so a card in this state is an offer to
    // act, never a warning (see blocked()'s note on teaching people to ignore the word "needs you").
    if (status === `ready`) {
        return { icon: `download`, label: `Ready to land`, class: `text-link` };
    }
    if (status === `conflict`) {
        return { icon: `exclamation-triangle`, label: `Conflict`, class: `text-warning` };
    }
    if (status === `error`) {
        return { icon: `exclamation-triangle`, label: `Error`, class: `text-danger` };
    }
    // Warning, not danger: nothing FAILED here — the turn was cut off by its daemon dying (a rebuild, a crash),
    // which is a fact about the sandbox rather than about the work. The glyph is the one the Stop button wears,
    // because that is what happened to it.
    if (status === `interrupted`) {
        return { icon: `stop`, label: `Interrupted`, class: `text-warning` };
    }
    // The same shape of ending, by the user's own hand — which is why it is quieter than `interrupted` and much
    // quieter than the `error` it used to be filed as. Nothing here is news to the person reading it: they are
    // the one who pressed Stop. The card's job now is only to say where the turn got to.
    if (status === `stopped`) {
        return { icon: `stop`, label: `Stopped`, class: `text-subtle` };
    }
    return { icon: `circle-fill`, label: `Idle`, class: `text-subtle` };
};

/* A TURN IS IN FLIGHT — running, or unwinding after a Stop. The one question every "hands off this agent"
 * guard is really asking (its worktree is a live turn's working state, so it cannot be archived, discarded or
 * landed), and the one the live readouts are drawn for: the ticking elapsed and the activity line keep their
 * meaning while the daemon walks a stopped turn out, and blinking them off a beat before the card settles is
 * the same flicker this whole state exists to remove.
 *
 * `awaiting` is deliberately not here. Its turn is live too, but it is live and PARKED — the guards that read
 * this either want it excluded (a parked turn is exactly what awaitingUser answers for) or answer it in their
 * own terms. */
export const turnInFlight = (agent: AgentStanding): boolean => agent.status === `running` || agent.status === `stopping`;

// "Blocked on you" — the agent literally cannot go on (or has failed) until you act. Deliberately NOT the same
// thing as unread, which only says you haven't looked at it yet: a board that tells the user seven finished
// agents "need you" teaches them to ignore the word.
//
// `stopped` sits here beside `interrupted` for the reason the two share: a turn that ended before its work did,
// leaving a half-written worktree that only a message from the user can carry forward. Nothing is OUTSTANDING
// on their side (see awaitingUser, which excludes both) — the lane is where the card goes to be picked up again
// rather than lost among the landed ones.
export const blocked = (agent: AgentStanding): boolean =>
    agent.attention.plan ||
    agent.attention.question ||
    agent.attention.permission ||
    agent.attention.conflict ||
    agent.status === `error` ||
    agent.status === `interrupted` ||
    agent.status === `stopped`;

// The half of "blocked" that is literally WAITING TO BE TOLD SOMETHING — a plan to approve, a question, a
// permission, a paused turn. Deliberately narrower than `blocked`, which also covers the DEAD ENDS (a failed
// turn, an unlandable conflict): those want looking at, but nothing about them is outstanding on the user's
// side, so ending the agent throws away no answer it was owed. laneDrop draws the same line in the same order
// for the same reason — a drop is refused for this set and offered for the dead ends.
export const awaitingUser = (agent: AgentStanding): boolean =>
    agent.attention.plan || agent.attention.question || agent.attention.permission || agent.status === `awaiting`;

// The one-line "why this card is in the Attention lane" label — shared by the card chip, the Changes legend's
// hover card, and any future toast.
export const attentionReason = (agent: AgentStanding): string | undefined => {
    if (agent.attention.plan) {
        return `Approval needed`;
    }
    if (agent.attention.question) {
        return `Question for you`;
    }
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `Land conflict`;
    }
    if (agent.status === `error`) {
        return `Error`;
    }
    // Says what the card cannot: the turn did not fail and did not finish — the daemon under it went away. The
    // user's move is to send it a message, which starts a fresh turn on the same session.
    if (agent.status === `interrupted`) {
        return `Interrupted`;
    }
    // Same unfinished ending, one word of difference that matters: this one was the user's decision, so the chip
    // reports it rather than reporting it AT them. No "by you" — they know.
    if (agent.status === `stopped`) {
        return `Stopped`;
    }
    return undefined;
};

export type FleetLane = "attention" | "active" | "finished";

// THE projection — the board's kanban lanes, and by extension every other surface's answer to "where does this
// one stand" (see the header: two of them may never disagree on screen about the same agent). A pure reading of
// the state machine, so "finished" needs no explicit action or timer: the auto-land flow flips a
// cleanly-completed turn to landed/idle within ms of it ending, and any follow-up message moves the card
// straight back to active. Unread stays a card badge, not a promotion.
export const laneOf = (agent: AgentStanding): FleetLane => {
    if (blocked(agent) || agent.status === `awaiting` || agent.status === `conflict`) {
        return `attention`;
    }
    // `stopping` stays ACTIVE, where the card already is: the turn is still live (the daemon holds its worktree
    // until the unwind finishes), and moving it now would spend a lane change on a state that lasts seconds —
    // then spend another one the moment it settles. The card says "Stopping…" where it stands, and moves once.
    if (turnInFlight(agent) || agent.status === `draft`) {
        return `active`;
    }
    // landed | idle — the work is in the workspace (or there was none) — and `ready`, work HELD on the branch
    // because auto-land is off. Ready is finished, not attention: the turn is over and nothing is failing —
    // the user opted into a deliberate land, and the card carries that press itself.
    return `finished`;
};

/* ONE BIT — "this session isn't done with your tree yet" — for surfaces that name an agent while showing its
 * OUTPUT rather than the agent itself (the Changes panel's From legend). Those chips spend their glyph on
 * identity, so the full status vocabulary above cannot ride them; and most of it would say nothing there
 * anyway, because every chip in such a legend is by definition a session that already landed something — the
 * resting state drawn four times.
 *
 * It is `laneOf` narrowed to a boolean and NOT a status list of its own, which is the whole point: the file
 * count on a chip is a total for a finished session and an instalment for every other kind, and "finished" has
 * to mean on this panel exactly what it means on the board. A second definition here is what put an amber dot
 * on a chip whose card sat in the board's Finished lane.
 *
 * A dot, not the status icon, and NOT the running spinner: this is a filter control, and a rotating glyph per
 * chip would make the legend the busiest thing on a panel whose subject is the file list below it. The active
 * lane pulses only so the mark is told apart by behaviour from the eight identity hues a chip's tint is drawn
 * from; the attention lane is static, because a stalled session is not motion.
 *
 * `undefined` in means an agent the roster no longer carries (archived, or retired by the retention sweep),
 * which is not "unknown" for this question: leaving the board is what a finished session does. */
export const unfinishedMark = (agent: AgentStanding | undefined): { dot: string; label: string } | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    const lane = laneOf(agent);
    if (lane === `finished`) {
        return undefined;
    }
    return lane === `active`
        ? { dot: `bg-link animate-pulse`, label: `Still working` }
        : // Named by the same reason the board's chip wears. The fallback covers a bare `awaiting` — a turn
          // parked with no flag yet raised, which has nothing more specific to say than that it stopped.
          { dot: `bg-primary-500`, label: attentionReason(agent) ?? `Waiting on you` };
};

// The card's drill-in affordance label (desktop) — the verb that names what the review detail opens onto, so
// the button reads as a destination rather than a generic "open". A DRAFT has no worktree/diff yet, so it has
// no review detail (returns undefined): its click only focuses the docked chat. Everything registered has a
// destination; the label leads with why-you'd-go — pending approval/question first, then a land conflict or
// error, then a diff to look over, falling back to a plain "Review" for a running agent with nothing yet.
export const reviewAction = (agent: AgentStanding & { readonly branch?: string; readonly diff?: { files: number } }): string | undefined => {
    if (agent.status === `draft` || agent.branch === undefined) {
        return undefined;
    }
    if (agent.attention.plan) {
        return `Review plan`;
    }
    if (agent.attention.question) {
        return `Answer`;
    }
    if (agent.attention.permission) {
        return `Approve`;
    }
    /* NAMES THE REPORT, not the fix — because on a conflicted card the fix is now a button of its own, sitting
     * one line above this link (AgentCard). While this link WAS the only conflict affordance on the board it
     * read "Resolve conflict", which was the closest a navigation could get to the verb the user wanted; two
     * controls a few pixels apart both promising to resolve the conflict, only one of which does anything to
     * it, is worse than either alone. So the action keeps the verb and the link says what it opens: the report
     * — which paths refused, why, and whose move each one is. */
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `See what blocked it`;
    }
    if (agent.status === `error`) {
        return `View error`;
    }
    // The destination is the transcript, where the cut-off tool call is the last thing in it — that IS the
    // report for this state, so the label names the place rather than promising a fix the board cannot do.
    // One label for both endings: whether the daemon died or the user pressed Stop, the question the card is
    // answering is the same one — how far did it get?
    if (agent.status === `interrupted` || agent.status === `stopped`) {
        return `See where it stopped`;
    }
    // Ready names both halves of what its destination offers: the review panel is where the held work is read
    // AND where "Land now" sits. The card's own primary button lands without the trip (AgentCard).
    if (agent.status === `ready`) {
        return `Review & land`;
    }
    if (agent.diff !== undefined && agent.diff.files > 0) {
        return `Review changes`;
    }
    return `Review`;
};

/* Does a clean turn's work land into the workspace by itself, for THIS agent? The one place the two-level
 * setting is folded into an answer, so every surface that states or flips the posture (the review panel's hold
 * toggle, the landed notice's offer) agrees on what it currently is: the agent's own override when it has one,
 * else the sandbox-wide setting, else the schema default (on). Takes the pieces rather than reaching for the
 * stores — this module is a leaf (see the header). */
export const effectiveAutoLand = (agent: { readonly autoLand?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.autoLand ?? sandboxDefault ?? true;

// The sources an agent can be OPENED BY, when it wasn't opened by the user: the label and glyph the card's
// provenance line wears. Keyed by AgentOrigin.provider, which is an open string (listener sources are
// extension-declared), so an unknown one degrades to its own name rather than disappearing.
const ORIGIN_SOURCES: Record<string, { icon: IconName; label: string }> = {
    discord: { icon: `comments`, label: `Discord` },
    slack: { icon: `comments`, label: `Slack` },
    imap: { icon: `envelope`, label: `Email` },
    webchat: { icon: `globe`, label: `Doorbell` },
    webhook: { icon: `bolt`, label: `Webhook` },
};

// The card's "this conversation came in from outside" line: what opened it, who sent it, and — in the tooltip
// — which automation was configured to answer. The user never typed this agent's first message, and a card
// that doesn't say so reads as an agent they forgot starting.
//
// The hint carries ONLY what the mark itself cannot: OriginMark already prints the source and the sender
// beside the glyph, so naming them again just made the box tall enough to cover the card underneath it.
export const originMeta = (origin: AgentOrigin): { icon: IconName; label: string; detail: string | undefined; hint: string } => {
    const source = ORIGIN_SOURCES[origin.provider] ?? { icon: `wave-pulse` as IconName, label: origin.provider };
    const where = origin.channelId !== undefined ? ` in ${origin.channelId}` : ``;
    return {
        icon: source.icon,
        label: source.label,
        detail: origin.author,
        hint: `Opened by the "${origin.automationId}" automation${where} — its first prompt is not yours`,
    };
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

// The activity line's icon by tool family — a glanceable "what is it doing" glyph, mock-style.
export const activityIcon = (tool: string | undefined): IconName => {
    if (tool === undefined) {
        return `list-check`; // a todo line without a tool
    }
    if (tool === `Edit` || tool === `Write` || tool.startsWith(`mcp__hashline`)) {
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

/* HOW A LOOP READS ON A CARD — one line, and the one line has to answer "how far along" and "towards what".
 *
 * A looping agent is otherwise indistinguishable from any other running one: same spinner, same activity line,
 * same growing cost, for forty minutes. What separates them is that a loop has a DESTINATION and a POSITION, so
 * those are what the line carries, and the goal is the half that is worth the horizontal space — "iteration
 * 3/12" without it is a progress bar for an unnamed job.
 *
 * The ENDED states are not folded into one "finished". `done` and `stalled` are opposite outcomes that a status
 * dot alone would render identically, and `stalled` is the one that needs a person: it means the agent stopped
 * changing anything while still reporting work to do, which is a prompt problem and not a capacity problem.
 * Colour follows that reading — link while it runs, success for the only success, warning for the three ways it
 * gave up, danger only for a loop that actually broke.
 */
export const loopMeta = (loop: NonNullable<AgentSummary["loop"]>): { readonly text: string; readonly class: string; readonly spin: boolean } => {
    if (loop.state === `running`) {
        return { text: `Iteration ${loop.iteration}/${loop.maxIterations} · until ${loop.goal}`, class: `text-link`, spin: true };
    }
    const ended: Record<Exclude<LoopState, "running">, { readonly text: string; readonly class: string }> = {
        done: { text: `Goal met after ${loop.iteration}`, class: `text-success` },
        // Each of these says what to DO about it, because the state name alone does not: an exhausted loop
        // wants more room, a stalled one wants a better prompt, and an overspent one wants a decision.
        exhausted: { text: `Ran out of iterations after ${loop.iteration}`, class: `text-warning` },
        stalled: { text: `Stalled after ${loop.iteration} — nothing changed`, class: `text-warning` },
        overspent: { text: `Hit the spend ceiling after ${loop.iteration}`, class: `text-warning` },
        stopped: { text: `Loop stopped after ${loop.iteration}`, class: `text-muted` },
        error: { text: `Loop failed after ${loop.iteration}`, class: `text-danger` },
    };
    return { ...ended[loop.state], spin: false };
};
