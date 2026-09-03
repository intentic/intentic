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
    /* WHICH KIND OF FAILURE ENDED THE LAST TURN, and what the wait behind it looks like: the FOURTH half of the
     * state, and the one that was missing for longest.
     *
     * `status: "error"` is a single word doing the work of two very different situations. A harness that died
     * mid-run is BROKEN: somebody has to go and find out why. An allowance that ran out is not broken at all,
     * it is early, and it says when it stops being early. Both reached every surface as the same grey "error",
     * so the second was drawn in the full vocabulary of the first — a red sentence, an "Error" chip and a "View
     * error" link into a transcript whose last line is a provider politely saying no.
     *
     * BOTH STILL NEED THE USER, which is what the classification is NOT for: a stranded turn goes nowhere until
     * a person sends it again, so both belong in Attention. What this buys is the card being able to say WHICH,
     * so a reader can tell the four cards they have to investigate from the one they just have to come back to.
     *
     * `laneOf` reads it, which is why it belongs here rather than on the card: the lane, the badge and the chip
     * have to agree, and the only way they ever do in this file is by reading the same standing. */
    readonly failureCode?: string;
    /** When the spent allowance reopens, in epoch SECONDS (the wire's unit). Absent when nobody published one. */
    readonly limitResetsAt?: number;
    /** Whether the refused turn is held whole, so a press RE-RUNS it rather than sending a message after it. */
    readonly limitHeld?: boolean;
    /** Whether a fire is already booked for it at the reset, so this card needs nobody. The one lane input. */
    readonly limitScheduled?: boolean;
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

/* …and whether the window it named is still SHUT, which is what the card's clock counts down to and NOTHING
 * else. It is deliberately not a lane input, and the version of this file that made it one had the product
 * backwards: it read "the window is shut, so nothing is owed yet" and filed the card under Active.
 *
 * A REOPENING WINDOW SENDS NOTHING. That is the whole correction. A watched agent's condition firing starts a
 * turn by itself, which is why a watch belongs in Active; an allowance coming back starts nothing at all — it
 * only makes a press possible, and the press is the user's. So a stranded card is waiting on a PERSON for the
 * whole of the wait, shut window or open, and the lane that says so is Attention (see laneOf).
 *
 * A limit with no published instant is never "closed": there is no instant to count to, so the card shows no
 * clock rather than a guessed one. */
export const limitClosed = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limited(agent) && agent.limitResetsAt !== undefined && agent.limitResetsAt * 1_000 > now;

/* THE ONE STRANDED CARD THAT DOES NOT NEED A PERSON: a fire is already booked for it (AgentSummary's
 * `limitScheduled`), so the held turn goes again at the reset whether or not anybody looks at the board.
 *
 * This is the exception the rule above generates rather than one bolted onto it. "Does this session progress
 * without me?" is the question the lanes answer, and for an armed conversation the answer is yes — the same
 * answer `resuming` gives, and it earns the same treatment. Arming it is exactly how a user says "stop asking
 * me about this one", so a board that went on asking would be ignoring the instruction it was given.
 *
 * OFF unless somebody asked for it (`resumeAfterLimit` defaults to off), so on an ordinary board this is false
 * for every card and every spent allowance lands in Attention. */
export const limitScheduled = (agent: AgentStanding): boolean => limited(agent) && agent.limitScheduled === true;

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
// A SPENT ALLOWANCE IS BLOCKED ON THE USER like every other `error`, and an earlier version of this file that
// excepted it while its window was shut was wrong about the product rather than about the wording. That
// reasoning ran "the window has not reopened, so a press buys nothing yet", which is true and beside the point:
// a reopening window SENDS NOTHING. It only makes a press possible, and the press is a person's. So from the
// moment the turn is refused to the moment somebody acts, this session does not progress — which is the exact
// question this predicate exists to answer.
//
// THE ONE EXCEPTION IS A CARD A MACHINE HAS TAKEN OVER (limitScheduled): armed, the held turn goes again at the
// reset with nobody watching, so nothing is owed. Arming it is how a user says "stop asking me about this one",
// and a board that kept asking would be overriding the instruction it was given.
//
// The five ENDINGS that block, as a set rather than a chain of comparisons: each has its paragraph above, and
// listing them once here is what keeps this predicate readable now that it has an exception to state first.
const BLOCKING_ENDINGS: ReadonlySet<AgentStatus | ClientAgentStatus> = new Set([`error`, `interrupted`, `stopping`, `stopped`, `failed`]);

export const blocked = (agent: AgentStanding): boolean =>
    limitScheduled(agent)
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

/* WHY THIS CARD IS PARKED ON A PERSON, and what to do about it: one entry per attention flag, in the order the
 * card should lead with, carrying BOTH words the surfaces need — the noun the chip wears and the verb its
 * drill-in press names.
 *
 * ONE TABLE BECAUSE TWO LISTS DRIFTED, and the drift is what this file is being edited for. The chip words were
 * an if-chain here and the verbs a list below (ATTENTION_ACTIONS), the two had to rank the same flags the same
 * way, and nothing made them: `permission` was in the verb list and MISSING from the chain, so an agent parked
 * on a tool permission — the commonest park there is — got no chip at all and the card fell through to the raw
 * status glyph: a bare `(!)` in the corner, with no word beside it and none on its hover, on the one card whose
 * whole purpose is to say what it wants. The orders had drifted too, the chain ranked money above a question
 * and the verb list ranked it below, under a comment on the verb list claiming the two agreed.
 *
 * So the rank is one value you can read, the two words sit on the same line where a mismatch is visible, and
 * `satisfies Record<keyof AgentAttention, …>` makes a flag added to the wire schema a BUILD error until both of
 * its words exist. That is the actual repair: the hole is filled below, and this is what stops the next one.
 *
 * SHORT, all of them, because the chip is `shrink-0` beside a title that is not: every character it grows is
 * taken off the agent's own name at lane width (see the length test, and `Usage limit`'s note on it). */
const ATTENTION_WORDS = {
    plan: { chip: `Approval needed`, verb: `Review plan` },
    // Money outranks a generic question: the agent is parked on a priced run only your click can release, and
    // the verb carries the spend, unlike the plain approval above it.
    service: { chip: `Spend approval`, verb: `Approve spend` },
    // Same rank as spend, same reason: the agent is parked on a setup only you can do. The verb carries the
    // work, because this click leads into a flow rather than settling a one-press approval.
    capability: { chip: `Setup needed`, verb: `Set up` },
    question: { chip: `Question for you`, verb: `Answer` },
    /* A TOOL WAITING FOR A YES, and the entry whose absence was the whole bug. It ranks LAST of the parks
     * because it is the most routine of them and the cheapest to clear: a plan, a spend and a setup each want
     * reading before you answer, and a question is a person's, while this is one press over one command.
     * Ranking it last is also what makes a card carrying two parks lead with the one worth the trip.
     *
     * NOT "Approval needed", the word a plan already wears: the two are different asks, and two chips reading
     * alike would be this table's own failure one lane deeper — a chip that does not repay a glance teaches
     * the reader to stop spending one.
     *
     * AND NOT "Permission needed" either, which is the phrasing that reads best in isolation and would have
     * been the longest label on the board at 17 characters. Measured on this card at the 280px lane width,
     * against a 29-character title: this label leaves 19 characters of the agent's NAME on screen ("Fix the
     * flaky sign…"), "Approval needed" leaves 14, and "Permission needed" leaves 12 ("Fix the fla…"). So the
     * long form buys the word by spending the name, and a lane of cards that cannot say which agent they are
     * is this same complaint — a card you cannot read at a glance — arrived at from the other side.
     *
     * The noun alone carries it, in the form "Usage limit" already uses. It has to: the drill-in verb beside
     * it ("Approve", from this same line) is DESKTOP ONLY — on a phone the detail is the chat, so `review` is
     * undefined and this chip is the only thing on the card naming the state. Which is the argument for
     * short and self-contained rather than for short alone. */
    permission: { chip: `Permission`, verb: `Approve` },
    /* Its chip is here and its verb NAMES THE REPORT rather than the fix, because on a conflicted card the fix
     * is a button of its own sitting one line above the drill-in (AgentCard). While this link WAS the only
     * conflict affordance on the board it read "Resolve conflict", which was the closest a navigation could get
     * to the verb the user wanted; two controls a few pixels apart both promising to resolve the conflict, only
     * one of which does anything to it, is worse than either alone. So the action keeps the verb and the link
     * says what it opens: the report — which paths refused, why, and whose move each one is. */
    conflict: { chip: `Land conflict`, verb: `See what blocked it` },
} as const satisfies Record<keyof AgentAttention, { chip: string; verb: string }>;

// The rank, once, for both readings. `Object.keys` over a literal-typed object rather than a hand-kept second
// list of the same names: the table above IS the order, and a list repeating it is a list that can disagree.
const ATTENTION_RANK = Object.keys(ATTENTION_WORDS) as readonly (keyof AgentAttention)[];

/* THE FLAG THIS CARD LEADS WITH, or nothing when it is parked on none: read once, so the chip and the verb can
 * never be about two different parks.
 *
 * The raised FLAGS are asked first and the `conflict` status only after them, which keeps the rank the chain
 * this replaced had. It costs nothing today — the daemon files any unanswered card as `awaiting`, and the
 * landing standings that produce `conflict` are only read once nothing is running (agents-registry's statusOf),
 * so the two cannot both be true — and it is the honest order regardless: a raised flag is a live park with
 * somebody waiting on the other end, and a conflict status is a fact about where the work came to rest. */
const leadingPark = (agent: AgentStanding): keyof AgentAttention | undefined =>
    ATTENTION_RANK.find((flag) => agent.attention[flag]) ?? (agent.status === `conflict` ? `conflict` : undefined);

// The one-line "why this card is in the Attention lane" label, shared by the card chip, the Changes legend's
// hover card, and any future toast.
export const attentionReason = (agent: AgentStanding): string | undefined => {
    /* THE CHIP IS THE WHOLE OF THE FIX, and everything the card used to add underneath it was the price of not
     * having said this here. "Error" over a spent allowance is what sent a predictable, self-dating wait out
     * dressed as a broken workspace; naming the condition in the corner every reader's eye already goes to is
     * enough on its own, and it leaves the card's body to say what the card IS rather than what happened to it.
     *
     * "USAGE LIMIT" IS THE VENDOR'S OWN PHRASE, which is the point: it is what the provider's message says and
     * what their dashboard calls it, in two plain words rather than "allowance" — a word that reads as jargon
     * to anyone who did not grow up with the language. The vendor is not named here because the card already
     * names it a line below, on the model.
     *
     * SHORT, because this chip is `shrink-0` beside a title that is not, so every character it grows is taken
     * off the agent's own name at lane width: an earlier "Waiting on limit" drew two cards as "In…" and "C…". */
    if (limited(agent)) {
        return `Usage limit`;
    }
    const park = leadingPark(agent);
    if (park !== undefined) {
        return ATTENTION_WORDS[park].chip;
    }
    /* A PARK THE ATTENTION BLOCK CANNOT NAME, said in the plainest words there are rather than not said at all.
     * `awaiting` means the daemon is holding an unanswered card (agents-registry's `pauses`), and two of the
     * kinds it holds — a browser hand-off and a terminal one — raise no flag in the wire schema, so they arrive
     * here as a status and nothing else. They were the other half of the bare `(!)`: in the Attention lane,
     * counted in its badge, with no word anywhere on the card saying which of them it was.
     *
     * Under the endings on purpose. Every word above this one is more specific than "waiting", and this is the
     * floor: reached only once nothing better can be said, and it is still infinitely better than a glyph. */
    return ENDING_REASONS[agent.status] ?? (agent.status === `awaiting` ? `Waiting on you` : undefined);
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
export const laneOf = (agent: AgentStanding): FleetLane => {
    /* A SPENT ALLOWANCE IS ATTENTION, through `blocked` and with no branch of its own, and the branch that used
     * to be here is worth naming because it was wrong in an instructive way.
     *
     * It filed a card under Active for as long as its window stayed shut, reasoning that nothing was owed until
     * the reset. The reset owes nothing either: it opens a window and SENDS NOTHING THROUGH IT. So the card sat
     * for hours in the lane that means "this is moving", among agents that were, when the truth was that this
     * work had stopped and only a person could restart it. That is precisely what Attention is for, and dressing
     * the card better (see attentionReason) is the answer to a lane full of them, not moving them out of it.
     *
     * The `watching` branch further down is NOT the same case, which is where the mistake came from: a watch
     * fires and starts a turn by itself, so nothing is owed for the whole of that wait. An allowance does not. */
    if (blocked(agent) || agent.status === `awaiting` || agent.status === `conflict`) {
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
    /* AND SO IS A STRANDED TURN SOMETHING IS ALREADY BOOKED TO SEND, for the same reason and by the same test:
     * this conversation starts working again on its own, at an instant that is already fixed. It reaches here
     * at all only because `blocked` let it past (limitScheduled is that predicate's one exception), so a card
     * nobody armed never sees this line and lands in Attention above.
     *
     * It has to be SAID, though, rather than left to fall through: without it an armed card lands in Finished,
     * which would announce as over a conversation that is going to run again tonight. */
    if (limitScheduled(agent)) {
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
}): { text: string; hint?: string; title: string; icon: IconName } | undefined => {
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
        return {
            text: `Removed`,
            hint: `on branch`,
            title: `Removed from your workspace (still on its branch)`,
            icon: `link-broken`,
        };
    }
    // A PART of it: a present/landed fraction and a split glyph. What the user is deciding is whether enough
    // survived to leave it be, and "9/12" answers that at a glance; the full sentence lives in `title` for hover.
    return {
        text: `${presence.present}/${presence.landed}`,
        title: `${presence.present} of ${presence.landed} files still in your workspace (the rest is on its branch)`,
        icon: `arrows-h`,
    };
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
        : /* Named by the same reason the board's chip wears — including the bare `awaiting` this used to name
           * for itself. That fallback was the only place in the app that said something for a turn parked with
           * no flag raised, which is why it read as this mark's own quirk rather than as the hole it was; it
           * belongs to `attentionReason`, where every surface gets it. Kept here as a runtime floor for the
           * same reason STATUS_META keeps its `??`: a lane is decided by a status off an untyped wire, so a
           * build one version behind can be handed a standing it has no word for, and a chip reading
           * `undefined` in a legend is worse than one reading the plainest true thing. */
          { dot: `bg-primary-500`, label: attentionReason(agent) ?? `Waiting on you` };
};

// "Working" would be wrong for the two active cards that are not: one parked on a watch is waiting for the
// world, and one whose spent turn is booked to go again is waiting for a clock. Both are in this lane because
// each starts working again on its own (laneOf says why), and neither is doing anything right now, so the label
// says which kind of unfinished it is rather than claiming work that is not happening.
const activeLabel = (agent: AgentStanding): string => {
    if (limitScheduled(agent)) {
        return `Sends itself again`;
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
    /* THE SAME FLAG THE CHIP LED WITH, so the noun in the corner and the verb at the foot of the card are
     * always about one park. They were two ranked lists (see ATTENTION_WORDS) and could disagree: a card
     * carrying both a question and a spend offer wore "Spend approval" over a press reading "Answer". */
    const park = leadingPark(agent);
    if (park !== undefined) {
        return ATTENTION_WORDS[park].verb;
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

/* WHEN A STRANDED TURN CAN GO AGAIN, four or five characters for the card's clock corner: the slot a running
 * card puts its elapsed in and a watching one its countdown, answering the same question in the same place.
 *
 * THIS IS ALL THAT IS LEFT OF A WHOLE LINE OF PROSE, and the deletion is the point. The card used to carry a
 * sentence of its own — "Claude allowance spent · back at Thu 00:12" — under a chip that said "Waiting", which
 * is the vendor named twice (the model line already says it), the state said twice, and a whole row of card
 * height spent on it. The chip names the condition; this names the hour; nothing else was carrying meaning.
 *
 * HOW LONG while that is a number a person can hold, the DAY AND HOUR once it is not: "4h 11m" is read at a
 * glance, "74h 12m" is arithmetic, and a weekly pool routinely comes back on Thursday. Same threshold and same
 * reasoning as the chat strip's own switch (chat/pickUp.ts).
 *
 * Undefined for a card with no published instant, which is Grok and Cursor and anything whose vendor names no
 * reset: the corner keeps its ordinary date rather than showing a time nobody promised. */
const CLOCK_FROM_MS = 90 * 60 * 1_000;

export const limitCountdown = (agent: AgentStanding, now: number): string | undefined => {
    const reopensAt = agent.limitResetsAt;
    if (!limitClosed(agent, now) || reopensAt === undefined) {
        return undefined;
    }
    const at = reopensAt * 1_000;
    return at - now >= CLOCK_FROM_MS ? formatWeekdayTime(at) : formatElapsed(now, at);
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
