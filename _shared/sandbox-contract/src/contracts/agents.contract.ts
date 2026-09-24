import { procedure } from "../protocol/route-meta.js";
import { AgentToolChildrenSchema, AgentTranscriptSchema } from "../events/transcript.js";
import {
    AgentAssignSchema,
    AgentAutoLandSchema,
    AgentBreakPolicySchema,
    AgentFileDiffQuerySchema,
    AgentIdSchema,
    AgentToolChildrenQuerySchema,
    AgentTranscriptQuerySchema,
    AgentIdsSchema,
    AgentLandSchema,
    AgentPlaceSchema,
    AgentReactSchema,
    AgentRenameSchema,
    AgentStopJobSchema,
    AgentStopWatchingSchema,
    AgentsArchivedSchema,
    AgentSearchQuerySchema,
    AgentSearchResultSchema,
    AgentsMovedSchema,
    AgentsRemovedSchema,
    AgentSummarySchema,
    LandResultSchema,
} from "../schemas/agents.js";
import { AgentsListSchema } from "../schemas/automations.js";
import { AgentChangesSchema, AgentConflictsSchema, AgentScratchSchema, AgentHistorySchema } from "../schemas/git/git.js";
import { FileDiffSchema } from "../schemas/history.js";
import { OkSchema } from "../schemas/shared.js";
import { AgentKeepWarmSchema } from "../schemas/keep-warm.js";
import { ConversationPromptSchema } from "../schemas/system-prompt.js";

// Every registered conversation-agent (AgentSummarySchema); an unknown {id} is NOT_FOUND across this whole family.
// `archive` is the non-destructive counterpart to `discard` (worktree committed, entry kept); `purge` is `discard`
// applied to every already-archived agent.
export const agentsContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/agents",
            summary: "Every live conversation",
            description:
                "The fleet as the board draws it: each conversation with its title, what it is doing, when it last moved and whether anybody has read it since. Archived conversations are not in here.",
        })
        .meta({ guest: true })
        .output(AgentsListSchema),
    archived: procedure
        .route({
            method: "GET",
            path: "/agents/archived",
            summary: "Conversations put away",
            description:
                "The same shape as the live fleet, for the conversations somebody has decided are finished. Their work is kept, and any one of them can be brought back.",
        })
        .meta({ guest: true })
        .output(AgentsListSchema),
    // Never-carded conversations (neither live nor archived) are `sessions.list`'s query, matching by the same rule.
    search: procedure
        .route({
            method: "GET",
            path: "/agents/search",
            summary: "Find a conversation",
            description:
                "Searches the live fleet and the archive together. Both halves on purpose: the board hides finished work by design, and a filter that says it found nothing while the answer sits one click away is simply wrong.",
        })
        .input(AgentSearchQuerySchema)
        .output(AgentSearchResultSchema),
    get: procedure
        .route({
            method: "GET",
            path: "/agents/{id}",
            summary: "One conversation's card",
            description: "Everything the board shows for a single conversation: its title, state, working branch, unread marker and timestamps.",
        })
        .meta({ guest: true })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    transcript: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/transcript",
            summary: "One page of a conversation",
            description:
                "The most recent turns of one conversation, in order, including the tool calls and their results: what the chat replays and the next turn is seeded from. A page, not the whole record — pass the answer's `from` back as `before` to walk further back, until `more` reads false.",
        })
        .meta({ guest: true })
        .input(AgentTranscriptQuerySchema)
        .output(AgentTranscriptSchema),
    systemPrompt: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/system-prompt",
            summary: "What this conversation is told before it is asked anything",
            description:
                "The system prompt the most recent turn of this conversation actually ran on: which base it was, and every piece the sandbox added to it — this product's guidance, the persona, the field notes, the workspace's own standing rules — each with the exact words the model received. None of this appears in the transcript, so this is the only way to read it.",
        })
        .input(AgentIdSchema)
        .output(ConversationPromptSchema),
    toolChildren: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/transcript/tools/{toolId}",
            summary: "One delegation's own calls",
            description:
                "The calls a delegated agent made under one tool card. A transcript page leaves them behind and reports their count as `nested`, since a settled delegation draws collapsed; this is what fills the card in when it is opened. Empty when the record no longer holds that call.",
        })
        .input(AgentToolChildrenQuerySchema)
        .output(AgentToolChildrenSchema),
    // Also forgets the provider session, rewind-style, so the next fresh session reads the placed line as the agent's
    // own.
    place: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/place",
            summary: "Put words in the agent's mouth",
            description:
                "Writes a line into the record as though the agent had said it, with no turn behind it and no reply. Human readers see it marked as placed. The next real turn starts fresh from the record, where the line reads as the agent's own. Refused while a turn is running.",
        })
        .input(AgentPlaceSchema)
        .output(OkSchema),
    rename: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/rename",
            summary: "Retitle a conversation",
            description:
                "Sets the title a person chose, replacing the one that was generated. Allowed while the conversation is working, and it does not count as activity.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(AgentRenameSchema)
        .output(AgentSummarySchema),
    autoLand: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/auto-land",
            summary: "Whether this conversation merges its work automatically",
            description:
                "Overrides the sandbox-wide setting for one conversation; clear it to go back to following the default. Deliberately allowed mid-turn, because the setting is read when the turn finishes, so flipping it while the agent works means exactly hold this piece of work for review.",
        })
        .input(AgentAutoLandSchema)
        .output(AgentSummarySchema),
    // Legal for a workspace conversation too (unlike autoLand): an outage kills a main-tree chat just as readily.
    // Also offered on the card, not just in chat: a limit reopens hours later, so the decider is usually at a board.
    breakPolicy: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/break-policy",
            summary: "What this conversation does when a turn stops before it finished",
            description:
                "One answer per ending — a spent usage limit, a provider outage, a turn that stopped short — overriding the sandbox-wide policy for one conversation; clear it to follow the default again. The answers are mutually exclusive by construction, so nothing here can arm two automations over the same wall. Every ending starts at `wait` unless asked otherwise, because a re-run spends the user's own allowance on a turn they sent once.",
        })
        .meta({ floor: "collaborator" })
        .input(AgentBreakPolicySchema)
        .output(AgentSummarySchema),
    // Legal for a workspace conversation too, and only between turns in effect: a turn starting ends the hold.
    keepWarm: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/keep-warm",
            summary: "Keep this conversation's prompt cache warm while it sits idle",
            description:
                "Re-reads the conversation's cached context shortly before the provider would drop it, until the time asked for, so picking it back up costs a cache read instead of re-sending everything. Each refresh is a forked, unsaved request that adds nothing to the conversation. Stops by itself when the time runs out, when a turn starts, when the account nears its limit, or when the prompt the next turn would send has changed. Refused for a conversation whose cache is already cold or that this sandbox cannot replay. Null stops it.",
        })
        .meta({ floor: "collaborator" })
        .input(AgentKeepWarmSchema)
        .output(AgentSummarySchema),
    seen: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/seen",
            summary: "Mark a conversation read",
            description:
                "Stamps the read marker behind the unread badge on one card. Allowed while the conversation is working, and reading never counts as activity.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    // A finer-grained ask (watch this, not that) goes through the chat, not a per-watch id here.
    stopWatching: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/stop-watching",
            summary: "Stop a conversation's condition watches",
            description:
                "Disarms this conversation's outside-condition watches, so they will not wake it. Named without a watch id it disarms all of them, because that is what the press means when it is made about a card; a press made about one watch's own row names that watch and leaves the rest armed. Nothing else about the conversation changes.",
        })
        .input(AgentStopWatchingSchema)
        .output(AgentSummarySchema),
    stopJob: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/stop-job",
            summary: "Stop one of a conversation's background jobs",
            description:
                "Ends a command this conversation left running: the server it handed over, or the build it is waiting on. The watch that would have woken the conversation on its exit is disarmed first, so stopping it wakes nothing. Stopping a job that already ended is not an error.",
        })
        .input(AgentStopJobSchema)
        .output(AgentSummarySchema),
    seenAll: procedure
        .route({
            method: "POST",
            path: "/agents/seen",
            summary: "Mark every conversation read",
            description: "Clears the unread badge across the whole fleet at once, and hands the refreshed list back.",
        })
        .meta({ floor: "collaborator", guest: true })
        .output(AgentsListSchema),
    diff: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/diff",
            summary: "Everything a conversation has changed",
            description:
                "One flat set of changed files per repo, measured against where each repo stood when the conversation started, with every file flagged as already merged or not. Not the staged-and-unstaged shape a working copy has, because nobody ever checks this branch out to stage into it.",
        })
        .input(AgentIdSchema)
        .output(AgentChangesSchema),
    // For a press that needs only the verdict (asking the agent to resolve), without waiting on the review's per-file
    // line counts, which on a branch of hundreds of files take tens of seconds.
    conflicts: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/conflicts",
            summary: "Why a conversation's last merge refused",
            description:
                "What still blocks the conversation's last refused merge, checked again against your workspace as it stands now. Returns the same `conflicts` the full change list carries, without the change list itself. Empty when nothing refused, or when what refused before has since stopped being in the way.",
        })
        .input(AgentIdSchema)
        .output(AgentConflictsSchema),
    // Costs a `git log` per repo: ask only once `diff` reports something absorbed. Reading a file here reuses
    // `fileDiff`.
    history: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/history",
            summary: "Where a conversation's committed work lives",
            description:
                "The commits in your own history that carry this conversation's work, with the files each one brought. Use it when the change list is empty or short because you already committed what it wrote: those files are not differences against the main line any more, so they are not in the review, and this is where they went.",
        })
        .input(AgentIdSchema)
        .output(AgentHistorySchema),
    fileDiff: procedure
        .route({
            method: "GET",
            path: "/agents/{id}/{repo}/file-diff",
            summary: "One file's before and after in a conversation's work",
            description: "Both sides of a single file: what it held when the conversation started and what it holds on its branch now.",
        })
        .input(AgentFileDiffQuerySchema)
        .output(FileDiffSchema),
    // Stages rather than commits: the next capture commits it like the rest of the work, with nothing to unwind if the
    // conversation's next turn moves it.
    includeScratch: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/scratch/include",
            summary: "Carry files set aside as scratch with a conversation's work",
            description:
                "Takes files the review lists as scratch and adds them to the conversation's work, so the next merge carries them like any other file. For the file that only looked like scratch. Refused for a checkout of its own, which no merge can carry, while a turn is running, and for a path that is not scratch right now.",
        })
        .input(AgentScratchSchema)
        .output(OkSchema),
    deleteScratch: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/scratch/delete",
            summary: "Delete a conversation's scratch",
            description:
                "Removes files the review lists as scratch from the conversation's copy. Nothing else is touched, and nothing of it was ever merged. Refused while a turn is running, and for a path that is not scratch right now.",
        })
        .input(AgentScratchSchema)
        .output(OkSchema),
    land: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/land",
            summary: "Merge a conversation's work into the workspace",
            description:
                "Brings the conversation's branches into the main tree, one repo at a time. A conflict is reported rather than raised and nothing is lost when it fails. Refused while a turn is running, and refused for a conversation that works directly in the shared tree, which has nothing to merge.",
        })
        // The irreversible press a program may hold, kept to its own rung apart from the work.
        .meta({ control: "land" })
        .input(AgentLandSchema)
        .output(LandResultSchema),
    // Stamps `AgentSummarySchema.landRequested` with the caller's identity.
    requestLand: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/request-land",
            summary: "Ask a maintainer to merge this work",
            description:
                "For a collaborator who is not allowed to merge: marks the conversation as waiting for review, with who asked. The request shows on every maintainer's board and clears when somebody merges or discards it.",
        })
        // A collaborator's landings are only requests.
        .meta({ floor: "collaborator" })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    // Sets `AgentSummarySchema.owner`. Who may: the current owner (handing over), a maintainer or the sandbox owner
    // (taking over), and anyone at the driving tier when nobody owns it yet (claiming).
    assign: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/assign",
            summary: "Make a member answerable for this conversation",
            description:
                "Hands a conversation to a member: its owner is who answers its questions and who a reviewer asks about its work. Its owner may hand it to anyone; a maintainer may reassign any conversation; one nobody owns may be claimed by anyone allowed to drive agents. Refused for an address that is not a member's. Nothing about the conversation's own work changes.",
        })
        // Changing hands is driving, not shipping; the route itself decides whose hands may do it.
        .meta({ floor: "collaborator" })
        .input(AgentAssignSchema)
        .output(AgentSummarySchema),
    // Floored at viewer, unlike every other write here: marking a conversation is expression, not operating authority.
    react: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/react",
            summary: "Mark a conversation with an emoji",
            description:
                "Puts your mark on a conversation, or takes it back. Everyone sharing the sandbox sees it, with who left it, which is what makes it worth more than a private bookmark. One mark per person per emoji; nothing about the conversation's own work changes.",
        })
        .meta({ floor: "viewer", guest: true })
        .input(AgentReactSchema)
        .output(AgentSummarySchema),
    discard: procedure
        .route({
            method: "POST",
            path: "/agents/{id}/discard",
            summary: "Throw a conversation's work away",
            description:
                "Deletes the conversation's working copies, its branches and its entry. Nothing is kept. Refused while a turn is running, and refused for a conversation working in the shared tree.",
        })
        .meta({ control: "land" })
        .input(AgentIdSchema)
        .output(OkSchema),
    archive: procedure
        .route({
            method: "POST",
            path: "/agents/archive",
            summary: "Put conversations away",
            description:
                "The gentle counterpart to discarding. Commits whatever the conversation still has in progress onto its own branch, releases its working copy, and keeps the entry and the record. Its scratch is not committed and goes with the copy. It leaves the live fleet and joins the archive. Refused for a conversation that is running.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(AgentIdsSchema)
        .output(AgentsArchivedSchema),
    unarchive: procedure
        .route({
            method: "POST",
            path: "/agents/unarchive",
            summary: "Bring conversations back",
            description:
                "Returns archived conversations to the live fleet. The next turn picks up a fresh working copy from the branch that was kept.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(AgentIdsSchema)
        .output(AgentsMovedSchema),
    purge: procedure
        .route({
            method: "POST",
            path: "/agents/purge",
            summary: "Empty the archive for good",
            description:
                "Discards every conversation already in the archive: working copies, branches and entries. The whole archive rather than a chosen few, because the archive is the pile somebody has already decided is over. A teardown that fails on one conversation leaves that one behind instead of taking the rest down with it.",
        })
        .meta({ control: "land" })
        .output(AgentsRemovedSchema),
};
