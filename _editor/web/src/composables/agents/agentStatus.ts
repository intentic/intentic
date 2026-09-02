import type { IconName } from "@intentic/ui";
// The one formatter this module reaches for, and only for an instant far enough out that a countdown stops
// being readable (see CLOCK_FROM_MS). Everything else about time here is arithmetic, not words.
import { formatWeekdayTime } from "@intentic/ui/format";
import type { AgentAttention, AgentOrigin, AgentStatus, AgentSummary, AgentWatch, LoopState } from "@intentic/sandbox-contract";

/* WHERE AN AGENT STANDS, and how each surface draws it. Every projection of a fleet agent's state lives here,
 * the lane machine, the "why does this need me" label, the drill-in verb, the glyphs, and NOTHING else in the
 * app is allowed to answer those questions its own way.
 *
 * That rule is functional rather than tidy. The board, the chat rail and the Changes panel each ask some form
 * of "is this session done?", and the moment one of them answers from `status` alone it starts contradicting
 * the other two on screen: an agent parked on a question is `idle` in the registry with an attention flag
 * raised, so a status-only reading calls it finished while the board has it sitting in Attention. The user
 * reads that as the app being confused about its own state, and they are right.
 *
 * So `laneOf` is the single projection (the fleet store's lanes, the rail's groups, the drop targets and the
 * Changes legend's mark all derive from it), and it reads BOTH halves of the state: `status`, the turn
 * lifecycle, and `attention`, the flags a parked turn raises independently of it.
 *
 * This module is deliberately a LEAF, pure functions over plain data, no store, no query, no Vue. That is what
 * lets the panel, the rail and the tests all reach the same answer without any of them dragging in the app
 * shell (useAgents pulls useChat pulls the router). */

/* THE FOUR STANDINGS THE DAEMON NEVER ASSIGNS, a conversation the fleet has not registered, in the shapes
 * that difference comes in. `draft` is one that has not been sent yet; `starting` is one whose turn has GONE
 * but which the daemon has not filed as an agent yet; `failed` is one whose send was REFUSED, so it never
 * became an agent and never will until the user sends again; `resumed` is a past conversation reopened from
 * History, whose agent entry is long gone (or never existed, a plain chat).
 *
 * They are told apart because they belong in different lanes and offer different things. A draft is the tab you
 * are about to type into and reads as Active; a refused one is a dead end that needs the user, and reading it
 * as a draft is what left the board carrying cards that looked like work in flight, sorted ABOVE the agents
 * actually working, with no action on them at all. A RESUMED one is the same mistake in its oldest form: a
 * conversation from three weeks ago, with a full transcript behind it, was arriving as a "Draft" at the head of
 * the Active lane, the board announcing the user's own history as brand-new work. It is finished, because it
 * is: nothing is running and nothing is owed. What all four share, no registry entry, so nothing to archive,
 * review, land or drop, is `unregistered` below.
 *
 * `starting` IS THE ONE THAT USED TO LIE. A sent turn was reported as the wire's own `running`, which reads as
 * "the registry says this agent is working", so every guard that asks "does the daemon know this card" was
 * answered yes about a card it has never heard of. Clicking one therefore latched the tab as registered and the
 * card vanished off the board with no entry to replace it; nothing could archive it and nothing could close it,
 * and only a reload brought it back. The gap it covers is normally a blink (send → the daemon's first roster
 * frame) and is not always one, a daemon under load takes longer to file the turn than the click takes to draw.
 * However long it lasts, it is exactly when the board has to be honest about what it does and does not know.
 *
 * None may be widened into AgentStatus: the wire enum is the daemon's account of agents it HAS, and these
 * four are by definition the cards it has never heard of. */
export type ClientAgentStatus = "draft" | "starting" | "failed" | "resumed";

// Enough of an agent to place one. Every predicate below takes this and nothing more, so a caller holding a
// FleetAgent, a roster AgentSummary or a test literal can all ask the same question.
export interface AgentStanding {
    readonly status: AgentStatus | ClientAgentStatus;
    readonly attention: AgentAttention;
    /* The outside conditions this conversation is parked on (AgentSummary.watches). A THIRD half of the state,
     * beside the turn lifecycle and the attention flags, and it belongs in the standing for exactly the reason
     * the header gives about the other two: `laneOf` reads it, so anything answering "is this session done?"
     * from `status` alone would contradict the board on screen. Absent for nearly every conversation. */
    readonly watches?: readonly AgentWatch[];
    /* WHICH KIND OF FAILURE ENDED THE LAST TURN, and when the allowance behind it comes back: the FOURTH half
     * of the state, and the one that was missing for longest.
     *
     * `status: "error"` is a single word doing the work of two very different situations. A harness that died
     * mid-run is broken and needs a person; an allowance that ran out is neither, and the difference between
     * them is a fact the daemon has always known and the board could not see. So a spent allowance was drawn
     * with the whole failure vocabulary, a red sentence, an "Error" chip, a "View error" link into a transcript
     * that holds nothing to view, and it sat in the Attention lane for as long as it took somebody to notice,
     * hours after the window it was waiting for had reopened.
     *
     * `laneOf` reads both, which is why they belong here rather than on the card: the lane, the badge and the
     * chip have to agree, and the only way they ever do in this file is by reading the same standing. */
    readonly failureCode?: string;
    /** When the spent allowance reopens, in epoch SECONDS (the wire's unit). Absent when nobody published one. */
    readonly limitResetsAt?: number;
    /** Whether the refused turn is held whole, so a press RE-RUNS it rather than sending a message after it. */
    readonly limitHeld?: boolean;
}

/* A SPENT ALLOWANCE, WHICH IS THE ONE "FAILURE" HERE THAT NOBODY HAS TO FIX. Nothing is broken, no credential
 * is dead, no request is malformed: a budget ran out and it comes back. That is a WAIT, and the whole point of
 * naming it is that a wait and a crash want opposite treatments on screen, one is muted and counts down, the
 * other is red and asks for a person.
 *
 * Read off the code rather than the sentence, deliberately. The sentence is the provider's and changes with
 * their wording (and there are six providers); the code is the daemon's own classification, decided once where
 * the failure was understood (error-frames.ts) and carried here precisely so no surface has to guess. */
export const limited = (agent: AgentStanding): boolean => agent.status === `error` && agent.failureCode === `rate_limit`;

/* …and whether the window it named is still SHUT, which is the question every lane and badge decision below
 * actually turns on. A limit with the window shut owes the user nothing but patience; the same card an hour
 * later, with the window open, owes them one press.
 *
 * A limit with NO published instant reads as open, which is the conservative answer and the right one: with
 * nothing to wait for there is nothing to hold the card out of Attention for, and the press is live now. */
export const limitClosed = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limited(agent) && agent.limitResetsAt !== undefined && agent.limitResetsAt * 1_000 > now;

/* THIS CONVERSATION WILL RUN AGAIN BY ITSELF, with nobody pressing anything. The narrowest reading of a watch,
 * and the one the lane machine below is really asking for.
 *
 * A watching agent's last turn ENDED: the daemon files it `idle` (or `landed`, or `ready`), which is true and
 * is why the status is left alone. What the status cannot carry is that the conversation is not over, and that
 * is the difference between a board a user can trust overnight and one that announces work as finished hours
 * before it wakes up and carries on. */
export const watching = (agent: AgentStanding): boolean => (agent.watches?.length ?? 0) > 0;

/* NO REGISTRY ENTRY BEHIND THIS CARD, the guard every fleet mutation needs and the one question both
 * client-only standings answer the same way. Archiving, reviewing, landing, discarding and dropping all address
 * an agent BY ID through the daemon, and this card's id names nothing there: the requests 404, and the ones
 * that don't would register the conversation as a side effect of filing it away. */
// Takes the status alone, like agentStatusMeta and unlike the lane predicates: it is a question about which
// half of the world the card came from, and the callers that need it most (the tab `open` builds, the detail
// page's `registered`) hold a status without an attention block to pair it with.
export const unregistered = (status: AgentStatus | ClientAgentStatus): boolean =>
    status === `draft` || status === `starting` || status === `failed` || status === `resumed`;

/* HOW EACH STANDING LOOKS AND READS, one entry per status and no fallthrough.
 *
 * A TABLE RATHER THAN AN IF-CHAIN, and the difference is not tidiness: the chain ended in a bare
 * `return { label: 'Idle' }`, so every status it did not name got drawn as a finished agent. That is the exact
 * failure a new wire status produces, one arrives, nobody edits this file, and the board quietly reports a
 * working (or stopping, or parked) agent as idle. `satisfies` over the full union makes the omission a build
 * error instead, which is the only way this stays true as the enum grows. */
const STATUS_META = {
    // Not `pencil`, that's the card's rename affordance; the draft glyph is a not-yet-started marker.
    draft: { icon: `circle`, label: `Draft`, class: `text-subtle` },
    // A conversation reopened from History. It says where it came from rather than how it ended, because how it
    // ended is not knowable here, the entry that would have said is gone, which is the whole reason this
    // standing exists. The glyph is the one the search footer files these under ("In earlier chats"), so the
    // row and the card it turns into wear the same mark.
    resumed: { icon: `history`, label: `Earlier chat`, class: `text-subtle` },
    // The send was refused, so there is no turn to have failed and nothing of the user's is at risk, warning
    // rather than the `error` danger, the same reading `interrupted` gets for the same reason. What separates
    // it from every state below is that this agent does not exist: it is a card for work that never started.
    failed: { icon: `exclamation-triangle`, label: `Didn't start`, class: `text-warning` },
    // The turn has gone and the daemon has not filed it yet. The running spinner and the running blue, because
    // that is what it is, work in flight, and the word is the whole of the difference: this card is drawn from
    // what THIS BROWSER knows, so nothing on it can be the registry's account of the agent yet.
    starting: { icon: `spinner`, spin: true, label: `Starting…`, class: `text-link` },
    running: { icon: `spinner`, spin: true, label: `Running`, class: `text-link` },
    // The Stop landed and the turn is walking itself out. STILL, deliberately, a spinner here is the exact
    // thing the user complained about: it says "working on your request" for the seconds between the press and
    // the turn's last breath, which is precisely when they want to be told it is over. Muted for the same
    // reason: this state is the tail of something ending, not an event of its own.
    stopping: { icon: `stop`, label: `Stopping…`, class: `text-subtle` },
    // The same window after the other ending a person chooses, waving away the question the turn was parked on.
    // It wears the ending it is HEADING for, not the machinery of getting there: nothing is owed once the card
    // is dismissed, so this reads as the finish it is about to become rather than as a second kind of halt.
    dismissing: { icon: `check-circle`, label: `Finishing…`, class: `text-subtle` },
    // The turn stopped without ending, something underneath it broke and the daemon is already undoing it. The
    // running spinner and the running blue, deliberately: nothing failed that the user has to know about, the
    // work is still in progress, and the whole point of this state is that the card goes on saying so.
    resuming: { icon: `spinner`, spin: true, label: `Resuming…`, class: `text-link` },
    awaiting: { icon: `exclamation-circle`, label: `Needs you`, class: `text-primary-500` },
    landed: { icon: `check-circle`, label: `Landed`, class: `text-success` },
    // Finished with auto-land off: the delta is safe on the branch, waiting for a deliberate Land. Link-blue,
    // not the attention hues, the user CHOSE to hold work for review, so a card in this state is an offer to
    // act, never a warning (see blocked()'s note on teaching people to ignore the word "needs you").
    ready: { icon: `download`, label: `Ready to land`, class: `text-link` },
    conflict: { icon: `exclamation-triangle`, label: `Conflict`, class: `text-warning` },
    error: { icon: `exclamation-triangle`, label: `Error`, class: `text-danger` },
    // Warning, not danger: nothing FAILED here, the turn was cut off by its daemon dying (a rebuild, a crash),
    // which is a fact about the sandbox rather than about the work. The glyph is the one the Stop button wears,
    // because that is what happened to it.
    interrupted: { icon: `stop`, label: `Interrupted`, class: `text-warning` },
    // The same shape of ending, by the user's own hand, which is why it is quieter than `interrupted` and much
    // quieter than the `error` it used to be filed as. Nothing here is news to the person reading it: they are
    // the one who pressed Stop. The card's job now is only to say where the turn got to.
    stopped: { icon: `stop`, label: `Stopped`, class: `text-subtle` },
    idle: { icon: `circle-fill`, label: `Idle`, class: `text-subtle` },
} as const satisfies Record<AgentStatus | ClientAgentStatus, { icon: IconName; spin?: boolean; label: string; class: string }>;

/* The `??` is unreachable by the types and deliberately kept anyway, because the two failures are not
 * comparable: an unknown status drawn as `Idle` is one wrong word on one card, and an unknown status read off
 * the end of the table is `undefined.icon` in a render, which takes the whole board down. The wire is not typed
 * at runtime (a roster frame is cast, not parsed), so "a status this build has never heard of" is a thing a
 * daemon one version ahead can genuinely send. `satisfies` above is what makes the omission a BUILD error for
 * anyone editing this repo; this is what stops it being a blank screen for anyone running it. */
export const agentStatusMeta = (status: AgentStatus | ClientAgentStatus): { icon: IconName; spin?: boolean; label: string; class: string } =>
    STATUS_META[status] ?? STATUS_META.idle;

/* A TURN IS IN FLIGHT, running, unwinding after a Stop, or waiting out the blocker that killed it. The one
 * question every "hands off this agent" guard is really asking (its worktree is a live turn's working state, so
 * it cannot be archived, discarded or landed), and the one the live readouts are drawn for: the ticking elapsed
 * and the activity line keep their meaning while the daemon walks a stopped turn out, and blinking them off a
 * beat before the card settles is the same flicker this whole state exists to remove.
 *
 * `resuming` belongs here on both counts. Its worktree is the working state of a turn that is about to run
 * again in it, so every hands-off guard means the same thing it means for a running one, and the wait is the
 * daemon's own bookkeeping being repaired, so a card that stopped reading as work-in-progress halfway through
 * is the flicker again, only slower.
 *
 * `starting` belongs here for the readouts alone, and it costs the guards nothing: a turn that has gone IS in
 * flight, its elapsed should tick from the moment of the send rather than from whenever the daemon gets round
 * to filing it, while every hands-off guard already refuses it one question earlier, because a card with no
 * registry entry has nothing for those verbs to address (`unregistered`).
 *
 * `dismissing` belongs here for the GUARDS and nowhere else, and it is the one entry whose lane is decided
 * above this predicate rather than by it (see laneOf). Its turn is unwinding exactly like a stopped one's, so
 * its worktree is just as much a live turn's working state; where it comes to rest is a separate question, and
 * the answer is Finished.
 *
 * `awaiting` is deliberately not here. Its turn is live too, but it is live and PARKED, the guards that read
 * this either want it excluded (a parked turn is exactly what awaitingUser answers for) or answer it in their
 * own terms. */
export const turnInFlight = (agent: AgentStanding): boolean =>
    agent.status === `running` ||
    agent.status === `starting` ||
    agent.status === `stopping` ||
    agent.status === `dismissing` ||
    agent.status === `resuming`;

/* A PERSON ALREADY ENDED THIS TURN and it is walking itself out, either way of ending it: Stop pressed, or the
 * question it was parked on waved away. The two differ only in the lane they come to rest in (see laneOf), and
 * every surface that asks "is there anything left for the user to press here" wants them treated alike, because
 * for both the answer is no, the press has been made and the daemon is unwinding.
 *
 * Narrower than turnInFlight, which also covers turns nobody has ended, and it exists so the board's drop rules
 * cannot come to mean one thing by Stop and another by a dismissal. */
export const endingByHand = (agent: AgentStanding): boolean => agent.status === `stopping` || agent.status === `dismissing`;

/* THE AGENT IS WRITING RIGHT NOW, the browser's copy of the daemon's `writing` guard (agents-registry.ts),
 * and the narrowest live reading on this file.
 *
 * It exists for Land, which is the one action whose answer differs between a turn that is TYPING and a turn
 * that is PARKED. Everything else on this page treats them alike: `turnInFlight` deliberately excludes
 * `awaiting` and the guards that care answer it in their own terms, this is one of those terms.
 *
 * `stopping` and `resuming` are absent for the same reason the daemon leaves them out: the provider is not
 * producing anything, so nothing can be caught half-written. The two sides must agree on this or the UI offers
 * a press the daemon refuses, so keep them in step. */
export const writingNow = (agent: AgentStanding): boolean => agent.status === `running` || agent.status === `starting`;

// "Blocked on you", the agent literally cannot go on (or has failed) until you act. Deliberately NOT the same
// thing as unread, which only says you haven't looked at it yet: a board that tells the user seven finished
// agents "need you" teaches them to ignore the word.
//
// `stopped` sits here beside `interrupted` for the reason the two share: a turn that ended before its work did,
// leaving a half-written worktree that only a message from the user can carry forward. Nothing is OUTSTANDING
// on their side (see awaitingUser, which excludes both), the lane is where the card goes to be picked up again
// rather than lost among the landed ones.
//
// `stopping` IS THAT SAME CARD, said the moment the press lands instead of once the unwind is over. The two are
// one ending in two halves and they have always come to rest in the same place, so treating the first half as
// undecided bought nothing and cost the press its result: the card sat in Active wearing "Stopping…" for the
// seconds the provider took to unwind, which on a turn holding a big tool call is a visible pause between
// pressing Stop in the chat and the board agreeing that anything happened. It is the same lane either way, so
// this is one move at the press rather than none now and one later.
//
// `failed` is the same kind of ending one step earlier: the turn was refused before it ran, so there is no
// half-written worktree, only the words the user typed, waiting in the composer's queue for a send that works.
// It is here rather than in Active because a card nobody can act on has no business sitting among the agents
// that are working, wearing the lane that says they are.
//
// A SPENT ALLOWANCE WITH ITS WINDOW STILL SHUT IS THE ONE `error` THAT IS NOT HERE, and it is the same argument
// the paragraph above makes about unread cards, made about a clock. Nothing is blocked on the user: the turn is
// waiting for an allowance to come back, at an instant the provider named, and no press before then does
// anything a press after it would not do better. Counting it taught the badge to cry wolf for eight hours at a
// stretch, on the one condition in this product that reliably resolves itself.
//
// It rejoins the moment the window opens (limitClosed goes false), which is exactly when there IS something
// owed: one press, on a turn the daemon is still holding.
// The five ENDINGS that block, as a set rather than a chain of comparisons: each has its paragraph above, and
// listing them once here is what keeps this predicate readable now that it has an exception to state first.
const BLOCKING_ENDINGS: ReadonlySet<AgentStatus | ClientAgentStatus> = new Set([`error`, `interrupted`, `stopping`, `stopped`, `failed`]);

export const blocked = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limitClosed(agent, now)
        ? false
        : agent.attention.plan ||
          agent.attention.question ||
          agent.attention.permission ||
          agent.attention.service ||
          agent.attention.capability ||
          agent.attention.conflict ||
          BLOCKING_ENDINGS.has(agent.status);

// The half of "blocked" that is literally WAITING TO BE TOLD SOMETHING, a plan to approve, a question, a
// permission, a paused turn. Deliberately narrower than `blocked`, which also covers the DEAD ENDS (a failed
// turn, an unlandable conflict): those want looking at, but nothing about them is outstanding on the user's
// side, so ending the agent throws away no answer it was owed. laneDrop draws the same line in the same order
// for the same reason, a drop is refused for this set and offered for the dead ends.
export const awaitingUser = (agent: AgentStanding): boolean =>
    agent.attention.plan ||
    agent.attention.question ||
    agent.attention.permission ||
    agent.attention.service ||
    agent.attention.capability ||
    agent.status === `awaiting`;

// The one-line "why this card is in the Attention lane" label, shared by the card chip, the Changes legend's
// hover card, and any future toast.
export const attentionReason = (agent: AgentStanding, now: number = Date.now()): string | undefined => {
    /* THE WAIT, FIRST, because it outranks the word this card would otherwise wear. A spent allowance is a
     * `status: "error"` and would fall through to "Error" below, which is the whole complaint: an amber chip
     * reading Error over a red sentence, for a condition that is neither an error nor anything the reader can
     * act on for the next several hours.
     *
     * Two words for the two halves of it, because they ask for opposite things. Shut, the chip reports a wait
     * and the card's own line carries the hour (limitLine). Open, it names the press that is now live, which is
     * also the only moment this card sits in the Attention lane at all. */
    /* ONE WORD WHILE IT WAITS, and the brevity is load-bearing rather than stylistic. This chip is `shrink-0`
     * beside a title that is not, so every character here is taken off the title at lane width: "Waiting on
     * limit" rendered two cards as "In…" and "C…", which is a card that has stopped being able to say which
     * agent it is. "Waiting" is the length of the words it sits beside ("Error", "Stopped"), and what it is
     * waiting FOR is on the card's own line an inch below. */
    if (limited(agent)) {
        return limitClosed(agent, now) ? `Waiting` : `Send again`;
    }
    if (agent.attention.plan) {
        return `Approval needed`;
    }
    // Money outranks a generic question: the agent is parked on a priced run only your click can release.
    if (agent.attention.service) {
        return `Spend approval`;
    }
    // Same rank as spend, same reason: the agent is parked on a setup only you can do.
    if (agent.attention.capability) {
        return `Setup needed`;
    }
    if (agent.attention.question) {
        return `Question for you`;
    }
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `Land conflict`;
    }
    return ENDING_REASONS[agent.status];
};

/* THE ENDINGS, as a table, once every flag above has had its say. A table rather than the if-chain this used to
 * be, for the reason the file's other tables give: the chain was five near-identical branches whose only
 * content was a word, and a sixth condition had to be stated ahead of them all (see limited, at the top of
 * attentionReason), which is when five near-identical branches stop being readable.
 *
 * Absent means the card is not in the Attention lane for a reason worth a chip, which is every ordinary card. */
const ENDING_REASONS: Partial<Record<AgentStatus | ClientAgentStatus, string>> = {
    error: `Error`,
    // Names the whole of what happened, in the tense that matters: not "failed" (nothing ran to fail) and not
    // "error" (there is no agent to have erred). The chip's job here is to stop the card being read as an agent
    // at all, what the user does about it is close it, and the reason is on the red line in its chat.
    failed: `Didn't start`,
    // Says what the card cannot: the turn did not fail and did not finish, the daemon under it went away. The
    // user's move is to send it a message, which starts a fresh turn on the same session.
    interrupted: `Interrupted`,
    // Same unfinished ending, one word of difference that matters: this one was the user's decision, so the chip
    // reports it rather than reporting it AT them. No "by you", they know. `stopping` is the same card a beat
    // earlier (see blocked), and says so in the tense it is actually in: the provider is still unwinding.
    stopping: `Stopping`,
    stopped: `Stopped`,
};

export type FleetLane = "attention" | "active" | "finished";

// THE projection, the board's kanban lanes, and by extension every other surface's answer to "where does this
// one stand" (see the header: two of them may never disagree on screen about the same agent). A pure reading of
// the state machine, so "finished" needs no explicit action or timer: the auto-land flow flips a
// cleanly-completed turn to landed/idle within ms of it ending, and any follow-up message moves the card
// straight back to active. Unread stays a card badge, not a promotion.
export const laneOf = (agent: AgentStanding, now: number = Date.now()): FleetLane => {
    /* AN ALLOWANCE THAT HAS NOT COME BACK YET IS ACTIVE, ahead of everything, and it is the `watching` argument
     * below made about a clock instead of about a condition. Nothing is running, so every reading further down
     * files this card under a settled lane; what is true is that this conversation is waiting on the world, at
     * an instant the world already named.
     *
     * ACTIVE RATHER THAN ATTENTION for the reason `blocked` now gives: nothing is owed by the USER while the
     * window is shut. A press before the reset buys nothing a press after it would not buy, so a lane that
     * demands one is demanding it for the sake of the demand, and eight hours of that is how "needs you" stops
     * meaning anything. The card still says exactly where it stands, muted, with the hour on it (limitLine).
     *
     * AND IT COMES BACK BY ITSELF, which is what makes the placement honest rather than a way of hiding a
     * problem: the moment the reset passes this returns false, the card moves into Attention wearing a press,
     * and if the conversation is armed the daemon has already fired it and the card is running. Every other
     * card in this lane is one somebody is waiting on; so is this one. */
    if (limitClosed(agent, now)) {
        return `active`;
    }
    if (blocked(agent, now) || agent.status === `awaiting` || agent.status === `conflict`) {
        return `attention`;
    }
    /* A DISMISSAL IS FINISHED FROM THE PRESS, ahead of the in-flight reading below, and it is the other half of
     * what `blocked` does with `stopping` one branch up. Both are unwinds of a turn a person ended, so both are
     * "in flight" to every hands-off guard; where they REST is not the same question and not the same answer,
     * and the daemon now says which is which rather than leaving both surfaces to wait and see.
     *
     * A card waved away is one the user is done with, so it goes where the finished work goes, immediately. It
     * used to hold its place through the unwind and move on finish(), which was right about the destination and
     * wrong about the timing: the press had no result until the turn's generator had walked itself out. */
    if (agent.status === `dismissing`) {
        return `finished`;
    }
    // `resuming` is the case that proves in-flight has to outrank the settled readings below: a card that
    // dropped into Finished for the seconds a credential takes to re-mint, and climbed back out, moved twice to
    // say nothing at all.
    if (turnInFlight(agent) || agent.status === `draft`) {
        return `active`;
    }
    /* AN ARMED WATCH IS ACTIVE, and it is the `resuming` argument stretched from seconds to hours. Nothing is
     * running, so every reading below would file this card under Finished; then the daemon's check passes at
     * 3am and the same conversation starts working, in front of somebody who was told it was done.
     *
     * Active rather than Attention, because nothing is owed by the USER: the agent is waiting on the world, not
     * on a person, and a board that says "needs you" about a card needing nobody is how the word stops meaning
     * anything (see `blocked`). Active is also what keeps "Clear finished" honest: sweeping a watching agent
     * into the archive used to be a press that appeared to end it and did not, the watch stayed armed and
     * dragged the card back onto the board when it fired.
     *
     * Below the in-flight readings on purpose: an agent that armed a watch and is now running again is running,
     * and both facts stay true on the card (the watch line draws either way). */
    if (watching(agent)) {
        return `active`;
    }
    // landed | idle, the work is in the workspace (or there was none), and `ready`, work HELD on the branch
    // because auto-land is off. Ready is finished, not attention: the turn is over and nothing is failing,
    // the user opted into a deliberate land, and the card carries that press itself. `resumed` lands here too,
    // and it is the same reading: a conversation reopened from History has nothing running and owes nothing.
    return `finished`;
};

/* WHAT THE CARD SAYS WHEN LANDED WORK IS NO LONGER IN THE WORKSPACE, the sentence, and the fraction when it
 * is only part of it.
 *
 * A land arrives as uncommitted changes, so the user can discard it in the Changes panel like anything else,
 * and every other reading on a card is taken between commits and cannot see that happen (landed-presence.ts
 * on the daemon side). Unsaid, the card goes on wearing `Landed` and the session menu goes on offering a
 * greyed-out land captioned "Already in your workspace", over a tree that no longer holds a line of it.
 *
 * IT IS A QUALIFIER ON `landed`, NOT A STATUS OF ITS OWN, and that is deliberate on both counts. The lane is
 * still Finished: the user discarded that work on purpose, and a card that climbed back into a queue demanding
 * attention would be arguing with a decision they already made. And the fact is orthogonal to the turn
 * lifecycle, an agent that has since been messaged and is running again can equally have had its earlier
 * land discarded, and both things are true of it at once.
 *
 * The COMMITTED half counts as present, which is why the ordinary flow never sees this line: reviewing an
 * agent's work and committing it is the happy path, and a card that announced "removed from your workspace"
 * the moment the user committed would be crying wolf on the one outcome the whole review exists to produce.
 *
 * Undefined for every agent with nothing missing, which is nearly all of them, the daemon only sends a
 * reading when there is something to say (AgentSummarySchema.landedPresence). */
export const landedAway = (agent: {
    readonly landedPresence?: { readonly landed: number; readonly present: number };
}): { text: string; hint: string } | undefined => {
    const presence = agent.landedPresence;
    if (presence === undefined) {
        return undefined;
    }
    /* THE HINT IS A CLAUSE, NOT A PARAGRAPH, it is read as the tail of `text` on the same line, so it carries
     * exactly the one fact "removed" does not: the branch still has it. It used to be a 20-word reassurance
     * ("Nothing is lost, this agent's branch still holds all of it, and \"Land again\" puts back what is
     * missing.") stacked under a button, which is two lines of prose spent on a card that gets a glance: half
     * of it narrated the button sitting directly above it, and "nothing is lost" announced a loss before
     * denying it. The recovery is the button's own word, `again`, and needs no sentence of its own. */
    // The whole of it, which is the common shape: one discard of one agent's work, and no arithmetic to read.
    if (presence.present === 0) {
        return { text: `Removed from your workspace`, hint: `still on its branch` };
    }
    // A PART of it, a discarded selection, or a few rows reverted by hand. The fraction rather than the
    // remainder ("3 files gone") because what the user is deciding is whether enough survived to leave it be,
    // and that reads off "9 of 12" without them having to do the subtraction. Its hint names the OTHER half for
    // the same reason: the fraction already says what is here, so the clause is only useful about what is not.
    return { text: `${presence.present} of ${presence.landed} files still in your workspace`, hint: `the rest is on its branch` };
};

/* ONE BIT, "this session isn't done with your tree yet", for surfaces that name an agent while showing its
 * OUTPUT rather than the agent itself (the Changes panel's From legend). Those chips spend their glyph on
 * identity, so the full status vocabulary above cannot ride them; and most of it would say nothing there
 * anyway, because every chip in such a legend is by definition a session that already landed something, the
 * resting state drawn four times.
 *
 * It is `laneOf` narrowed to a boolean and NOT a status list of its own, which is the whole point: the file
 * count on a chip is a total for a finished session and an instalment for every other kind, and "finished" has
 * to mean on this panel exactly what it means on the board. A second definition here is what put an amber dot
 * on a chip whose card sat in the board's Finished lane.
 *
 * A dot, not the status icon, and NOT the running spinner: this is a filter control, and a rotating glyph per
 * chip would make the legend the busiest thing on a panel whose subject is the file list below it. Both lanes
 * are STATIC for the same reason one step further: the active mark used to pulse so it could be told apart by
 * behaviour from the eight identity hues a chip's tint is drawn from, but there is one of these per chip, so a
 * review carrying work from four sessions blinked four times a second for as long as they ran. The halo does
 * the telling-apart instead, an identity tint is a flat dot, this one is a dot with a ring around it, and it
 * costs no motion at all.
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
        ? { dot: `bg-link ring-2 ring-link/30`, label: activeLabel(agent) }
        : // Named by the same reason the board's chip wears. The fallback covers a bare `awaiting`, a turn
          // parked with no flag yet raised, which has nothing more specific to say than that it stopped.
          { dot: `bg-primary-500`, label: attentionReason(agent) ?? `Waiting on you` };
};

// "Working" would be wrong for the two active cards that are not: one parked on a watch has finished its turn
// and is waiting for the world, and one stranded on a spent allowance is waiting for a clock. Both are in this
// lane because nothing is owed by the user (laneOf says why), and neither is doing anything, so the label says
// which kind of unfinished it is rather than claiming work that is not happening.
const activeLabel = (agent: AgentStanding): string => {
    if (limitClosed(agent)) {
        return `Waiting on the allowance`;
    }
    return watching(agent) && !turnInFlight(agent) ? `Waiting on a condition` : `Still working`;
};

// The card's drill-in affordance label (desktop), the verb that names what the review detail opens onto, so
// the button reads as a destination rather than a generic "open". A DRAFT has no worktree/diff yet, so it has
// no review detail (returns undefined): its click only focuses the docked chat. Everything registered has a
// destination; the label leads with why-you'd-go, pending approval/question first, then a land conflict or
// error, then a diff to look over, falling back to a plain "Review" for a running agent with nothing yet.
export const reviewAction = (agent: AgentStanding & { readonly branch?: string; readonly diff?: { files: number } }): string | undefined => {
    if (unregistered(agent.status) || agent.branch === undefined) {
        return undefined;
    }
    const flagged = ATTENTION_ACTIONS.find(([flag]) => agent.attention[flag]);
    if (flagged !== undefined) {
        return flagged[1];
    }
    /* NAMES THE REPORT, not the fix, because on a conflicted card the fix is now a button of its own, sitting
     * one line above this link (AgentCard). While this link WAS the only conflict affordance on the board it
     * read "Resolve conflict", which was the closest a navigation could get to the verb the user wanted; two
     * controls a few pixels apart both promising to resolve the conflict, only one of which does anything to
     * it, is worse than either alone. So the action keeps the verb and the link says what it opens: the report
     *, which paths refused, why, and whose move each one is. */
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `See what blocked it`;
    }
    /* A SPENT ALLOWANCE IS NOT AN ERROR TO VIEW, and "View error" was the promise that made the old card worse
     * than useless: it points at a transcript whose last line is a provider saying no, over a condition with
     * nothing to diagnose and nothing in the report the card is not already saying better. The destination is
     * the conversation, so the label names that; the thing a person actually DOES here is the card's own press.
     * Read before the `error` branch below, which it would otherwise fall into. */
    if (limited(agent)) {
        return `Open chat`;
    }
    return ENDING_ACTIONS[agent.status] ?? (agent.diff !== undefined && agent.diff.files > 0 ? `Review changes` : `Review`);
};

/* The cards PARKED ON THE USER, in the order the verb should lead with, which is the same order attentionReason
 * ranks the same flags in and for the same reasons: money outranks a generic question, because the agent is
 * held on a priced run only a click can release; a setup ranks with it, because it leads into a flow rather
 * than a one-press approval.
 *
 * A list rather than five branches so the ORDER is a value you can read, and so a condition arriving above them
 * (see `limited`) does not have to be threaded past five near-identical ifs to get there. */
const ATTENTION_ACTIONS: readonly (readonly [flag: keyof AgentAttention, verb: string])[] = [
    [`plan`, `Review plan`],
    [`question`, `Answer`],
    [`permission`, `Approve`],
    // The verb carries the money: this click spends, unlike Approve one line up.
    [`service`, `Approve spend`],
    // The verb carries the work: this click leads into a setup flow, not a one-press approval.
    [`capability`, `Set up`],
];

/* The endings whose destination is named by the ENDING rather than by what is in the diff, tabled for the same
 * reason ENDING_REASONS above is: they were a run of one-line branches that a new condition had to be threaded
 * through, which is when a chain wants to be a lookup. Anything not here falls to the diff reading below. */
const ENDING_ACTIONS: Partial<Record<AgentStatus | ClientAgentStatus, string>> = {
    error: `View error`,
    // The destination is the transcript, where the cut-off tool call is the last thing in it, that IS the
    // report for this state, so the label names the place rather than promising a fix the board cannot do.
    // One label for both endings: whether the daemon died or the user pressed Stop, the question the card is
    // answering is the same one, how far did it get?
    interrupted: `See where it stopped`,
    stopped: `See where it stopped`,
    // Ready names both halves of what its destination offers: the review panel is where the held work is read
    // AND where "Land now" sits. The card's own primary button lands without the trip (AgentCard).
    ready: `Review & land`,
};

/* Does a clean turn's work land into the workspace by itself, for THIS agent? The one place the two-level
 * setting is folded into an answer, so every surface that states or flips the posture (the review panel's hold
 * toggle, the landed notice's offer) agrees on what it currently is: the agent's own override when it has one,
 * else the sandbox-wide setting, else the schema default (off). Takes the pieces rather than reaching for the
 * stores, this module is a leaf (see the header). */
export const effectiveAutoLand = (agent: { readonly autoLand?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.autoLand ?? sandboxDefault ?? false;

/* Does a turn the MODEL PROVIDER killed come back by itself, for THIS conversation? Same two-level fold as
 * effectiveAutoLand above and here for the same reason: the offer in the chat, the row in the session menu and
 * the notice's opt-out all state the posture, and three surfaces disagreeing about it is how a user ends up
 * pressing a button that says the opposite of what it does.
 *
 * The one thing worth saying twice: the agent's override wins, and the sandbox setting is only the answer for
 * a conversation that never expressed one. That asymmetry IS the feature, a press inside one chat speaks for
 * that chat, and Sandbox ▸ Agent speaks for everything else. */
export const effectiveOutageResume = (agent: { readonly resumeAfterOutage?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.resumeAfterOutage ?? sandboxDefault ?? false;

/* Does the turn a SPENT ALLOWANCE refused go again by itself when the window reopens, for THIS conversation?
 * The third fold of the same two-level shape, and here for the reason the other two are: the card's offer, the
 * card's readout and the daemon's own pass all state this posture, and three surfaces disagreeing about it is
 * how somebody ends up pressing a button that says the opposite of what it does. */
export const effectiveLimitResume = (agent: { readonly resumeAfterLimit?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.resumeAfterLimit ?? sandboxDefault ?? false;

// The sources an agent can be OPENED BY, when it wasn't opened by the user: the label and glyph the card's
// provenance line wears. Keyed by AgentOrigin.provider, which is an open string (listener sources are
// extension-declared), so an unknown one degrades to its own name rather than disappearing.
const ORIGIN_SOURCES: Record<string, { icon: IconName; label: string }> = {
    discord: { icon: `comments`, label: `Discord` },
    slack: { icon: `comments`, label: `Slack` },
    imap: { icon: `envelope`, label: `Email` },
    webchat: { icon: `globe`, label: `Front Desk` },
    webhook: { icon: `bolt`, label: `Webhook` },
};

// The card's "this conversation came in from outside" line: what opened it, who sent it, and, in the tooltip
//, which automation was configured to answer. The user never typed this agent's first message, and a card
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
        hint: `Opened by the "${origin.automationId}" automation${where}, its first prompt is not yours`,
    };
};

/* THE UNREAD BADGE, in the two flavours worth telling apart: an agent nobody has opened yet is "New"; one you
 * HAVE opened that has worked since is "Updated", with "New" on both, every returning agent reads as a
 * stranger. The marker behind it lives on the daemon entry, so opening it anywhere clears it everywhere.
 * `seenAt` rides out for the hover the "Updated" flavour earns (WHEN you last looked is the fact the one word
 * hides); the caller formats it, because this module owns no clock and no time words. */
export const unreadBadge = (agent: { unread: boolean; seenAt?: number }): { label: "New" | "Updated"; seenAt?: number } | undefined =>
    !agent.unread ? undefined : agent.seenAt === undefined ? { label: `New` } : { label: `Updated`, seenAt: agent.seenAt };

/* WHAT THE LIVE LINE SAYS. Normally the agent's own last tool (or the todo it is on), but a parent whose
 * children are working is not itself the interesting fact, and its own tool line goes quiet for exactly as long
 * as it waits on them. So the children lead, and what the parent was doing trails.
 *
 * THE TOOL'S TARGET IS NOT ON THIS LINE, and leaving it off is the point rather than an omission. It used to
 * be — `Bash · pnpm --filter @intentic/ui test -- --run src/lib` — and that is a line of shell, on a card in a
 * column of cards, changing every second or two. A board is scanned; the question it answers is "is this one
 * moving, and roughly at what", and the tool NAME answers that completely. The target answers "which file, on
 * which flag", which is a question you ask with the transcript open, where the full call is printed in full
 * and stays put long enough to read. In the lane it was a truncated fragment of a command — never enough of
 * one to act on, always enough to pull the eye off whatever the reader came to the board for.
 *
 * A TODO STILL WINS OVER THE TOOL, unchanged: "Wire the retry path" is what the agent is doing it TOWARDS, and
 * that is worth a card's line in a way that "which of ten files it is reading right now" is not. */
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

// The activity line's icon by tool family, a glanceable "what is it doing" glyph, mock-style.
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

/* HOW A LOOP READS ON A CARD, one line, and the one line has to answer "how far along" and "towards what".
 *
 * A looping agent is otherwise indistinguishable from any other running one: same spinner, same activity line,
 * same growing cost, for forty minutes. What separates them is that a loop has a DESTINATION and a POSITION, so
 * those are what the line carries, and the goal is the half that is worth the horizontal space, "iteration
 * 3/12" without it is a progress bar for an unnamed job.
 *
 * The ENDED states are not folded into one "finished". `done` and `stalled` are opposite outcomes that a status
 * dot alone would render identically, and `stalled` is the one that needs a person: it means the agent stopped
 * changing anything while still reporting work to do, which is a prompt problem and not a capacity problem.
 * Colour follows that reading, link while it runs, success for the only success, warning for the three ways it
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
        stalled: { text: `Stalled after ${loop.iteration}, nothing changed`, class: `text-warning` },
        overspent: { text: `Hit the spend ceiling after ${loop.iteration}`, class: `text-warning` },
        stopped: { text: `Loop stopped after ${loop.iteration}`, class: `text-muted` },
        error: { text: `Loop failed after ${loop.iteration}`, class: `text-danger` },
    };
    return { ...ended[loop.state], spin: false };
};

/* Past this far out a wall-clock time reads better than a countdown: a weekly allowance comes back on Tuesday,
 * and "72h 14m" is a number nobody can act on. Under it the countdown wins, because "in 6m" is read at a glance
 * where a clock time makes the reader do arithmetic. The same threshold and the same reasoning as the chat
 * strip's (chat/pickUp.ts CLOCK_FROM_MS): one product, one rule about when a wait becomes an appointment. */
const CLOCK_FROM_MS = 90 * 60 * 1_000;

/* HOW A SPENT ALLOWANCE READS ON A CARD: the state, the hour, and the whole of it behind them.
 *
 * THE SHAPE IS watchLine's, deliberately and to the field. Both are "this conversation is waiting on something
 * outside it, and here is when it stops waiting", the card already draws that shape, and the board is scanned:
 * one grammar for a wait is what makes a column of them readable. What differs is only that this wait has an
 * appointment rather than a deadline.
 *
 * THE TEXT SAYS WHOSE ALLOWANCE AND WHOSE MOVE, in that order, because on a mixed board the vendor is what
 * tells four stranded cards apart from four others, and the move is what the reader is deciding. Armed, there
 * is no move to state: the sentence says the card is coming back on its own, which is the whole point of having
 * armed it. The provider's own sentence is NOT here, it is the hint, since "Claude usage limit reached. Send
 * again once it resets." is a paragraph restating what the chip, the line and the countdown already say.
 *
 * THE COUNTDOWN IS ONLY EVER TO A SHUT WINDOW. Once it opens there is nothing to count to and the readout would
 * be counting up from an instant that no longer matters, so it goes, and the line changes to say the press is
 * live. A limit that published no instant has no countdown at any point, and says so by omission rather than by
 * guessing: `undefined` here is the card quietly not making a promise.
 *
 * Undefined for every card that is not stranded on an allowance, which is nearly all of them. */
export const limitLine = (
    agent: AgentStanding,
    options: { readonly now: number; readonly vendor: string; readonly armed: boolean },
): { readonly text: string; readonly countdown: string | undefined; readonly hint: string } | undefined => {
    if (!limited(agent)) {
        return undefined;
    }
    const { now, vendor, armed } = options;
    const reopensAt = agent.limitResetsAt;
    const closed = limitClosed(agent, now);
    // Defined whenever the window is shut (limitClosed requires an instant), and the fallback is what the
    // sentences read when it is not: the honest non-answer, never a guessed hour.
    const when = reopensAt === undefined ? `when the provider reopens it` : limitWhen(reopensAt * 1_000, now);
    /* THE TIME IS SAID ONCE, in the countdown slot, and the text carries only the STATE. Both said it at first,
     * "back at Thu 00:12" in the sentence and "4h 11m" beside it, which is the same fact twice at the width
     * where the card can least afford it: on a 280px lane that redundancy is what pushed the title down to two
     * characters. The slot is the right home for it because it is the slot every other card on this board keeps
     * its clock in (a running turn's elapsed, a watch's countdown), and because it is where the eye already
     * goes for "when". */
    return {
        text: closed ? (armed ? `${vendor} allowance spent · goes again` : `${vendor} allowance spent`) : `${vendor} allowance is back`,
        countdown: closed && reopensAt !== undefined ? limitClock(reopensAt * 1_000, now) : undefined,
        hint: limitHint(agent, { closed, armed, when }),
    };
};

/* An instant as the READOUT says it, four or five characters in the card's clock slot: how long is left while
 * that is a number a person can hold ("4h 11m"), and the weekday and hour once it isn't ("Thu 00:12"), because
 * a weekly allowance measured in hours is arithmetic rather than information. Same threshold, and the same
 * reasoning, as the chat strip's own switch (chat/pickUp.ts). */
const limitClock = (at: number, now: number): string => (at - now >= CLOCK_FROM_MS ? formatWeekdayTime(at) : formatElapsed(now, at));

/* And the same instant as a SENTENCE says it, for the hint, where it is read as prose and needs its
 * preposition ("due back at Tue 14:40", "due back in 45m"). */
const limitWhen = (at: number, now: number): string =>
    at - now >= CLOCK_FROM_MS ? `at ${formatWeekdayTime(at)}` : `in ${formatElapsed(now, at)}`;

/* The three things the line could not carry: that the turn is HELD (so sending again is the same request rather
 * than a new one), what the provider actually said, and, for a card nobody armed, that arming it is an option.
 * One flowing line rather than a list, for tooltip.css's reason: the box renders with `textContent` into a
 * clamped strip, so a newline is a space and a fourth sentence falls off the bottom. */
const limitHint = (agent: AgentStanding, state: { closed: boolean; armed: boolean; when: string }): string => {
    const held = agent.limitHeld === true ? `The refused turn is held whole, so sending again re-runs it rather than adding a message after it. ` : ``;
    if (!state.closed) {
        return `${held}The allowance is back: this turn is waiting for you to send it.`;
    }
    return state.armed
        ? `${held}This conversation sends itself again once the allowance comes back ${state.when}. Nothing else is owed.`
        : // Names the control rather than the wish: the card's menu is where this card's posture lives (the
          // press beside this line spends now, and a second one arming a later spend would be two decisions in
          // one row), and a hint promising an affordance the reader cannot find is worse than one that stops
          // at the fact.
          `${held}Nothing sends it for you. The allowance is due back ${state.when}; this card's menu can send it for you next time.`;
};

// A watch's pacing, in the fewest characters that stay true: seconds up to two minutes, whole minutes above.
// Only ever read inside the watch hint, which is why it is not exported beside the time words above.
const everyOf = (seconds: number): string => (seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`);

/* HOW AN ARMED WATCH READS ON A CARD: three short parts, and the whole story kept behind them.
 *
 * The card gets a GLYPH, a phrase and a clock, which is the shape its live readout already uses for a running
 * turn (`Bash · 1m 12s`) and the shape the rail repeats. That is deliberate: a board is scanned, and one
 * grammar for "what is this card doing, and for how long" is what makes it scannable. The parts stay separate
 * rather than pre-joined into a sentence so the phrase can truncate under a narrow lane while the clock, which
 * is four characters and the more perishable fact, never does.
 *
 * THE NOTE IS THE PHRASE, not the word "Watching". The agent wrote one line about what it is waiting for
 * precisely so somebody could read it here, and "Watching" alone tells a user nothing they could act on: it is
 * the glyph's job, and the glyph is already saying it. Several watches collapse to a count instead, because
 * three truncated notes in a 280px column are three things nobody reads.
 *
 * That is the OPPOSITE of what `activityLine` does one screen up, where the tool's target is deliberately
 * dropped and only `Bash` survives, and the difference between the two cases is churn rather than length. A
 * running turn's target is a fragment of shell that changes every second or two: never enough to act on,
 * always enough to pull the eye off whatever the reader came to the board for. A watch note is written once
 * and stands for hours, so it costs the scan nothing and is the only thing on the card that distinguishes
 * this wait from any other.
 *
 * THE CLOCK COUNTS DOWN TO THE DEADLINE, which is the fact a person actually needs: every watch has one, and
 * reaching it wakes the conversation anyway, so this is not "how long until it maybe does something" but "how
 * long until this card moves, at the latest". The soonest deadline leads when there are several, for the same
 * reason: it is the next time this conversation comes back to life.
 *
 * THE HINT IS ONE FLOWING LINE, not a list, and that is a fact about the box rather than a preference: the
 * tooltip is written with `textContent` into a 17rem strip clamped at five lines (ui/styles/tooltip.css), so a
 * newline renders as a space and a fourth watch would push the sentence that matters off the bottom. It
 * carries the three things the readout could not: every note in full, the pacing, and what reaching the end of
 * the wait actually DOES, which is the half nobody can guess. The point of a watch is not that something is
 * being polled; it is that this agent starts working again by itself.
 *
 * AND THEN THE WAY OUT, last, which is the one placement worth defending. A tooltip that explains a mechanism
 * and names no exit is what taught users this arrangement could not be ended: the box says the conversation
 * will restart itself and stops there. So the sentence is here: not to be FOUND (the card's own press does
 * that, and it is revealed by the very hover that raises this box), but to say what pressing it costs, which
 * is nothing but the wait. It goes last for the same reason it is short: the clamp eats the tail, and of the
 * four facts here this is the only one the reader can also get by looking half an inch to the right. */
export const watchLine = (
    agent: AgentStanding,
    now: number,
): { readonly text: string; readonly countdown: string; readonly hint: string } | undefined => {
    const watches = agent.watches;
    if (watches === undefined || watches.length === 0) {
        return undefined;
    }
    const soonest = watches.reduce((first, next) => (next.deadlineAt < first.deadlineAt ? next : first));
    // formatElapsed measures the second argument FROM the first, so now→deadline is the time left. One time
    // vocabulary on this card: the same words its running turn's elapsed is printed in, in the same corner.
    const countdown = formatElapsed(now, soonest.deadlineAt);
    const detail = watches
        .map((watch) => `${watch.note} (checked every ${everyOf(watch.intervalSeconds)}, gives up in ${formatElapsed(now, watch.deadlineAt)})`)
        .join(`; `);
    return {
        text: watches.length === 1 ? soonest.note : `Watching ${watches.length} conditions`,
        countdown,
        hint: `Watching for ${detail}. The first of those to happen wakes this conversation, and it carries on by itself. Stop watching and it stays put.`,
    };
};
