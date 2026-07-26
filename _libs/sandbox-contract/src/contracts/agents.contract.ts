import { oc } from "@orpc/contract";
import {
    AgentChangesSchema,
    AgentFileDiffQuerySchema,
    AgentIdSchema,
    AgentRenameSchema,
    AgentsListSchema,
    AgentSummarySchema,
    FileDiffSchema,
    LandResultSchema,
    OkSchema,
} from "../schemas.js";

// The fleet: every registered conversation-agent (see AgentSummarySchema). `diff` is the conversation
// worktree's CUMULATIVE multi-repo delta vs its recorded per-repo bases — one flat change set per repo
// (AgentChanges), each file flagged `landed` or not, deliberately not the working tree's staged/unstaged
// shape: a worktree the user never checks out has no index they could stage into. `land` merges the worktree
// branches into the main tree (per-repo, conflicts reported, nothing lost on failure); `discard` removes
// worktrees + branches + registry entry. An unknown {id} is NOT_FOUND; land/discard while the turn runs is CONFLICT.
// `rename` sets the user-chosen display title — legal mid-turn (it touches no worktree state).
export const agentsContract = {
    list: oc.route({ method: "GET", path: "/agents" }).output(AgentsListSchema),
    get: oc.route({ method: "GET", path: "/agents/{id}" }).input(AgentIdSchema).output(AgentSummarySchema),
    rename: oc.route({ method: "POST", path: "/agents/{id}/rename" }).input(AgentRenameSchema).output(AgentSummarySchema),
    diff: oc.route({ method: "GET", path: "/agents/{id}/diff" }).input(AgentIdSchema).output(AgentChangesSchema),
    fileDiff: oc.route({ method: "GET", path: "/agents/{id}/{repo}/file-diff" }).input(AgentFileDiffQuerySchema).output(FileDiffSchema),
    land: oc.route({ method: "POST", path: "/agents/{id}/land" }).input(AgentIdSchema).output(LandResultSchema),
    discard: oc.route({ method: "POST", path: "/agents/{id}/discard" }).input(AgentIdSchema).output(OkSchema),
};
