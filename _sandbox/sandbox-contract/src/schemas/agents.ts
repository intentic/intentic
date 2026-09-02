// agents: the conversation fleet
import { z } from "zod";
import { AgentHarnessSchema, AgentOriginSchema, AgentProviderSchema, ForkedFromSchema } from "./agent.js";
import { LoopStateSchema } from "./loops.js";
// A "fleet agent" is any conversation with a registry entry, keyed by its conversationId. Isolated ones own a
// git worktree (branch agent/<id> in every workspace repo); workspace conversations have no branch. The fleet
// surface shows both through the same status/activity/cost lifecycle.

// idle/running/awaiting are the turn lifecycle (awaiting = paused on a plan approval or question); ready /
// landed / conflict are outcomes of the land flow, `ready` is a clean completion whose delta stayed on the
// agent's branch because auto-land is off (the user lands it deliberately, from the review panel or the card);
// error is a terminal turn failure surfaced on the card.
//
// `interrupted` is the turn that never got to report ANY of those: the daemon died under it (a container
// rebuild, a crash, an OOM kill), taking the provider process and the whole runtime half of the fleet, status,
// attention flags, the park a question raised, with it. It exists because the alternative is worse than
// unlabelled: without it such a turn rehydrates as `idle`, which is the resting status of a turn that finished
// CLEANLY, so the board files a killed agent under Finished and the question it was holding disappears with the
// process that asked it. See agents-store.ts, this is the status a live turn leaves on disk.
//
/* `stopping` and `stopped` are the two halves of a user's Stop, and they exist because a hard-cancel is NOT
 * instant: /agent/stop aborts the provider and then waits for the turn's generator to unwind (worktree and
 * registry cleanup), which is seconds of real time. For that whole window the runtime half still said
 * `running`, so every surface kept its spinner turning on a turn the user had already killed, and then the
 * card jumped to a settled state out of nowhere. `stopping` is what the daemon knows the instant the abort
 * lands, published immediately so the press has a visible result; `stopped` is where the turn comes to rest.
 *
 * `dismissing` IS THAT SAME WINDOW FOR THE OTHER ENDING A PERSON CHOOSES, waving away the question the turn was
 * parked on, and it is a status of its own for one reason: the two endings come to rest in different places.
 * A Stop leaves half-written work somebody has to pick up, so its card settles in Attention; a dismissal is
 * "I am done with this", so its card settles in Finished. Published as one value, the unwind could not say
 * which, so every surface had to park the card where it already was and move it once the turn had ACTUALLY
 * finished, seconds later, and the daemon papered over the dismissal half by suppressing the broadcast that
 * would have filed it under Active in the meantime — a bet on nothing else broadcasting inside that window,
 * which a second agent's frame lost routinely. Said apart, the destination is known at the press: each card
 * moves once, immediately, to the lane it is going to end up in, and no surface has to guess or suppress.
 *
 * `stopped` is deliberately its own value rather than `interrupted` or `error`. Not `error`, which is what a
 * stopped turn used to report (every provider adapter surfaces the abort's unwind as an error frame), a card
 * accusing the user's own deliberate press of being a failure. Not `interrupted` either: that one means the
 * daemon died under the turn, and a boot pass may re-run it, which is precisely what must never happen to a
 * turn a person chose to end. */
/* `resuming` is the same argument as `stopping`, made about the other end of a turn's life: the turn was killed
 * by something the daemon is ALREADY undoing (a rotated credential being re-minted, a provider outage being
 * waited out, turn-resume.ts), so it has stopped without having ended. The gap is real time, a few seconds for
 * a re-mint, minutes for an outage's backoff, and for that whole window the turn reported the resting `idle`,
 * which the board reads as finished. So a 401 that nobody caused and nobody has to fix filed the card under
 * Finished and then pulled it back into Active a moment later, which is the fleet contradicting itself in front
 * of the user about work that never stopped being in progress.
 *
 * Never persisted (see PersistedAgentStatusSchema): what is coming back is remembered in the daemon's memory
 * alone, and a daemon that dies mid-wait takes the resume with it, so the card falls back to the ending its
 * killed turn actually wrote and reads as finished, which by then is true. Nothing is left to bring it back. */
export const AgentStatusSchema = z.enum([
    "idle",
    "running",
    "awaiting",
    "stopping",
    "dismissing",
    "stopped",
    "resuming",
    "ready",
    "landed",
    "conflict",
    "error",
    "interrupted",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
// The card's live activity snippet: the last tool the agent used (with its target) and the in-progress todo.
export const AgentActivitySchema = z.object({
    tool: z.string().optional().describe("The last tool it reached for."),
    target: z.string().optional().describe("What it reached for that tool with: a file, a command, a URL."),
    todo: z.string().optional().describe("The item on its own list that it is working through."),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
// Which "needs you" flags are raised, the fleet badge aggregates these across all agents.
export const AgentAttentionSchema = z.object({
    plan: z.boolean().describe("It has proposed a plan and is waiting for a yes."),
    question: z.boolean().describe("It has asked you something."),
    permission: z.boolean().describe("It wants to use a tool it needs permission for."),
    // A priced service run parked on the owner's click (platform/service-offer.ts), the one card where
    // waiting costs the agent its whole call, so the lane says "spend approval" rather than a generic pause.
    service: z
        .boolean()
        .describe("It wants to spend money on a paid service and is waiting for approval. The one pause where waiting costs it the whole call."),
    // A missing capability parked on the owner's setup (capabilities/capability-offer.ts), the agent is
    // waiting for something to be connected, so the lane can say "setup needed" rather than a generic pause.
    capability: z.boolean().describe("It needs something connected that is not connected yet."),
    conflict: z.boolean().describe("Its work cannot be merged without somebody resolving a clash."),
});
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;
/* WHAT A LANDING IS CALLED, the commit message drafted from the landed diff (agents/landed-subject.ts), and
 * the whole of it: a subject, and the two trailer sentences a repo that keeps a changelog gets.
 *
 * ONE SHAPE, TWO CARRIERS, and that is the reason it is a schema of its own rather than three fields written
 * out twice. The same sentence reaches the Changes panel down two roads, the fleet roster, which is live and
 * drops archived agents, and the review, which is a rescan and outlives the card (OriginAgent), so the panel
 * takes whichever answers first and must not care which one did. Two hand-kept copies of these three fields
 * would be two things to keep in step, and the one that drifted would be the one nobody was looking at.
 *
 * THE PARTS STAY APART. A subject is one bounded line everywhere it is stored and shown; the notes are
 * sentences for the people who read a release. Flattening them into one string would produce a run-on subject
 * in the commit box and a truncated note in the changelog, so they are joined only at the moment of the fill,
 * where they become a commit message with its trailers and nowhere before it. */
export const LandedMessageSchema = z.object({
    /* WHAT THIS AGENT'S LANDED WORK DID, as a commit subject, written from the landed diff when the work
     * arrived, which is why it can say what a title cannot.
     *
     * A title names the ASK, and it is written once, from the opening prompt, a second into the first turn. A
     * conversation that opens "audit the review panel" and then spends four turns fixing what the audit found
     * still answers to "Review panel · audit", a good name for the session and a wrong subject for the
     * commit. This is read off the code instead, so it describes the change the user is about to record. */
    subject: z
        .string()
        .describe(
            "One line saying what the merged work did, read off the code rather than off the opening request. A conversation that asks for an audit and then spends four turns fixing what it found needs a subject about the fixes.",
        ),
    /* THE SAME LANDING, SAID TO A USER, the `Release-Note:` sentence the chip files in under the subject, for
     * a repo that keeps a changelog (SandboxSettings.changelogRepos).
     *
     * Usually absent, and that is the design: most landings change nothing a user would notice, and the model
     * is told to omit the note for those rather than to invent one. */
    note: z
        .string()
        .optional()
        .describe(
            "The same change said to somebody who uses the product, for a repository that keeps a changelog. Usually absent, because most changes are not ones a user would notice.",
        ),
    /* WHAT THE SAME LANDING TAKES AWAY, the `Breaking-Note:` sentence, filed as its own trailer so the
     * release harvest can put it under "Breaking changes" and the update card can warn with it before the
     * update rather than after. Nearly always absent: the model is told a breaking note is for removals only,
     * and to omit it when in doubt, except when the landing shrinks a wire-contract lock, where the sentence
     * is REQUIRED and mechanically guaranteed (the daemon's git/contract-shrink.ts) rather than judged. */
    breaking: z
        .string()
        .optional()
        .describe("What this change takes away, for anything already relying on it. Nearly always absent: it is for removals, not for additions."),
});
export type LandedMessage = z.infer<typeof LandedMessageSchema>;
/* ONE MODEL'S TURN IN THE DRAFTING WALK, asked, and what became of the ask. The quick-model chain tries the
 * connected models in order (agent/quick-model.ts), and each rung ends one of four ways:
 *   asking  , in flight right now; `ms` absent because it is still being spent.
 *   answered, it wrote the sentence, in `ms`.
 *   refused , it failed or declined, in `ms`, with its own words in `reason`.
 *   skipped , not asked at all: it refused within the last few minutes and the walk stepped over it, with the
 *              reason it gave back then. Skipping is the memo working, and it reads as such.
 * The steps arrive in the order they were spent, so the list IS the timeline. */
export const LandedMessageStepSchema = z.object({
    provider: z.string().min(1).describe("Which provider was asked."),
    model: z.string().min(1).describe("Which of its models."),
    status: z
        .enum(["asking", "answered", "refused", "skipped"])
        .describe("How this one went. Skipped means it was not asked at all, because it refused a few minutes ago and the walk stepped over it."),
    // When this rung started being asked, ms since epoch, what an in-flight step's ticking "12s…" is measured
    // from, client-side, without a frame per second. Absent for `skipped`, which cost no time at all.
    at: z.number().optional().describe("When it started being asked, in milliseconds. Absent for one that was skipped, which cost no time."),
    ms: z.number().optional().describe("How long it took. Absent while it is still being asked."),
    reason: z.string().optional().describe("Why it refused, in its own words."),
});
export type LandedMessageStep = z.infer<typeof LandedMessageStepSchema>;
/* THE FULL ACCOUNT OF ONE LANDING'S COMMIT MESSAGE BEING DRAFTED, everything a user waiting at the commit box
 * is owed: that the draft started, which models have been asked, how each one went, and how it ended.
 *
 * `outcome` is absent while the draft is RUNNING, which is what "a sentence is on its way" now means, the
 * boolean flag this replaces could say only that, and nothing else this schema carries. Ended, it is:
 *   written, the sentence is on the card (`landedMessage`) and in the box; the steps say who wrote it.
 *   failed , nothing usable came back. The steps carry each model's own words; `reason` is the one-line
 *             account for the surfaces with a single line to spend (an answer that was itself a refusal
 *             sentence, or the whole chain spent).
 * An empty `steps` with no outcome is the moment before the first model is asked, the diff is being read. */
export const LandedMessageDraftSchema = z.object({
    startedAt: z.number().describe("When the drafting began, in milliseconds."),
    steps: z
        .array(LandedMessageStepSchema)
        .describe(
            "Each model that was asked, in the order they were spent, so the list is the timeline. Empty with no outcome means the diff is still being read.",
        ),
    outcome: z.enum(["written", "failed"]).optional().describe("How it ended. Absent means it is still going."),
    reason: z
        .string()
        .optional()
        .describe("The one-line account of a failure, for a screen with one line to spend. The steps carry each model's own words."),
    finishedAt: z.number().optional().describe("When it ended, in milliseconds."),
});
export type LandedMessageDraft = z.infer<typeof LandedMessageDraftSchema>;
export const AgentSummarySchema = z.object({
    // The conversationId.
    id: z.string().describe("The conversation id, which is how every other call addresses it."),
    sessionId: z.string().optional().describe("The provider session behind the last turn. It is retired whenever the model or account changes."),
    // First prompt, sanitized to one bounded line.
    title: z.string().optional().describe("What to call it: the first prompt cut to one line, unless somebody renamed it."),
    status: AgentStatusSchema.describe(
        "What it is doing. Stopping and stopped are the two halves of somebody pressing stop, because a cancel is not instant; dismissing is the same window for a question waved away, which ends the turn too but owes the user nothing; resuming means the sandbox is already putting right whatever killed the turn.",
    ),
    /* WHY THE LAST TURN FAILED, the sentence it died on, carried beside the `error` status because that word
     * on its own is not an answer. A session refused on its first request (an organization with Claude Code
     * switched off, a spent allowance, a model the endpoint has never heard of) reached every surface as a grey
     * "error" and a link into the transcript, so the one place the reason existed was the dead conversation
     * itself, which is exactly where an unattended run, started from a fan-out nobody is watching, is least
     * likely to be read. Absent unless the last turn ended in failure, and cleared the moment it runs again. */
    failure: z
        .string()
        .optional()
        .describe(
            "Why the last turn failed, in the words it died on. Absent unless it did, and cleared the moment it runs again. Carried here because the word error on its own is not an answer, least of all for a run nobody was watching.",
        ),
    /* WHICH KIND OF FAILURE IT WAS, the error frame's own code (AgentEvent's `error`), beside the sentence it
     * came with. The sentence says what happened to a person; this says it to the board, which has to DRAW the
     * difference and could not.
     *
     * The chat has always had it, and the gap between the two surfaces is the whole reason this exists. A chat
     * reads `rate_limit` and renders a muted notice with a countdown and a press; the board read `status:
     * "error"` and rendered a red crash line with "View error" on it, because the code never reached the
     * summary. So one spent allowance looked exactly like a harness that died mid-run, on the surface where
     * most people meet it, and the state the product knows most about (it knows when it ends) was the one
     * drawn with the least. */
    failureCode: z
        .string()
        .optional()
        .describe(
            "Which kind of failure it was, as the turn's own error frame coded it. Absent for a failure nothing could classify, which reads as the plain red line it is.",
        ),
    /* WHEN THE SPENT WINDOW REOPENS (epoch SECONDS), for a card whose last turn a usage limit refused. The one
     * fact this failure has and no other failure here does, and the reason it is not a failure at all so much
     * as a wait: nothing is broken, nobody has anything to fix, and the thing that changes the outcome is a
     * clock. A card that cannot say the hour has to spend its line saying "Error" instead, which is how an
     * 18-hour-old refusal went on reporting a wall that had reopened before breakfast.
     *
     * Absent means the instant is genuinely unknown, which for Grok (no published quota) and Cursor (not routed
     * through the translator) is the honest answer and stays one. Never invent one: a countdown to a guess is
     * worse than no countdown, because the reader plans around it. */
    limitResetsAt: z.number().optional().describe("When the spent allowance reopens, in epoch seconds. Absent when the provider publishes no instant."),
    /* THE DAEMON IS STILL HOLDING THAT EXACT TURN, so the way on is one press that RE-RUNS it rather than a new
     * message saying "carry on" (turn-resume.ts's pendingLimit has the whole argument, and the transcript full
     * of the word "Continue" that made it). On the summary because the board is where somebody with four
     * stranded agents is standing, and until now the press existed only inside each chat. */
    limitHeld: z.boolean().optional().describe("Whether the refused turn is held whole, so sending again re-runs it instead of appending to it."),
    /* A FIRE IS ALREADY BOOKED FOR THIS ONE: the conversation is armed (`resumeAfterLimit`), the reset instant
     * is known, and the daemon's pass will send the held turn again when the window opens without anybody
     * pressing anything.
     *
     * IT IS THE ONE THING THAT MOVES A STRANDED CARD OUT OF THE ATTENTION LANE, and the only reason it needs to
     * be on the wire at all. "Does this session need me?" is the question that lane answers, and for a spent
     * allowance the honest answer is yes: the window reopening does not send the turn, a person does. Unless
     * this is set, in which case a machine does, and demanding a press for work already booked is the same
     * false alarm as demanding one for a turn that is running.
     *
     * A BOOLEAN THE DAEMON ALREADY DECIDED rather than a posture the client re-folds. The effective posture is
     * two levels deep (this conversation's override, else the sandbox setting), and the lane machine is a leaf
     * with no store to ask: threading a settings read through every caller of `laneOf` would put the answer in
     * five places and let them disagree. The daemon resolves it once, where the failure happened. */
    limitScheduled: z.boolean().optional().describe("Whether the held turn is already booked to go again at the reset, so nobody has to press anything."),
    provider: AgentProviderSchema.describe("Which model provider it runs on."),
    harness: AgentHarnessSchema.describe("Which agentic loop it runs on."),
    // Which machine its turns execute on: a paired runner's id, absent for this sandbox (runners/). Latched
    // with the conversation, so a card can say where the work is happening without asking anything.
    runner: z.string().optional().describe("The runner this conversation runs on. Absent means this sandbox."),
    // What the agent's last turn ran with, the model, its reasoning effort, whether extended thinking was on,
    // and whether fast speed was asked for. Recorded per agent because they are facts about THIS conversation: a
    // client opening it seeds its composer from them, rather than from whatever that browser last picked in some
    // other tab. Absent for an agent whose turns predate the record (model has always been kept; the rest are
    // newer). `fast` is what was REQUESTED, not what was served, the served answer belongs to a turn and rides
    // its `fast_mode` frame, while this is the composer's memory of the user's own choice.
    model: z
        .string()
        .optional()
        .describe(
            "What its last turn ran with. Kept per conversation so opening it restores the choices made in it, rather than whatever some other tab last picked.",
        ),
    effort: z.string().optional().describe("How hard that turn was told to think."),
    thinking: z.boolean().optional().describe("Whether that turn showed its reasoning."),
    fast: z.boolean().optional().describe("Whether that turn asked for higher speed. What was asked for, not what was served."),
    /* WHAT THE COMPLEXITY JUDGE MADE OF THE LAST TURN HERE, mirrored from the persisted entry (agents-store.ts
     * `tier`) so a client opening the conversation tomorrow can seed its composer preview with the one judge
     * input a draft cannot contain (prompt-complexity.ts `afterHardTurn`). The JUDGEMENT, never what ran, for
     * the reason the store states: what ran is a fact about configuration, the next turn is asking about the
     * difficulty of the work. Absent ⇒ nothing judged yet. */
    tier: z
        .enum(["fast", "standard"])
        .optional()
        .describe("How hard its last turn looked to the complexity judge. What the next turn's preview needs, not what actually ran."),
    // The conversation's standing "keep every turn on my pick" choice, the composer's memory of it, the same
    // shape as `fast` above: what was asked for, restored into the composer on open, sent back on every turn.
    tierHold: z
        .boolean()
        .optional()
        .describe("Whether this conversation is pinned to the picked model, so a turn that looks simple is never moved to a cheaper one."),
    account: z.string().optional().describe("Which connected account paid for it."),
    // The worktree branch (agent/<id>); absent for a non-isolated (main-tree) conversation.
    branch: z.string().optional().describe("The branch its private copy works on. Absent for a conversation that works directly in the shared tree."),
    // This agent's own answer to "land automatically at turn completion?", an explicit per-agent override of
    // the sandbox-wide `autoLand` setting. ABSENT ⇒ inherit, which is the common case and the one that keeps
    // the global toggle meaningful: an agent that never expressed an opinion follows the sandbox wherever it
    // is pointed next. Written by `agents.autoLand`; the UI shows the EFFECTIVE value (this ?? the setting).
    autoLand: z
        .boolean()
        .optional()
        .describe(
            "This conversation's own answer to whether its work merges automatically. Absent means it follows the sandbox-wide setting, which is the common case.",
        ),
    /* This agent's own answer to "re-run my turn when the model provider was what failed?", the same
     * two-level shape as `autoLand` above, and here for a sharper reason than symmetry.
     *
     * The press that writes this is offered INSIDE one conversation, at the moment that conversation's turn
     * died, and what a person means by it is "finish THIS piece of work". It used to write the sandbox-wide
     * setting, so one impatient click at 2 a.m. quietly armed every agent on the board, a scope
     * nothing on screen had asked about. So the chat's offer writes this, the settings toggle writes the
     * default, and the two stay honestly different things.
     *
     * ABSENT ⇒ inherit the sandbox setting, which is what keeps that default meaningful: a conversation that
     * never expressed an opinion follows the sandbox wherever it is pointed next. Written by
     * `agents.resumeAfterOutage`; every surface shows the EFFECTIVE value (this ?? the setting). */
    resumeAfterOutage: z.boolean().optional(),
    /* The same two-level shape again, for the blocker that is not a failure: "when a usage limit refused my
     * turn, send it again the moment the allowance comes back".
     *
     * IT IS THE ONE RESUME WITH A KNOWN HOUR, which is what makes it worth automating and what makes it
     * different from its neighbour. An outage resume guesses (a backoff, a bounded number of attempts, no idea
     * when the provider returns); this one waits for an instant the provider published and fires once, at it.
     *
     * OFF unless somebody says otherwise, and that default is load-bearing rather than cautious. Every other
     * blocker here clears at no cost to the user, while this one clears into a window they may have been
     * saving: spending it the second it reopens is not a decision to make on anybody's behalf. What arming it
     * buys is the case nothing else can reach, a turn that hit the wall at 2am on a board nobody is watching,
     * where the alternative is a card that waited eight hours for a press that was always going to come. */
    resumeAfterLimit: z.boolean().optional(),
    // A collaborator asked for this agent's work to be landed (agents.requestLand), collaborators may drive
    // agents but not merge into the main tree, so the ask rides the summary where every maintainer's board
    // sees it. Cleared by the land or discard that answers it. Absent ⇒ nobody is waiting.
    landRequested: z
        .object({
            email: z.string().describe("Who asked."),
            name: z.string().optional().describe("Their display name."),
            at: z.number().describe("When they asked, in milliseconds."),
        })
        .optional()
        .describe(
            "A collaborator has asked a maintainer to merge this work. Cleared by whichever merge or discard answers it. Absent means nobody is waiting.",
        ),
    // Present when the conversation was opened by an outside message rather than by the user (see
    // AgentOriginSchema), the card's provenance line. Absent ⇒ the user started it.
    origin: AgentOriginSchema.optional().describe(
        "Where the conversation came from when nobody typed it: a chat mention, a visitor's message, a webhook. Absent means a person started it.",
    ),
    /* Where this conversation was cut from, when it was cut from another. Recorded once, from the fork's very
     * first turn, and never cleared, it is the relationship, not a pending state.
     *
     * It rides the SUMMARY rather than living in the client's tabs because a fork and its source are two chats
     * that are obviously related and, without this, had no way to say how: the link has to survive closing
     * either tab and reopening it from history, and it has to be readable from the OTHER side, the source's
     * own transcript marks its cut points by looking for the conversations that name it. */
    forkedFrom: ForkedFromSchema.optional().describe(
        "The conversation this one was cut from. Recorded once and never cleared: it is the relationship, not a pending state.",
    ),
    // The ROOT repo's short base sha, the checkout moment's display identity. Per-repo bases stay
    // daemon-internal (agents.diff already reports against them).
    base: z.string().optional().describe("The commit its private copy started from, shortened."),
    costUsd: z.number().optional().describe("What it has cost so far, in dollars. A helper agent's spend is its own and is not folded in here."),
    inputTokens: z.number().optional().describe("Tokens sent."),
    outputTokens: z.number().optional().describe("Tokens received."),
    contextTokens: z.number().optional().describe("How much of the window the conversation currently fills."),
    contextWindow: z.number().optional().describe("How large that window is."),
    activity: AgentActivitySchema.optional().describe("What it is doing at this moment."),
    /* THE WHOLE STORY OF THIS LANDING'S COMMIT MESSAGE BEING WRITTEN, present from the moment the land starts
     * the draft, updated on every transition, and kept after it ends until the next land replaces it.
     *
     * This used to be one boolean ("a model is writing"), and a boolean is exactly one fact short of every
     * question the wait raises: WHICH model, for how long, what refused and in what words, what finally
     * answered. All of that was known in the daemon and thrown away at the door, a first-pinned model that
     * burned 58 seconds refusing on every landing had to be caught by watching CLI processes by hand, because
     * nothing on any screen could have shown it.
     *
     * Runtime only: nothing about it is persisted, so a daemon restart forgets it. That is correct rather than
     * lossy, a restart also killed the draft it would have been describing. */
    landedMessageDraft: LandedMessageDraftSchema.optional().describe(
        "The whole story of this merge's commit message being written: which models were asked, how long each took, what refused and in what words. Forgotten on restart, which is right, because a restart also killed the drafting it describes.",
    ),
    /* AND THE SENTENCE ITSELF, once the flag above clears, what this agent's landed work is called, for the
     * Changes panel's "From" chip to file into the commit box.
     *
     * IT RIDES THE ROSTER because the roster is the channel that is already live for it. The review carries the
     * same fact (OriginAgent.subject) and has to, for an archived agent whose lines are still in the tree, but
     * the review is a workspace-wide rescan, coalesced daemon-side and refetched only when something asks, and
     * this sentence arrives ALONE, seconds after the work it describes, with nothing else moving. Every link in
     * that chain has to hold for a message that exists to become a message the user can see, and when one of
     * them doesn't, the box stays empty with nothing to say why, while the flag above, which travels on THIS
     * frame, has already told them a sentence was coming.
     *
     * So the fact goes where the promise went. Same push, same instant: the frame that ends `landedMessageDraft`
     * is the frame that carries the answer, which is also what makes "your commit message is ready" honest.
     *
     * Absent for every agent that has not landed, and for a landing nothing could be written about. Replaced
     * wholesale by the next land, the claim grows and so does the sentence about it. */
    landedMessage: LandedMessageSchema.optional().describe(
        "What this conversation's merged work is called, once the drafting above has finished. It arrives on the same push that ends the draft, so the promise and the answer travel together.",
    ),
    // Present while a turn runs: its start, ms since epoch.
    startedAt: z.number().optional().describe("When the running turn started, in milliseconds. Absent when none is running."),
    updatedAt: z.number().describe("When it last did something, in milliseconds. Reading it does not count."),
    // When the agent was last OPENED, ms since epoch, the unread badge's reference point (`updatedAt >
    // seenAt` ⇒ the agent has done something you haven't looked at). Absent ⇒ never opened. Daemon-side on
    // purpose: read state is a fact about the WORK, not about one browser profile, so clearing site data or
    // picking up the phone must not resurrect every badge.
    seenAt: z
        .number()
        .optional()
        .describe(
            "When somebody last opened it, in milliseconds. Newer activity than this is what makes it unread. Kept by the sandbox rather than by a browser, so clearing site data or picking up a phone does not resurrect every badge.",
        ),
    attention: AgentAttentionSchema.describe("Which kinds of waiting-for-you it is doing."),
    // Completed turns and lifetime tool calls, the card's msgs/tools counters.
    turns: z.number().optional().describe("Turns it has finished."),
    toolUses: z.number().optional().describe("Tools it has used, over its whole life."),
    /* The agents THIS agent started (SubagentSessionSchema), live and lifetime. Absent ⇒ it has never delegated,
     * which is most agents, so the card's chip appears on content rather than reading "0" down the board.
     *
     * THE TWO HALVES COME FROM DIFFERENT PLACES, and have to: `running` is read off the live subagent registry,
     * which sweeps a child five minutes after it reports and remembers nothing across a restart, while `total`
     * is counted onto the agent's own entry as each child is born. Deriving both from the live registry is what
     * used to take the count off a card while the agent that earned it was still on the board.
     *
     * It earns a place on a card because a fleet card is the answer to "what is this agent up to", and an agent
     * running five children looked exactly like an agent running none: the work was real, the spend was real, and
     * the board said nothing. The tokens are NOT folded into the parent's cost, a child's spend is its own, and
     * the Subagents area is where it is attributed. */
    subagents: z
        .object({
            running: z.number().describe("Helpers working right now."),
            total: z.number().describe("Helpers it has started over its whole life."),
        })
        .optional()
        .describe(
            "Helper agents this one delegated to. Absent means it never has, which is most conversations. Their spend is their own and is not folded into this conversation's cost.",
        ),
    // The agent's cumulative output (base → branch tip across every repo), refreshed on each land,
    // the card's "12 files · +412 −96" readout. Independent of what has landed.
    diff: z
        .object({
            files: z.number().describe("Files touched."),
            insertions: z.number().describe("Lines added."),
            deletions: z.number().describe("Lines removed."),
        })
        .optional()
        .describe("Everything it has written, measured from where it started. Independent of how much has been merged."),
    /* HOW MUCH OF WHAT THIS AGENT LANDED IS STILL IN YOUR WORKING TREE, present only when some of it ISN'T.
     *
     * A land applies its delta to the main tree as uncommitted changes, so the user can discard it there like
     * any other change, and every other reading on this card is measured between commits and cannot see that
     * happen (landed-presence.ts). Left unsaid, the card goes on wearing a landed chip and the session menu
     * goes on saying "Already in your workspace" over a tree that no longer holds it, and the next land
     * carries only the NEW delta, dropping turn 2 onto a tree missing turn 1.
     *
     * `present` counts the landed paths still there: dirty, or committed into history, a commit is the
     * strongest form of still-there, which is why this cannot be folded into the Changes panel's own
     * attribution, where a commit is what ENDS the agent's claim (origins.ts).
     *
     * Absent is the steady state and the quiet one: an agent that never landed and an agent whose work is
     * exactly where it left it both say nothing. Its PRESENCE is the signal, which is what keeps the board
     * from spending a line per card on the ordinary case. */
    landedPresence: z
        .object({
            landed: z.number().describe("Paths this conversation merged in."),
            present: z.number().describe("How many of them are still there, either pending or committed."),
        })
        .optional()
        .describe(
            "Present only when some of what it merged has since been thrown away. Absent is the steady state: its presence is the signal, so an ordinary card spends no line on it.",
        ),
    /* The loop driving this conversation, when one is (or was), "iteration 3/12, until the suite is green".
     *
     * PROJECTED onto the card rather than fetched beside it, and that is the whole reason a loop needed no
     * surface of its own: a looping agent is an agent, so the board's status, spend, unread badge and Stop
     * button already describe it, and one extra line is the difference between a card that says `running` for
     * forty minutes and one that says what it is running towards. A second query joined client-side would have
     * paid for the same line with a poll that can disagree with the roster.
     *
     * Absent ⇒ an ordinary conversation, which is nearly all of them. */
    loop: z
        .object({
            state: LoopStateSchema.describe("How the loop is going."),
            iteration: z.number().int().min(0).describe("Which round it is on."),
            maxIterations: z.number().int().min(1).describe("How many rounds it will attempt before giving up."),
            goal: z.string().describe("What it is looping towards."),
        })
        .optional()
        .describe("The loop driving this conversation, if one is. Absent for an ordinary conversation, which is nearly all of them."),
    /* The workflow run this conversation is a step of, "Ship the feature · step 3 of 4 · Review the change".
     *
     * Projected for the same reason the loop above is, and it answers a question only the board can be asked. A
     * run of four `fresh` steps IS four conversations, so it arrives on the board as four unrelated cards that
     * started a few minutes apart, the work reads as four people who happen to be busy rather than as one job
     * with a shape. Naming the run on each card is what makes them one block, and `runId` is what lets the board
     * order them together and link every one of them at the run's own graph.
     *
     * POSITION IS A FACT ABOUT THE STEP, not a running total: `index`/`total` are its place in the workflow's own
     * step order, so a card is published once when its step starts and never has to be rewritten because a
     * sibling advanced. How the run as a whole is going is the run page's job, and how THIS step is going is
     * already the card's status and the loop line above.
     *
     * `step` moves within one conversation when steps are chained with `continue`, they share it, which is the
     * point of chaining, so this says which one is on it NOW.
     *
     * Absent ⇒ an ordinary conversation. */
    workflow: z
        .object({
            runId: z.string().describe("The run this belongs to, which is how a board groups its steps together."),
            name: z.string().describe("The workflow's name."),
            step: z.string().describe("Which step this conversation is on now. It moves when steps are chained."),
            index: z.number().int().min(1).describe("This step's place in the workflow, counting from one."),
            total: z.number().int().min(1).describe("How many steps the workflow has."),
        })
        .optional()
        .describe(
            "The workflow run this conversation is a step of. Without it, a four-step run reads as four unrelated conversations that happen to have started together.",
        ),
    /* THE OUTSIDE CONDITIONS THIS CONVERSATION IS PARKED ON, the armed condition watches (the daemon's
     * agent/watchers.ts), projected onto the card for the same reason the loop and the workflow above are.
     *
     * IT IS THE ONE PROMISE THE BOARD USED TO KEEP SILENTLY. An agent that arms a watch ends its turn: nothing
     * is running, nothing is owed to the user, so every surface filed it under finished and drew the resting
     * `idle`. Then, some hours later, the daemon's check exits 0 and that same conversation starts working
     * again, on its own, in front of somebody who had been told it was done. The wake is the feature; the card
     * saying nothing about it beforehand is what made it read as the sandbox acting unasked.
     *
     * It also has a bill attached, which no other projection here does. An armed watch keeps a hosted machine
     * awake (system/idle-stop.ts counts them, deliberately: stopping the box is how a watch silently never
     * fires), so an invisible watch is invisible compute. A user looking at a board of finished agents,
     * wondering why the machine will not go quiet, could not have found the answer anywhere.
     *
     * WHAT IS ON THE WIRE IS WHAT A CARD CAN ACT ON, and nothing else. The note (the agent's own line on what
     * it is waiting for), the cadence, and the deadline, which is what turns "waiting" into a countdown with an
     * end. Deliberately NOT the check command: it is shell text the reader cannot run, judge or fix from a
     * board, and it is the one field that could carry a secret reference into a surface that is read over
     * shoulders. Deliberately NOT the check COUNT either, which would move every interval and buy a whole
     * roster broadcast to advance a number nobody is reading.
     *
     * Absent ⇒ nothing armed, which is nearly every conversation. Empty is never sent: the daemon clears the
     * projection instead, so the field's PRESENCE is the signal. */
    watches: z
        .array(
            z.object({
                id: z.string().describe("The daemon's handle for this watch, the same one the agent was given when it armed it."),
                note: z.string().describe("The agent's own line on what it is waiting for."),
                intervalSeconds: z.number().int().min(1).describe("How often the check runs."),
                deadlineAt: z.number().describe("When it gives up and wakes the conversation anyway, in milliseconds. Every watch has one."),
            }),
        )
        .optional()
        .describe(
            "Outside conditions this conversation is parked on, each of which will wake it. Absent means none, which is nearly every conversation: an armed watch is why a finished-looking agent starts working by itself, and why a hosted machine will not go idle.",
        ),
    // When the agent was ARCHIVED (ms epoch), off the board, but nothing lost: its checkout was retired
    // (worktree removed) while the agent/<id> branch, the transcript, and every counter stayed. Absent ⇒ live
    // on the board. Archived agents are excluded from the roster the fleet renders; `agents.archived` lists
    // them, `agents.unarchive` brings one back, and the next turn re-attaches its worktree from the branch.
    archivedAt: z
        .number()
        .optional()
        .describe(
            "When it was put away, in milliseconds. Nothing was lost: its branch, its record and every counter stayed, and bringing it back gives it a fresh working copy. Absent means it is live on the board.",
        ),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
// One armed condition watch as a card carries it (AgentSummarySchema.watches). Named off the summary rather
// than declared beside it, so the shape the daemon publishes and the shape the wire promises cannot drift.
export type AgentWatch = NonNullable<AgentSummary["watches"]>[number];
// AgentsListSchema lives further down, after AutomationApprovalSchema, the fleet list carries the held wakes,
// and zod declaration order forces the ride-along to be declared first.
export const AgentIdSchema = z.object({ id: z.string().min(1).describe("Which conversation.") });
// archive's input: the agents to take off the board. Absent `ids` ⇒ every finished agent that is archivable
// right now (the lane header's "Clear"); unarchive always names its ids (a restore, or a bulk archive's undo).
export const AgentArchiveSchema = z.object({
    ids: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe("Which conversations to put away. Leave it out for every finished one that can be archived right now."),
});
export const AgentIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500).describe("Which conversations.") });
// What actually MOVED, and deliberately NOT the roster afterwards. Two archives in flight at once each finish
// holding a full-roster snapshot from a different instant, so a client that swapped one in wholesale would let
// the slower response resurrect what the faster one just filed away, a delta composes where a snapshot races.
// Whole summaries rather than ids because the receiving side has to SHOW them (the archive list, and the agent
// detail page addressed by id); the ids "Undo" needs come off them for free.
// The agents an archive/unarchive actually moved, plus the registry revision that applied the move, the
// browser holds its optimistic add/remove of exactly these ids until it sees a roster at or past `rev`.
export const AgentsMovedSchema = z.object({
    moved: z
        .array(AgentSummarySchema)
        .describe(
            "What actually moved, whole, rather than the fleet afterwards. Two archives finishing at once would each carry a snapshot from a different instant, and swapping one in wholesale would let the slower answer resurrect what the faster one just filed away.",
        ),
    rev: z
        .number()
        .describe(
            "The version of the fleet that includes this move, so a caller can hold its own optimistic change until it sees a list at least that new.",
        ),
});
export type AgentsMoved = z.infer<typeof AgentsMovedSchema>;
/* AN ARCHIVE ALSO REPORTS WHAT IT COULD NOT DO, which is the half that used to go missing. Releasing a working
 * copy is git work, and it can fail for reasons no press can fix: the repository behind a checkout was deleted
 * from the workspace, a checkout is locked. Those agents stay on the board, so the answer carries them and the
 * sentence each failed with, otherwise the only true thing the caller could say about an archive that moved
 * nothing was "there was nothing to archive": to a user looking straight at the card it refused. */
export const AgentsArchivedSchema = AgentsMovedSchema.extend({
    failed: z
        .array(
            z.object({
                id: z.string().describe("Which conversation stayed on the board."),
                reason: z.string().describe("Why its working copy could not be released, in the words the failure came with."),
            }),
        )
        .describe("The conversations this press could not put away, each with the reason, so the board can say it instead of reporting silence."),
});
export type AgentsArchived = z.infer<typeof AgentsArchivedSchema>;
// What a purge actually deleted. Ids, not summaries: these agents no longer exist anywhere, there is nothing
// left to show and nothing to put back, so the only thing the caller can do with the answer is drop those rows
// and count them. No revision either: archived agents are already off the broadcast roster (see `list`), so a
// purge changes nothing the board's pending-move machinery has to hold a card against.
export const AgentsRemovedSchema = z.object({
    removed: z
        .array(z.string())
        .describe(
            "Which conversations were deleted, as ids. Ids rather than whole cards, because these no longer exist anywhere: there is nothing left to show and nothing to put back.",
        ),
});
export type AgentsRemoved = z.infer<typeof AgentsRemovedSchema>;
/* Search the fleet by what was SAID in it, the board's filter (and the popped-out rail's).
 *
 * Both sides of the conversation, and nothing else: the user's own prompts and the agent's chat bubbles. What
 * an agent ANSWERED is half of what a chat is remembered by, the name it found, the file it named, the number
 * it reported, and a filter that could not reach it sent people back to opening chats one at a time.
 *
 * What stays out is everything that is not speech: extended thinking, tool calls and their output, and the
 * daemon's own protocol (preambles, attachment notes). That is the line the old user-only rule was really
 * drawing, tool output alone names nearly every identifier in the workspace, so matching it returns most of
 * the board and the filter stops filtering. Prose is a fraction of a transcript and reads like a sentence
 * someone wrote, which is why it can be searched when a diff dump cannot.
 *
 * The card TITLE is the first prompt (sanitized), so a title match and a prompt match are one rule, not two.
 *
 * Two chars minimum: below that every agent matches and the scan is pure cost.
 *
 * `caseSensitive` is the field's Aa switch, the same name and the same default as the workspace search's, so
 * one word means one thing across the daemon's search routes. Off is case-INSENSITIVE rather than smart case:
 * a filter that quietly changed rule when a capital was typed would make the switch beside it a lie.
 */
export const AgentSearchQuerySchema = z.object({
    query: z
        .string()
        .trim()
        .min(2)
        .describe(
            "What to look for. Searched against what was said, both sides of the conversation, and nothing else: not the thinking, not the tool output, which between them name nearly every identifier in the workspace and would return most of the board.",
        ),
    caseSensitive: z.stringbool().optional().describe("Whether capitals matter."),
});
/* WHY a row survived the filter: the matched line, windowed around the hit, and which side of the conversation
 * said it. A result that matches for a reason the reader cannot see is worse than no filter at all.
 *
 * `speaker` rides WITH the text rather than beside it because the two are never separately true, every line is
 * someone's, and because the words alone stopped being self-identifying the moment agent prose became
 * matchable: "landAgent lives in laneDrop.ts" under a card reads as something the user typed until the row
 * says otherwise.
 */
export const SpeakerSchema = z.enum(["user", "agent"]);
export type Speaker = z.infer<typeof SpeakerSchema>;
export const MatchSnippetSchema = z.object({
    text: z.string().describe("The matching line, with a little either side of it."),
    speaker: SpeakerSchema.describe(
        "Who said it. Carried with the words rather than beside them, because a line of the agent's prose under a card reads as something you typed until the row says otherwise.",
    ),
});
export type MatchSnippet = z.infer<typeof MatchSnippetSchema>;
// One matching agent, and the evidence for it. `snippet` is absent when the match is the TITLE, which the card
// already shows, repeating it underneath is noise where evidence was wanted.
export const AgentMatchSchema = z.object({
    id: z.string().describe("Which conversation matched."),
    snippet: MatchSnippetSchema.optional().describe(
        "Why, in its own words. Absent when the title was the match, which the card already shows: repeating it underneath is noise where evidence was wanted.",
    ),
});
export type AgentMatch = z.infer<typeof AgentMatchSchema>;
// `scanned` is how many agents the daemon actually read prompts for, so the board can say when a query saw
// less than the whole fleet rather than implying it saw all of it.
export const AgentSearchResultSchema = z.object({
    matches: z.array(AgentMatchSchema).describe("What matched, from the live fleet and the archive together."),
    scanned: z
        .number()
        .describe(
            "How many conversations were actually read, so a screen can say when a search saw less than everything rather than implying it saw all of it.",
        ),
    indexing: z
        .boolean()
        .describe(
            "Whether what was said is still being read in the background. True means this answer can still grow, so a screen must say it is incomplete rather than presenting it as the whole list.",
        ),
});
export type AgentSearchResult = z.infer<typeof AgentSearchResultSchema>;
// rename's input: the user-chosen display title (bounded like sanitizeTitle's cap).
export const AgentRenameSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    title: z.string().trim().min(1).max(80).describe("What to call it from now on."),
});
/* place's input: words the user writes INTO the transcript wearing the agent's voice (see agentsContract.place).
 * Bounded well above anything a person types by hand and just above the handoff's per-message render cap
 * (runtime-history's MESSAGE_CHAR_CAP), a placed line longer than that would reach the agent truncated, which
 * silently breaks "it thinks these are its own words". Better to refuse at the door with a reason. */
export const AgentPlaceSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    text: z
        .string()
        .trim()
        .min(1)
        .max(8_000)
        .describe(
            "The words to put in the agent's mouth. Bounded just above what the next turn can carry whole, because a line too long to be handed over intact would reach the agent truncated and quietly break the very thing this is for.",
        ),
});
// autoLand's input: this agent's own land-at-completion posture. `null` CLEARS the override back to "inherit
// the sandbox setting", the browser sends it whenever the user toggles back to what the global already says,
// so agents don't accumulate frozen overrides that quietly stop following the global toggle.
export const AgentAutoLandSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    autoLand: z
        .boolean()
        .nullable()
        .describe(
            "Whether its work merges automatically when a turn finishes. Null clears the override and goes back to following the sandbox-wide setting, so a conversation does not sit holding a frozen copy of a default it has quietly stopped following.",
        ),
});
// resumeAfterOutage's input: this ONE conversation's answer to a provider outage. `null` clears the override
// back to "inherit the sandbox setting", sent whenever the user toggles back to what the global already says,
// on the same reasoning as autoLand's null: an agent holding a frozen copy of a default has quietly stopped
// following it, and nothing on screen would say so.
export const AgentResumeAfterOutageSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    resumeAfterOutage: z
        .boolean()
        .nullable()
        .describe("Whether it retries by itself when the model provider was what failed. Null clears the override back to the sandbox-wide setting."),
});
// resumeAfterLimit's input, the same override in the same three states as the outage one above, for the
// blocker that comes back on a clock. Written by the card's own offer at the moment a limit strands a turn,
// which is where somebody looking at a stranded card actually is; the settings toggle writes the default.
export const AgentResumeAfterLimitSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    resumeAfterLimit: z
        .boolean()
        .nullable()
        .describe(
            "Whether the turn a spent allowance refused is sent again by itself once the window reopens. Null clears the override back to the sandbox-wide setting.",
        ),
});
export const AgentFileDiffQuerySchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    repo: z.string().min(1).describe("Which repository."),
    path: z.string().min(1).describe("Which file, relative to that repository."),
});
/* WHY a path would not land. The distinction is the whole difference between an actionable report and a dead
 * end, because the three have nothing in common but their symptom:
 *   `workspace`, you have uncommitted edits on that path. Yours is the copy at risk; commit or stash it.
 *   `diverged` , the main tree's COMMITTED content moved under the agent since it branched. Nothing of
 *                 yours is at risk; the agent's delta is simply written against an older file.
 *   `binary`   , git cannot three-way merge the file at all, so no automatic resolution exists.
 * The old report named only the first, which is the rarest of the three. */
export const LandConflictReasonSchema = z.enum(["workspace", "diverged", "binary"]);
export type LandConflictReason = z.infer<typeof LandConflictReasonSchema>;
export const LandConflictPathSchema = z.object({
    path: z.string().describe("Which file."),
    reason: LandConflictReasonSchema.describe(
        "Why it would not merge, and the three have nothing in common but the symptom. Your own uncommitted edits on that path, where yours is the copy at risk. The shared tree having moved under the conversation since it started, where nothing of yours is at risk. Or a file git cannot merge at all, where no automatic answer exists.",
    ),
});
/* A composed land's refusal, grouped per repo. `paths` is the set that genuinely failed to apply. NOT the
 * whole delta, which is what the first version reported whenever it could not pin the cause down, turning
 * four real conflicts into a wall of fourteen. `clean` counts what passed in that repo but stays on the branch
 * with the rest of the composition. An empty `paths` with `clean: 0` is the repo-unavailable case: the main
 * checkout is gone, and no path-level account exists. */
export const LandConflictSchema = z.object({
    repo: z.string().describe("Which repository."),
    paths: z
        .array(LandConflictPathSchema)
        .describe(
            "The files that genuinely would not apply. Not the whole change: reporting everything whenever the cause could not be pinned down turned four real conflicts into a wall of fourteen.",
        ),
    clean: z
        .number()
        .describe(
            "How many files in this repository passed but remain held with the refused composition. Zero alongside an empty list means the repository could not be reached at all.",
        ),
    // The branch the user's checkout is on, the thing the agent has to rebase onto. Carried because only the
    // daemon can see it: an isolated turn's worktree is mounted over the agent's whole view, so the resolution
    // errand could otherwise only tell it to go and read the name off `git worktree list`. Absent on a detached
    // HEAD or a vanished checkout, where there is no name to give.
    mainBranch: z
        .string()
        .optional()
        .describe(
            "The branch your own checkout is on, which is what the conversation has to rebase onto. Carried because only the sandbox can see it. Absent where there is no name to give.",
        ),
});
export type LandConflict = z.infer<typeof LandConflictSchema>;
// Land's outcome for the whole frozen repo composition. The ordinary mode preflights every repo before it
// writes any main tree: landed means all of them applied, and a conflict means none did. Every worktree keeps
// its state, nothing is lost, and "Land now" stays available. `resolving` is populated only by a `merge` land:
// the paths written into the workspace carrying conflict markers, which the user finishes by hand.
export const LandResultSchema = z.object({
    landed: z.boolean().describe("Whether the entire composed change was applied."),
    conflicts: z.array(LandConflictSchema).optional().describe("What stopped the whole composed change, grouped per repository."),
    resolving: z
        .array(
            z.object({
                repo: z.string().describe("Which repository."),
                paths: z.array(z.string()).describe("Which files now hold conflict markers to sort out by hand."),
            }),
        )
        .optional()
        .describe("Files left half-merged when you asked to carry the whole composition with its conflicts marked for resolution."),
    // A `measure` outcome with an outstanding delta: nothing was applied and nothing failed, the work is
    // waiting on the branch for a deliberate Land. `landed: false` alone can't say that (it means refusal).
    held: z
        .boolean()
        .optional()
        .describe(
            "Nothing was applied and nothing failed: there is work waiting on the branch for a deliberate merge. Not merged on its own cannot say that, because on its own it means refused.",
        ),
});
export type LandResult = z.infer<typeof LandResultSchema>;
/* Land's input. `check` is the safe default: every repo is preflighted and the composition is applied only if
 * ALL of it applies, so a refusal leaves every main tree byte-identical. `merge` is the escape hatch the
 * conflict report offers, a three-way apply that carries the whole composition and leaves conflicted paths
 * with markers to resolve in place. It is opt-in because it writes those markers. `measure` is the
 * auto-land-off mode: everything a land does EXCEPT touching the main trees, the provenance commit onto
 * agent/<id>, the cumulative diffstat, and the bookkeeping for work that reached main by another road, so a
 * held agent's card stays current while its composed delta waits for a deliberate Land. */
export const LandModeSchema = z.enum(["check", "merge", "measure"]);
export type LandMode = z.infer<typeof LandModeSchema>;
/* WHICH RUNG OF AN AGENT'S HISTORY A READING, or a land. STARTS AT.
 *
 *   outstanding, only what has not landed yet, measured from the last landed tip. The default, and what a
 *                 land carries: a second land applies only what the agent has done since the first.
 *   cumulative , the agent's WHOLE output, from where its branch left the main line. What the review lists
 *                 (landed work stays inspectable), and what "Land again" applies.
 *
 * A CUMULATIVE LAND IS NOT A DOUBLE APPLICATION. It is the way back when a land's work was discarded from the
 * workspace: the outstanding span is empty then, every sha says the work landed, because it did, so only a
 * reading from the base can still see the part that is missing. Paths the tree already holds drop out of it
 * per file, by the same reverse probe that keeps work which reached main by another road out of a conflict
 * report (land.ts, classifyDelta), so what actually applies is exactly what is gone. */
export const AgentSpanSchema = z.enum(["cumulative", "outstanding"]);
export type AgentSpan = z.infer<typeof AgentSpanSchema>;
/* LAND WHILE THE AGENT IS STILL WRITING, the user's deliberate override of the turn guard, and the only
 * input here that is about WHEN a land may run rather than what it carries.
 *
 * A land snapshots the agent's checkout, so mid-turn it can catch work half-done: one leg of a rename, three
 * files of a five-file change. The guard exists for that, and it stays the default. What makes the override
 * defensible rather than reckless is that neither half of the damage is permanent, a land arrives as
 * UNCOMMITTED changes the user reviews before committing, and the rest of the turn lands on top of it at
 * completion like any other incremental land. So a premature land is a mess the user can see and one the next
 * land repairs, which is a thing to warn about; it is not a thing to forbid.
 *
 * It does NOT cover a turn PARKED on a question or a permission card, nothing is being written there, so that
 * land needs no override and takes none (agents.routes.ts). This flag means "yes, mid-write, I know". */
export const AgentLandSchema = z.object({
    id: z.string().min(1).describe("Which conversation's work to merge."),
    mode: LandModeSchema.optional().describe(
        "How to apply it. The default applies every repository or none, so a refusal leaves the workspace exactly as it was. The other carries the whole composition and leaves conflicted paths with markers to resolve by hand.",
    ),
    span: AgentSpanSchema.optional().describe("How much of the work to take. Leave it out for everything not yet merged."),
    force: z.boolean().optional().describe("Go ahead despite a check that would otherwise refuse."),
});
