// agents: the conversation fleet
import { z } from "zod";
import { AgentHarnessSchema, AgentOriginSchema, AgentProviderSchema, ForkedFromSchema } from "./agent.js";
import { LoopStateSchema } from "./loops.js";
// A fleet agent is any conversation with a registry entry, keyed by conversationId. Isolated ones own a git worktree
// (branch agent/<id>); workspace conversations have none, but both share one status/activity/cost lifecycle.

// idle/running/awaiting: turn lifecycle (awaiting = paused on a plan or question)
// ready/landed/conflict: land-flow outcomes (ready = clean completion held on the branch, auto-land off)
// error: terminal turn failure
// interrupted: the daemon died under the turn (crash, OOM, rebuild); without it such a turn rehydrates as idle and its
// parked question disappears
// stopping/stopped: the two halves of a user's Stop, since a hard-cancel is not instant (`stopping` the moment the
// abort lands, `stopped` once the turn's generator has unwound)
// dismissing: the same window for waving away a parked question; settles in Finished rather than Attention, since
// nothing is left half-done
// `stopped` is its own value, never `error` (a deliberate stop is not a failure) or `interrupted` (which allows an
// automatic re-run)
// resuming: the turn was killed by something the daemon is already undoing (a credential re-mint, an outage backoff);
// never persisted, since a daemon restart forgets the resume and the turn's own last-written ending becomes true again
export const AgentStatusSchema = z.enum([
    "idle",
    "running",
    "awaiting",
    "stopping",
    "dismissing",
    "stopped",
    "resuming",
    "landing",
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
    // A missing capability (capabilities/capability-offer.ts); lets the lane say "setup needed" rather than a generic
    // pause.
    capability: z.boolean().describe("It needs something connected that is not connected yet."),
    // A gated credential parked on a named person's click; the one pause the board's reader may not be able to clear
    // themselves.
    credential: z
        .boolean()
        .describe("It is waiting for a named person to release a credential. The one pause that may not be yours to clear, whatever your role."),
    conflict: z.boolean().describe("Its work cannot be merged without somebody resolving a clash."),
});
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;
// What the last turn left open, measured at the moment it ended, unlike AgentAttentionSchema's live parked waits.
// Derived from finish frames every harness sends, never self-reported; absent for a turn that closed its list and
// passed its checks.
export const UnfinishedWorkSchema = z.object({
    // Epoch ms the turn ended; not `updatedAt`, which moves on a land or rename without the work moving.
    at: z.number().describe("When the turn that left this ended, in milliseconds."),
    // The agent's own checklist as of that turn's last word on it; `open`/`total` count items, `next` is the
    // in-progress or first pending one.
    steps: z
        .object({
            open: z.number().describe("Items on it that were never completed."),
            total: z.number().describe("Items on the whole list."),
            next: z.string().optional().describe("The one it would have done next: what it was working through, or the first still waiting."),
        })
        .optional()
        .describe("The agent's own checklist where that turn left it. Absent for a conversation that kept no list."),
    // Name of the `turn.ending` check still red when the turn ended, after its two repair rounds ran out.
    check: z.string().optional().describe("The end-of-turn check that was still failing when the turn ended, by name."),
});
export type UnfinishedWork = z.infer<typeof UnfinishedWorkSchema>;
// A landing's commit message: subject plus the two trailer sentences a changelog repo gets. One schema, not three
// duplicated fields, since both the live roster and the review carrier must read the same shape and can't disagree.
export const LandedMessageSchema = z.object({
    // Written from the landed diff, not the opening prompt: a session that drifts from its title still needs an
    // accurate subject.
    subject: z
        .string()
        .describe(
            "One line saying what the merged work did, read off the code rather than off the opening request. A conversation that asks for an audit and then spends four turns fixing what it found needs a subject about the fixes.",
        ),
    // Usually absent by design: the model omits it rather than inventing a note for an unremarkable change.
    note: z
        .string()
        .optional()
        .describe(
            "The same change said to somebody who uses the product, for a repository that keeps a changelog. Usually absent, because most changes are not ones a user would notice.",
        ),
    // Nearly always absent (removals only); required and mechanically guaranteed when a landing shrinks a wire-contract
    // lock.
    breaking: z
        .string()
        .optional()
        .describe("What this change takes away, for anything already relying on it. Nearly always absent: it is for removals, not for additions."),
});
export type LandedMessage = z.infer<typeof LandedMessageSchema>;
// One model's turn in the drafting walk (agent/role-model.ts tries connected models in order), in spend order:
// asking: in flight, `ms` absent
// answered: wrote the sentence, in `ms`
// refused: failed or declined, in `ms`, with `reason`
// skipped: not asked, since it refused recently and the walk stepped over it
export const LandedMessageStepSchema = z.object({
    provider: z.string().min(1).describe("Which provider was asked."),
    model: z.string().min(1).describe("Which of its models."),
    status: z
        .enum(["asking", "answered", "refused", "skipped"])
        .describe("How this one went. Skipped means it was not asked at all, because it refused a few minutes ago and the walk stepped over it."),
    // Epoch ms it started; client-measures an in-flight step's ticking display. Absent for `skipped`, which cost no
    // time.
    at: z.number().optional().describe("When it started being asked, in milliseconds. Absent for one that was skipped, which cost no time."),
    ms: z.number().optional().describe("How long it took. Absent while it is still being asked."),
    reason: z.string().optional().describe("Why it refused, in its own words."),
});
export type LandedMessageStep = z.infer<typeof LandedMessageStepSchema>;
// Full account of one landing's commit message being drafted: started, which models were asked, how each went, and how
// it ended. `outcome` absent means still running; `written` puts the sentence on the card, `failed` carries a one-line
// `reason`.
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
    id: z.string().describe("The conversation id, which is how every other call addresses it."),
    sessionId: z.string().optional().describe("The provider session behind the last turn. It is retired whenever the model or account changes."),
    title: z.string().optional().describe("What to call it: the first prompt cut to one line, unless somebody renamed it."),
    status: AgentStatusSchema.describe(
        "What it is doing. Stopping and stopped are the two halves of somebody pressing stop, because a cancel is not instant; dismissing is the same window for a question waved away, which ends the turn too but owes the user nothing; resuming means the sandbox is already putting right whatever killed the turn; landing means its work is being carried into the workspace right now, and nothing may act on its branch until that settles.",
    ),
    // Sentence the last turn died on; carried since `error` status alone isn't an answer, especially for an unwatched
    // run.
    failure: z
        .string()
        .optional()
        .describe(
            "Why the last turn failed, in the words it died on. Absent unless it did, and cleared the moment it runs again. Carried here because the word error on its own is not an answer, least of all for a run nobody was watching.",
        ),
    // The error frame's own code, so the board can distinguish e.g. a rate limit from a crash the way chat already
    // does.
    failureCode: z
        .string()
        .optional()
        .describe(
            "Which kind of failure it was, as the turn's own error frame coded it. Absent for a failure nothing could classify, which reads as the plain red line it is.",
        ),
    // Epoch seconds the spent allowance reopens; absent means genuinely unknown (Grok, Cursor) — never guess one.
    limitResetsAt: z.number().optional().describe("When the spent allowance reopens, in epoch seconds. Absent when the provider publishes no instant."),
    limitHeld: z.boolean().optional().describe("Whether the refused turn is held whole, so sending again re-runs it instead of appending to it."),
    // Whether the daemon has already booked a retry at the reset; the one thing that keeps a stranded card out of the
    // Attention lane.
    limitScheduled: z.boolean().optional().describe("Whether the held turn is already booked to go again at the reset, so nobody has to press anything."),
    // Account a booked move is sending the held turn to; set alongside `limitScheduled`, cleared by the move's own
    // turn.
    limitMoving: z.string().optional().describe("The account the held turn is being moved to by the owner's policy, while that move is booked."),
    provider: AgentProviderSchema.describe("Which model provider it runs on."),
    harness: AgentHarnessSchema.describe("Which agentic loop it runs on."),
    // Latched with the conversation, so the card can say where work runs without asking anything else.
    runner: z.string().optional().describe("The runner this conversation runs on. Absent means this sandbox."),
    // Per-conversation, so opening it restores its own choices rather than another tab's; `fast` here is what was asked
    // for, not what was served.
    model: z
        .string()
        .optional()
        .describe(
            "What its last turn ran with. Kept per conversation so opening it restores the choices made in it, rather than whatever some other tab last picked.",
        ),
    effort: z.string().optional().describe("How hard that turn was told to think."),
    thinking: z.boolean().optional().describe("Whether that turn showed its reasoning."),
    fast: z.boolean().optional().describe("Whether that turn asked for higher speed. What was asked for, not what was served."),
    // The judge's verdict on the last turn, not what actually ran: seeds tomorrow's composer preview, absent means
    // nothing judged yet.
    tier: z
        .enum(["fast", "standard"])
        .optional()
        .describe("How hard its last turn looked to the complexity judge. What the next turn's preview needs, not what actually ran."),
    // Standing per-conversation choice, restored into the composer on open and sent back every turn, like `fast` above.
    tierHold: z
        .boolean()
        .optional()
        .describe("Whether this conversation is pinned to the picked model, so a turn that looks simple is never moved to a cheaper one."),
    account: z.string().optional().describe("Which connected account paid for it."),
    // The worktree branch (agent/<id>); absent for a non-isolated (main-tree) conversation.
    branch: z.string().optional().describe("The branch its private copy works on. Absent for a conversation that works directly in the shared tree."),
    // Per-agent override of the sandbox-wide `autoLand`; absent means inherit, the common case that keeps the toggle
    // meaningful.
    autoLand: z
        .boolean()
        .optional()
        .describe(
            "This conversation's own answer to whether its work merges automatically. Absent means it follows the sandbox-wide setting, which is the common case.",
        ),
    // Per-conversation override, written by the in-chat retry press (not the settings toggle) so one late-night click
    // can't arm every agent; absent inherits the sandbox setting.
    resumeAfterOutage: z.boolean().optional(),
    // Off by default, unlike its neighbors: firing the moment a spent allowance reopens spends a window the user may be
    // saving.
    resumeAfterLimit: z.boolean().optional(),
    // Per-conversation override for moving a held turn to another account with room the moment it's refused; absent
    // inherits.
    moveAfterLimit: z.boolean().optional(),
    // A collaborator's ask to land (collaborators can't merge themselves); cleared by whichever merge or discard
    // answers it.
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
    // The card's provenance line when an outside message opened the conversation; absent means a person started it.
    origin: AgentOriginSchema.optional().describe(
        "Where the conversation came from when nobody typed it: a chat mention, a visitor's message, a webhook. Absent means a person started it.",
    ),
    // The other provenance line: who asked for the first turn directly (vs `origin`, which names the automation);
    // latched, never rewritten by a later turn.
    startedBy: z
        .string()
        .optional()
        .describe("Who asked for the first turn, as the sandbox verified it: a member's email, or token:<label> for a program's control token. Absent when nothing was verified (a wake, a loopback caller)."),
    // Recorded once on the fork's first turn and never cleared; rides the summary so the link survives closing and
    // reopening either tab.
    forkedFrom: ForkedFromSchema.optional().describe(
        "The conversation this one was cut from. Recorded once and never cleared: it is the relationship, not a pending state.",
    ),
    // Root repo's short base sha; per-repo bases stay daemon-internal.
    base: z.string().optional().describe("The commit its private copy started from, shortened."),
    costUsd: z.number().optional().describe("What it has cost so far, in dollars. A subagent's spend is its own and is not folded in here."),
    inputTokens: z.number().optional().describe("Tokens sent."),
    outputTokens: z.number().optional().describe("Tokens received."),
    contextTokens: z.number().optional().describe("How much of the window the conversation currently fills."),
    contextWindow: z.number().optional().describe("How large that window is."),
    activity: AgentActivitySchema.optional().describe("What it is doing at this moment."),
    // The whole drafting story (which models, how long, what refused), replacing a boolean that hid all of it;
    // runtime-only, forgotten on restart like the draft itself.
    landedMessageDraft: LandedMessageDraftSchema.optional().describe(
        "The whole story of this merge's commit message being written: which models were asked, how long each took, what refused and in what words. Forgotten on restart, which is right, because a restart also killed the drafting it describes.",
    ),
    // The finished sentence, on the same push that ends `landedMessageDraft` above so the promise and the answer arrive
    // together; absent until then, replaced wholesale by the next land.
    landedMessage: LandedMessageSchema.optional().describe(
        "What this conversation's merged work is called, once the drafting above has finished. It arrives on the same push that ends the draft, so the promise and the answer travel together.",
    ),
    startedAt: z.number().optional().describe("When the running turn started, in milliseconds. Absent when none is running."),
    updatedAt: z.number().describe("When it last did something, in milliseconds. Reading it does not count."),
    // Daemon-side, not browser-side: read state is a fact about the work, so clearing site data or switching devices
    // can't resurrect a badge.
    seenAt: z
        .number()
        .optional()
        .describe(
            "When somebody last opened it, in milliseconds. Newer activity than this is what makes it unread. Kept by the sandbox rather than by a browser, so clearing site data or picking up a phone does not resurrect every badge.",
        ),
    attention: AgentAttentionSchema.describe("Which kinds of waiting-for-you it is doing."),
    // Beside `attention` since a reader asks both at a glance, but opposite in shape: a turn gone, not one still parked
    // and waiting.
    unfinished: UnfinishedWorkSchema.optional().describe(
        "What its last turn left open: steps it never completed, a check still failing. Absent for a turn that finished what it started.",
    ),
    // Completed turns and lifetime tool calls, the card's msgs/tools counters.
    turns: z.number().optional().describe("Turns it has finished."),
    toolUses: z.number().optional().describe("Tools it has used, over its whole life."),
    // `running` reads the live subagent registry (swept after five minutes), `total` counts on the agent's own entry; a
    // child's spend is its own, never folded into the parent's cost.
    subagents: z
        .object({
            running: z.number().describe("Subagents working right now."),
            total: z.number().describe("Subagents it has started over its whole life."),
        })
        .optional()
        .describe(
            "Subagents and child agents this one delegated to. Absent means it never has, which is most conversations. Their spend is their own and is not folded into this conversation's cost.",
        ),
    // Cumulative output across every repo (base → branch tip), refreshed on each land; independent of what has actually
    // landed.
    diff: z
        .object({
            files: z.number().describe("Files touched."),
            insertions: z.number().describe("Lines added."),
            deletions: z.number().describe("Lines removed."),
        })
        .optional()
        .describe("Everything it has written, measured from where it started. Independent of how much has been merged."),
    // How much of what this agent landed is still in the working tree, since a discard after landing is invisible to
    // commit-based readings; absent is the steady state and carries no line.
    landedPresence: z
        .object({
            landed: z.number().describe("Paths this conversation merged in."),
            present: z.number().describe("How many of them are still there, either pending or committed."),
        })
        .optional()
        .describe(
            "Present only when some of what it merged has since been thrown away. Absent is the steady state: its presence is the signal, so an ordinary card spends no line on it.",
        ),
    // The loop driving this conversation, projected here rather than fetched separately, since a looping agent's status
    // and spend are already the card's own.
    loop: z
        .object({
            state: LoopStateSchema.describe("How the loop is going."),
            iteration: z.number().int().min(0).describe("Which round it is on."),
            maxIterations: z.number().int().min(1).describe("How many rounds it will attempt before giving up."),
            goal: z.string().describe("What it is looping towards."),
        })
        .optional()
        .describe("The loop driving this conversation, if one is. Absent for an ordinary conversation, which is nearly all of them."),
    // Which workflow run and step this conversation is; projected so a multi-step run reads as one job, not unrelated
    // cards started minutes apart.
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
    // Outside conditions a conversation is parked on; a finished-looking card can restart itself when one fires, and an
    // armed watch keeps a hosted machine (and its bill) awake. The check command itself never rides the wire, since it
    // may hold a secret.
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
    // Epoch ms it was archived; nothing is lost (branch, transcript, counters stay), and unarchiving re-attaches a
    // fresh worktree from the branch.
    archivedAt: z
        .number()
        .optional()
        .describe(
            "When it was put away, in milliseconds. Nothing was lost: its branch, its record and every counter stayed, and bringing it back gives it a fresh working copy. Absent means it is live on the board.",
        ),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
// One armed watch as a card carries it; derived from AgentSummarySchema.watches so the two shapes can't drift apart.
export type AgentWatch = NonNullable<AgentSummary["watches"]>[number];
// AgentsListSchema is declared later, after AutomationApprovalSchema, since the fleet list carries held wakes and zod
// needs that type declared first.
export const AgentIdSchema = z.object({ id: z.string().min(1).describe("Which conversation.") });

// Pages a transcript: a read returns its most recent turns and where they start (`from`); handing that back as `before`
// asks for the page above. A stale cursor (a rewind, a fork) is clamped, never refused.
export const AgentTranscriptQuerySchema = AgentIdSchema.extend({
    before: z.coerce
        .number()
        .int()
        .optional()
        .describe("Return the messages before this position in the record: the `from` of the page below. Absent asks for the most recent turns."),
    turns: z.coerce.number().int().min(1).max(200).optional().describe("How many of the user's turns to return, newest first. Absent takes the daemon's default."),
});
// Absent `ids` archives every archivable finished agent (the lane's "Clear"); unarchive always names its own ids.
export const AgentArchiveSchema = z.object({
    ids: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe("Which conversations to put away. Leave it out for every finished one that can be archived right now."),
});
export const AgentIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500).describe("Which conversations.") });
// What actually moved, not the roster afterward: two archives finishing at once would otherwise let a slower snapshot
// resurrect what a faster one just filed away. Whole summaries, since the receiving surfaces (archive list, detail
// page) have to show them, not just their ids.
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
// Also reports what a release could not do (a deleted repo, a locked checkout); those agents stay on the board with the
// reason they failed, rather than the caller reading silence as "nothing to archive".
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
// Ids, not summaries: a purged agent no longer exists anywhere, so there's nothing to show. No revision either, since
// archived agents are already off the broadcast roster.
export const AgentsRemovedSchema = z.object({
    removed: z
        .array(z.string())
        .describe(
            "Which conversations were deleted, as ids. Ids rather than whole cards, because these no longer exist anywhere: there is nothing left to show and nothing to put back.",
        ),
});
export type AgentsRemoved = z.infer<typeof AgentsRemovedSchema>;
// Searches only speech, both sides of the conversation, never thinking, tool output or protocol text, which would
// otherwise match nearly the whole board. Two-char minimum; `caseSensitive` off means case-insensitive, matching
// workspace search's own switch.
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
// Why a row survived the filter: the matched line, windowed, and who said it. `speaker` rides with the text since agent
// prose alone can read as something the user typed.
export const SpeakerSchema = z.enum(["user", "agent"]);
export type Speaker = z.infer<typeof SpeakerSchema>;
export const MatchSnippetSchema = z.object({
    text: z.string().describe("The matching line, with a little either side of it."),
    speaker: SpeakerSchema.describe(
        "Who said it. Carried with the words rather than beside them, because a line of the agent's prose under a card reads as something you typed until the row says otherwise.",
    ),
});
export type MatchSnippet = z.infer<typeof MatchSnippetSchema>;
// One matching agent and its evidence; `snippet` is absent for a title match, which the card already shows.
export const AgentMatchSchema = z.object({
    id: z.string().describe("Which conversation matched."),
    snippet: MatchSnippetSchema.optional().describe(
        "Why, in its own words. Absent when the title was the match, which the card already shows: repeating it underneath is noise where evidence was wanted.",
    ),
});
export type AgentMatch = z.infer<typeof AgentMatchSchema>;
// How many agents were actually read, so the board can say a search saw less than the whole fleet.
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
// The user-chosen display title, bounded like sanitizeTitle's own cap.
export const AgentRenameSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    title: z.string().trim().min(1).max(80).describe("What to call it from now on."),
});
// Bounded just above the handoff's per-message render cap, so a line too long to carry whole doesn't reach the agent
// truncated.
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
// `null` clears the override back to inheriting the sandbox setting, so an agent doesn't hold a frozen copy that stops
// following it.
export const AgentAutoLandSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    autoLand: z
        .boolean()
        .nullable()
        .describe(
            "Whether its work merges automatically when a turn finishes. Null clears the override and goes back to following the sandbox-wide setting, so a conversation does not sit holding a frozen copy of a default it has quietly stopped following.",
        ),
});
// Same `null`-clears-the-override shape as autoLand, for this conversation's own outage-resume posture.
export const AgentResumeAfterOutageSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    resumeAfterOutage: z
        .boolean()
        .nullable()
        .describe("Whether it retries by itself when the model provider was what failed. Null clears the override back to the sandbox-wide setting."),
});
// Same three-state override, for the limit blocker; written by the card's own offer when a limit strands a turn.
export const AgentResumeAfterLimitSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    resumeAfterLimit: z
        .boolean()
        .nullable()
        .describe(
            "Whether the turn a spent allowance refused is sent again by itself once the window reopens. Null clears the override back to the sandbox-wide setting.",
        ),
});
// Same three-state override, for moving a held turn to another account with room.
export const AgentMoveAfterLimitSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    moveAfterLimit: z
        .boolean()
        .nullable()
        .describe(
            "Whether the turn a spent allowance refused is moved to another connected account of the same provider that has room, as soon as the refusal lands. Null clears the override back to the sandbox-wide setting.",
        ),
});
export const AgentFileDiffQuerySchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    repo: z.string().min(1).describe("Which repository."),
    path: z.string().min(1).describe("Which file, relative to that repository."),
});
// Why a path would not land:
// workspace: your own uncommitted edits are on that path
// diverged: the main tree's committed content moved under the agent since it branched; nothing of yours is at risk
// binary: git cannot three-way merge the file at all
export const LandConflictReasonSchema = z.enum(["workspace", "diverged", "binary"]);
export type LandConflictReason = z.infer<typeof LandConflictReasonSchema>;
export const LandConflictPathSchema = z.object({
    path: z.string().describe("Which file."),
    reason: LandConflictReasonSchema.describe(
        "Why it would not merge, and the three have nothing in common but the symptom. Your own uncommitted edits on that path, where yours is the copy at risk. The shared tree having moved under the conversation since it started, where nothing of yours is at risk. Or a file git cannot merge at all, where no automatic answer exists.",
    ),
});
// `paths` are files that genuinely failed to apply, not the whole delta; empty `paths` with `clean: 0` means the repo
// itself was unreachable.
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
    // The branch to rebase onto; carried since an isolated turn's worktree hides it from the agent's own view.
    mainBranch: z
        .string()
        .optional()
        .describe(
            "The branch your own checkout is on, which is what the conversation has to rebase onto. Carried because only the sandbox can see it. Absent where there is no name to give.",
        ),
});
export type LandConflict = z.infer<typeof LandConflictSchema>;
// Land's outcome for the whole composed change: the ordinary mode preflights every repo, all-or-nothing, so a refusal
// leaves the tree untouched. `resolving` only appears for a `merge` land, whose conflict markers the user finishes by
// hand.
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
    // A `measure` outcome with work still on the branch; `landed: false` alone can't say that, since alone it means
    // refusal.
    held: z
        .boolean()
        .optional()
        .describe(
            "Nothing was applied and nothing failed: there is work waiting on the branch for a deliberate merge. Not merged on its own cannot say that, because on its own it means refused.",
        ),
});
export type LandResult = z.infer<typeof LandResultSchema>;
// check: safe default, preflights every repo and applies only if all of it does, so a refusal leaves the tree
// byte-identical
// merge: opt-in escape hatch; three-way applies the whole composition, leaving conflict markers to resolve in place
// measure: does everything but touch the main trees, so a held agent's card stays current while its delta waits
export const LandModeSchema = z.enum(["check", "merge", "measure"]);
export type LandMode = z.infer<typeof LandModeSchema>;
// outstanding: only what hasn't landed yet, from the last landed tip (the default; what a second land applies)
// cumulative: the agent's whole output from where its branch left main; what the review lists and what "Land again"
// applies. Not a double application: it's the way back when landed work was discarded from the tree, since paths
// already there drop out per file.
export const AgentSpanSchema = z.enum(["cumulative", "outstanding"]);
export type AgentSpan = z.infer<typeof AgentSpanSchema>;
// Overrides the guard against landing mid-turn; safe since a land arrives as uncommitted changes the user reviews, and
// the rest of the turn lands on top of it later. Doesn't apply to a turn parked on a question, which needs no override
// at all.
export const AgentLandSchema = z.object({
    id: z.string().min(1).describe("Which conversation's work to merge."),
    mode: LandModeSchema.optional().describe(
        "How to apply it. The default applies every repository or none, so a refusal leaves the workspace exactly as it was. The other carries the whole composition and leaves conflicted paths with markers to resolve by hand.",
    ),
    span: AgentSpanSchema.optional().describe("How much of the work to take. Leave it out for everything not yet merged."),
    force: z.boolean().optional().describe("Go ahead despite a check that would otherwise refuse."),
});
