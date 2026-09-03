import { oc } from "@orpc/contract";
import { AgentTranscriptSchema } from "../events.js";
import {
    AgentArchiveSchema,
    AgentAutoLandSchema,
    AgentFileDiffQuerySchema,
    AgentIdSchema,
    AgentIdsSchema,
    AgentLandSchema,
    AgentPlaceSchema,
    AgentRenameSchema,
    AgentResumeAfterLimitSchema,
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

// The fleet: every registered conversation-agent (see AgentSummarySchema). Registry-level actions (read,
// rename, seen, archive) apply uniformly. For branch-backed conversations, `diff` is the worktree's CUMULATIVE
// multi-repo delta vs its recorded per-repo bases, one flat change set per repo
// (AgentChanges), each file flagged `landed` or not, deliberately not the working tree's staged/unstaged
// shape: a worktree the user never checks out has no index they could stage into. `land` merges the worktree
// branches into the main tree (per-repo, conflicts reported, nothing lost on failure); `discard` removes
// worktrees + branches + registry entry. Those branch actions reject workspace conversations explicitly. An
// unknown {id} is NOT_FOUND; land/discard while the turn runs is CONFLICT.
// `rename` sets the user-chosen display title, legal mid-turn (it touches no worktree state).
// `seen`/`seenAll` stamp the read marker behind the cards' unread badge (AgentSummarySchema.seenAt), also
// legal mid-turn, and like `rename` they never bump `updatedAt` (reading is not activity).
//
// ARCHIVE is the non-destructive counterpart to discard, and the one the board leans on: for an isolated
// conversation, `archive` commits whatever the worktree still holds onto agent/<id> and drops the CHECKOUT;
// for a workspace conversation it has no git teardown. Both keep the entry and transcript. `list` stops carrying it and
// `archived` does; `unarchive` puts it back, and either way the next turn re-attaches a worktree from the
// surviving branch. Archiving a running agent is CONFLICT, same as land/discard.
//
// PURGE empties the archive, and it is `discard` applied to every agent already in there: worktree remnants,
// branches and entries all go. Deliberately the whole archive and not a list of ids, the archive is the pile
// of agents the user has already decided are over, so "clean it up" is one act with one confirmation, and a
// per-id purge would be `discard`, which already exists. Never touches a running agent (a turn un-archives its
// own agent, so there should be none) and answers with what it actually deleted: a teardown that fails on one
// agent's repo leaves that one behind rather than taking the batch down with it.
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
    // The board's filter. Answers over BOTH halves of the fleet, the live roster and the archive, because
    // the board hides by design (the Finished lane windows to a handful, archived agents are off the roster
    // entirely), and a filter that reports "no matches" while the agent sits one click away is a lie. The
    // never-carded conversations that are neither are `sessions.list`'s query, which matches by the same rule.
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
            summary: "The full conversation record",
            description:
                "Every message in one conversation, in order, including the tool calls and their results. This is the record the chat replays and the next turn is seeded from.",
        })
        .input(AgentIdSchema)
        .output(AgentTranscriptSchema),
    /* SPEAK AS THE AGENT, append the user's words to the conversation's record as an assistant row, with no
     * turn behind them and no reply. The row is marked `placed` for human readers (TranscriptRowSchema); the
     * provider session is FORGOTTEN in the same breath, rewind-style, so the next real turn opens a fresh
     * runtime session seeded from the record, where the placed line reads as the agent's own words, because
     * the handoff renders every assistant row identically. A running turn is CONFLICT: the illusion can only be
     * established between turns, and a concurrent turn would resume the very session this exists to retire. */
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
    // This agent's own land-at-completion posture, an override of the sandbox-wide `autoLand` setting; null
    // clears it back to "inherit". Legal mid-turn on purpose: the setting is read at turn COMPLETION, so
    // flipping it while the agent works is exactly "hold THIS turn's work for review", the press that matters.
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
    /* THIS conversation's answer to a provider outage, an override of the sandbox-wide `resumeAfterOutage`
     * setting; null clears it back to "inherit". The chat's offer at the moment a turn dies writes this and
     * never the global: the press happens inside one conversation and means "finish this piece of work", so
     * its honest scope is that conversation. Sandbox > Agent owns the default for everything else.
     *
     * Legal mid-turn, and unlike autoLand it is legal for a WORKSPACE conversation too, an outage kills a
     * main-tree chat exactly as readily as an isolated one, and there is no branch involved either way. */
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
    /* THIS conversation's answer to a spent allowance, the same override in the same shape as the outage one
     * above; null clears it back to "inherit". Offered on the CARD as well as in the chat, which is the one
     * placement difference worth stating: an outage is over in minutes and is met by whoever is in the room,
     * while a limit reopens hours later, so the person deciding is usually looking at a board rather than at a
     * transcript.
     *
     * Legal mid-turn, and for a workspace conversation, for the same two reasons its neighbour is. */
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
    /* DISARM EVERY CONDITION WATCH THIS CONVERSATION IS PARKED ON (AgentSummary.watches), the way off the one
     * standing arrangement an agent can enter into on the user's behalf without being asked again.
     *
     * ALL OF THEM, NOT ONE. The id of an individual watch is on the card, but the press a person makes about a
     * card means "stop this conversation waking itself up", and picking watches off a submenu one at a time is a
     * chore invented by the data shape rather than wanted by anybody. A conversation that should go on watching
     * one thing and not another can be told so in the chat, which is where the watches were armed.
     *
     * No wake fires for what this disarms, which is the whole point: a watch left armed keeps a hosted machine
     * awake and eventually starts a turn nobody is expecting. Nothing else about the conversation moves, so the
     * card it hands back differs only by having lost its watches. */
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
    // The other side of `diff`: the work that is no longer a difference because it is in your own history, and
    // the commits holding it. Asked for only once `diff` reports something absorbed, since it costs a `git log`
    // per repo and answers nothing until then. Reading one of these files is the SAME call as reading a
    // reviewable one (`fileDiff` below): the question "what did this conversation do to this file" has one
    // answer whether or not you have since committed it.
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
    // A collaborator's ask for the land they may not perform themselves (role floors put `land`/`discard` at
    // maintainer). Stamps AgentSummarySchema.landRequested with the caller's identity and re-frames the fleet,
    // so every maintainer's board carries the request; the land or discard that answers it clears the stamp.
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
