import { oc } from "@orpc/contract";
import { AgentTranscriptSchema } from "../events.js";
import {
    AgentArchiveSchema,
    AgentAutoLandSchema,
    AgentChangesSchema,
    AgentFileDiffQuerySchema,
    AgentIdSchema,
    AgentIdsSchema,
    AgentLandSchema,
    AgentPlaceSchema,
    AgentRenameSchema,
    AgentResumeAfterOutageSchema,
    AgentSearchQuerySchema,
    AgentSearchResultSchema,
    AgentsListSchema,
    AgentsMovedSchema,
    AgentsRemovedSchema,
    AgentSummarySchema,
    FileDiffSchema,
    LandResultSchema,
    OkSchema,
} from "../schemas.js";

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
    list: oc.route({ method: "GET", path: "/agents" }).output(AgentsListSchema),
    archived: oc.route({ method: "GET", path: "/agents/archived" }).output(AgentsListSchema),
    // The board's filter. Answers over BOTH halves of the fleet, the live roster and the archive, because
    // the board hides by design (the Finished lane windows to a handful, archived agents are off the roster
    // entirely), and a filter that reports "no matches" while the agent sits one click away is a lie. The
    // never-carded conversations that are neither are `sessions.list`'s query, which matches by the same rule.
    search: oc.route({ method: "GET", path: "/agents/search" }).input(AgentSearchQuerySchema).output(AgentSearchResultSchema),
    get: oc.route({ method: "GET", path: "/agents/{id}" }).input(AgentIdSchema).output(AgentSummarySchema),
    transcript: oc.route({ method: "GET", path: "/agents/{id}/transcript" }).input(AgentIdSchema).output(AgentTranscriptSchema),
    /* SPEAK AS THE AGENT, append the user's words to the conversation's record as an assistant row, with no
     * turn behind them and no reply. The row is marked `placed` for human readers (RestoredMessageSchema); the
     * provider session is FORGOTTEN in the same breath, rewind-style, so the next real turn opens a fresh
     * runtime session seeded from the record, where the placed line reads as the agent's own words, because
     * the handoff renders every assistant row identically. A running turn is CONFLICT: the illusion can only be
     * established between turns, and a concurrent turn would resume the very session this exists to retire. */
    place: oc.route({ method: "POST", path: "/agents/{id}/place" }).input(AgentPlaceSchema).output(OkSchema),
    rename: oc.route({ method: "POST", path: "/agents/{id}/rename" }).input(AgentRenameSchema).output(AgentSummarySchema),
    // This agent's own land-at-completion posture, an override of the sandbox-wide `autoLand` setting; null
    // clears it back to "inherit". Legal mid-turn on purpose: the setting is read at turn COMPLETION, so
    // flipping it while the agent works is exactly "hold THIS turn's work for review", the press that matters.
    autoLand: oc.route({ method: "POST", path: "/agents/{id}/auto-land" }).input(AgentAutoLandSchema).output(AgentSummarySchema),
    /* THIS conversation's answer to a provider outage, an override of the sandbox-wide `resumeAfterOutage`
     * setting; null clears it back to "inherit". The chat's offer at the moment a turn dies writes this and
     * never the global: the press happens inside one conversation and means "finish this piece of work", so
     * its honest scope is that conversation. Sandbox > Agent owns the default for everything else.
     *
     * Legal mid-turn, and unlike autoLand it is legal for a WORKSPACE conversation too, an outage kills a
     * main-tree chat exactly as readily as an isolated one, and there is no branch involved either way. */
    resumeAfterOutage: oc
        .route({ method: "POST", path: "/agents/{id}/resume-after-outage" })
        .input(AgentResumeAfterOutageSchema)
        .output(AgentSummarySchema),
    seen: oc.route({ method: "POST", path: "/agents/{id}/seen" }).input(AgentIdSchema).output(AgentSummarySchema),
    seenAll: oc.route({ method: "POST", path: "/agents/seen" }).output(AgentsListSchema),
    diff: oc.route({ method: "GET", path: "/agents/{id}/diff" }).input(AgentIdSchema).output(AgentChangesSchema),
    fileDiff: oc.route({ method: "GET", path: "/agents/{id}/{repo}/file-diff" }).input(AgentFileDiffQuerySchema).output(FileDiffSchema),
    land: oc.route({ method: "POST", path: "/agents/{id}/land" }).input(AgentLandSchema).output(LandResultSchema),
    // A collaborator's ask for the land they may not perform themselves (role floors put `land`/`discard` at
    // maintainer). Stamps AgentSummarySchema.landRequested with the caller's identity and re-frames the fleet,
    // so every maintainer's board carries the request; the land or discard that answers it clears the stamp.
    requestLand: oc.route({ method: "POST", path: "/agents/{id}/request-land" }).input(AgentIdSchema).output(AgentSummarySchema),
    discard: oc.route({ method: "POST", path: "/agents/{id}/discard" }).input(AgentIdSchema).output(OkSchema),
    archive: oc.route({ method: "POST", path: "/agents/archive" }).input(AgentArchiveSchema).output(AgentsMovedSchema),
    unarchive: oc.route({ method: "POST", path: "/agents/unarchive" }).input(AgentIdsSchema).output(AgentsMovedSchema),
    purge: oc.route({ method: "POST", path: "/agents/purge" }).output(AgentsRemovedSchema),
};
