import { oc } from "@orpc/contract";
import { AgentTranscriptSchema } from "../events/transcript.js";
import {
    AgentArchiveSchema,
    AgentAutoLandSchema,
    AgentFileDiffQuerySchema,
    AgentIdSchema,
    AgentTranscriptQuerySchema,
    AgentIdsSchema,
    AgentLandSchema,
    AgentPlaceSchema,
    AgentRenameSchema,
    AgentResumeAfterLimitSchema,
    AgentMoveAfterLimitSchema,
    AgentResumeAfterOutageSchema,
    AgentsArchivedSchema,
    AgentSearchQuerySchema,
    AgentSearchResultSchema,
    AgentsMovedSchema,
    AgentsRemovedSchema,
    AgentSummarySchema,
    LandResultSchema,
} from "../schemas/agents.js";
import { AgentsListSchema } from "../schemas/automations.js";
import { AgentChangesSchema, AgentHistorySchema } from "../schemas/git.js";
import { FileDiffSchema } from "../schemas/history.js";
import { OkSchema } from "../schemas/shared.js";

// Every registered conversation-agent (AgentSummarySchema); an unknown {id} is NOT_FOUND across this whole family.
// `archive` is the non-destructive counterpart to `discard` (worktree committed, entry kept); `purge` is `discard`
// applied to every already-archived agent.
export const agentsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/agents",
            summary: "Every live conversation",
            description:
                "The fleet as the board draws it: each conversation with its title, what it is doing, when it last moved and whether anybody has read it since. Archived conversations are not in here.",
        })
        .output(AgentsListSchema),
    archived: oc
        .route({
            method: "GET",
            path: "/agents/archived",
            summary: "Conversations put away",
            description:
                "The same shape as the live fleet, for the conversations somebody has decided are finished. Their work is kept, and any one of them can be brought back.",
        })
        .output(AgentsListSchema),
    // Never-carded conversations (neither live nor archived) are `sessions.list`'s query, matching by the same rule.
    search: oc
        .route({
            method: "GET",
            path: "/agents/search",
            summary: "Find a conversation",
            description:
                "Searches the live fleet and the archive together. Both halves on purpose: the board hides finished work by design, and a filter that says it found nothing while the answer sits one click away is simply wrong.",
        })
        .input(AgentSearchQuerySchema)
        .output(AgentSearchResultSchema),
    get: oc
        .route({
            method: "GET",
            path: "/agents/{id}",
            summary: "One conversation's card",
            description: "Everything the board shows for a single conversation: its title, state, working branch, unread marker and timestamps.",
        })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    transcript: oc
        .route({
            method: "GET",
            path: "/agents/{id}/transcript",
            summary: "One page of a conversation",
            description:
                "The most recent turns of one conversation, in order, including the tool calls and their results: what the chat replays and the next turn is seeded from. A page, not the whole record — pass the answer's `from` back as `before` to walk further back, until `more` reads false.",
        })
        .input(AgentTranscriptQuerySchema)
        .output(AgentTranscriptSchema),
    // Also forgets the provider session, rewind-style, so the next fresh session reads the placed line as the agent's
    // own.
    place: oc
        .route({
            method: "POST",
            path: "/agents/{id}/place",
            summary: "Put words in the agent's mouth",
            description:
                "Writes a line into the record as though the agent had said it, with no turn behind it and no reply. Human readers see it marked as placed. The next real turn starts fresh from the record, where the line reads as the agent's own. Refused while a turn is running.",
        })
        .input(AgentPlaceSchema)
        .output(OkSchema),
    rename: oc
        .route({
            method: "POST",
            path: "/agents/{id}/rename",
            summary: "Retitle a conversation",
            description:
                "Sets the title a person chose, replacing the one that was generated. Allowed while the conversation is working, and it does not count as activity.",
        })
        .input(AgentRenameSchema)
        .output(AgentSummarySchema),
    autoLand: oc
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
    resumeAfterOutage: oc
        .route({
            method: "POST",
            path: "/agents/{id}/resume-after-outage",
            summary: "Whether this conversation retries after a provider outage",
            description:
                "Overrides the sandbox-wide setting for one conversation; clear it to follow the default again. This is what the offer shown when a turn dies writes, because the press happens inside one conversation and honestly means finish this piece of work.",
        })
        .input(AgentResumeAfterOutageSchema)
        .output(AgentSummarySchema),
    // Also offered on the card, not just chat: a limit reopens hours later, so the decider is usually at a board.
    resumeAfterLimit: oc
        .route({
            method: "POST",
            path: "/agents/{id}/resume-after-limit",
            summary: "Whether this conversation sends itself again when its allowance comes back",
            description:
                "Overrides the sandbox-wide setting for one conversation; clear it to follow the default again. Off unless asked for, because the allowance is the user's own budget and a turn that spends it the moment it reopens is not a decision to make on their behalf.",
        })
        .input(AgentResumeAfterLimitSchema)
        .output(AgentSummarySchema),
    // Moves the held turn the moment the refusal lands, not on the next attempt.
    moveAfterLimit: oc
        .route({
            method: "POST",
            path: "/agents/{id}/move-after-limit",
            summary: "Whether this conversation moves to another account when its allowance is spent",
            description:
                "Overrides the sandbox-wide setting for one conversation; clear it to follow the default again. A move spends a second account of the same provider on this conversation's behalf, so it is off unless asked for.",
        })
        .input(AgentMoveAfterLimitSchema)
        .output(AgentSummarySchema),
    seen: oc
        .route({
            method: "POST",
            path: "/agents/{id}/seen",
            summary: "Mark a conversation read",
            description:
                "Stamps the read marker behind the unread badge on one card. Allowed while the conversation is working, and reading never counts as activity.",
        })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    // A finer-grained ask (watch this, not that) goes through the chat, not a per-watch id here.
    stopWatching: oc
        .route({
            method: "POST",
            path: "/agents/{id}/stop-watching",
            summary: "Stop every condition watch a conversation is parked on",
            description:
                "Disarms all of this conversation's outside-condition watches, so none of them will wake it. All of them rather than one, because that is what the press means when it is made about a card. Nothing else about the conversation changes.",
        })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    seenAll: oc
        .route({
            method: "POST",
            path: "/agents/seen",
            summary: "Mark every conversation read",
            description: "Clears the unread badge across the whole fleet at once, and hands the refreshed list back.",
        })
        .output(AgentsListSchema),
    diff: oc
        .route({
            method: "GET",
            path: "/agents/{id}/diff",
            summary: "Everything a conversation has changed",
            description:
                "One flat set of changed files per repo, measured against where each repo stood when the conversation started, with every file flagged as already merged or not. Not the staged-and-unstaged shape a working copy has, because nobody ever checks this branch out to stage into it.",
        })
        .input(AgentIdSchema)
        .output(AgentChangesSchema),
    // Costs a `git log` per repo: ask only once `diff` reports something absorbed. Reading a file here reuses
    // `fileDiff`.
    history: oc
        .route({
            method: "GET",
            path: "/agents/{id}/history",
            summary: "Where a conversation's committed work lives",
            description:
                "The commits in your own history that carry this conversation's work, with the files each one brought. Use it when the change list is empty or short because you already committed what it wrote: those files are not differences against the main line any more, so they are not in the review, and this is where they went.",
        })
        .input(AgentIdSchema)
        .output(AgentHistorySchema),
    fileDiff: oc
        .route({
            method: "GET",
            path: "/agents/{id}/{repo}/file-diff",
            summary: "One file's before and after in a conversation's work",
            description: "Both sides of a single file: what it held when the conversation started and what it holds on its branch now.",
        })
        .input(AgentFileDiffQuerySchema)
        .output(FileDiffSchema),
    land: oc
        .route({
            method: "POST",
            path: "/agents/{id}/land",
            summary: "Merge a conversation's work into the workspace",
            description:
                "Brings the conversation's branches into the main tree, one repo at a time. A conflict is reported rather than raised and nothing is lost when it fails. Refused while a turn is running, and refused for a conversation that works directly in the shared tree, which has nothing to merge.",
        })
        .input(AgentLandSchema)
        .output(LandResultSchema),
    // Stamps `AgentSummarySchema.landRequested` with the caller's identity.
    requestLand: oc
        .route({
            method: "POST",
            path: "/agents/{id}/request-land",
            summary: "Ask a maintainer to merge this work",
            description:
                "For a collaborator who is not allowed to merge: marks the conversation as waiting for review, with who asked. The request shows on every maintainer's board and clears when somebody merges or discards it.",
        })
        .input(AgentIdSchema)
        .output(AgentSummarySchema),
    discard: oc
        .route({
            method: "POST",
            path: "/agents/{id}/discard",
            summary: "Throw a conversation's work away",
            description:
                "Deletes the conversation's working copies, its branches and its entry. Nothing is kept. Refused while a turn is running, and refused for a conversation working in the shared tree.",
        })
        .input(AgentIdSchema)
        .output(OkSchema),
    archive: oc
        .route({
            method: "POST",
            path: "/agents/archive",
            summary: "Put conversations away",
            description:
                "The gentle counterpart to discarding. Commits whatever the conversation still has in progress onto its own branch, releases its working copy, and keeps the entry and the record. It leaves the live fleet and joins the archive. Refused for a conversation that is running.",
        })
        .input(AgentArchiveSchema)
        .output(AgentsArchivedSchema),
    unarchive: oc
        .route({
            method: "POST",
            path: "/agents/unarchive",
            summary: "Bring conversations back",
            description:
                "Returns archived conversations to the live fleet. The next turn picks up a fresh working copy from the branch that was kept.",
        })
        .input(AgentIdsSchema)
        .output(AgentsMovedSchema),
    purge: oc
        .route({
            method: "POST",
            path: "/agents/purge",
            summary: "Empty the archive for good",
            description:
                "Discards every conversation already in the archive: working copies, branches and entries. The whole archive rather than a chosen few, because the archive is the pile somebody has already decided is over. A teardown that fails on one conversation leaves that one behind instead of taking the rest down with it.",
        })
        .output(AgentsRemovedSchema),
};
