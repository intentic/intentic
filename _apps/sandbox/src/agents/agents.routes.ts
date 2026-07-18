import { agentsContract, type RepoChanges } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { PersistedAgent } from "./agents-store.js";
import { landAgent } from "./land.js";

// The fleet routes: list/get the registry, review a conversation worktree's delta vs its recorded bases
// (the same GitChanges shape the Changes panel renders), land it into the main tree, or discard it. An
// unknown {id} is NOT_FOUND; land/discard while the conversation's turn is running is CONFLICT — the
// worktree is the turn's live working state.
export const createAgentsRoutes = (services: Services) => {
    const i = implement(agentsContract).$context<OrpcContext>();
    const entryOf = (id: string): PersistedAgent => {
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
        }
        return entry;
    };
    const notRunning = (id: string): void => {
        if (services.agents.running(id)) {
            throw new ORPCError("CONFLICT", { message: "the agent's turn is running — wait for it to finish" });
        }
    };
    return {
        list: i.list.handler(() => ({ agents: services.agents.list() })),
        get: i.get.handler(({ input }) => {
            const summary = services.agents.get(input.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Legal mid-turn (no notRunning): a title touches no worktree state, and the registry re-reads the
        // entry at begin/finish, so the rename survives a running turn.
        rename: i.rename.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setTitle(input.id, input.title);
            if (summary === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "title is empty" });
            }
            return summary;
        }),
        // The review shows the NOT-YET-LANDED remainder (`landedTip ?? base` → worktree) — empty in steady
        // state, since clean turn completions auto-land; non-empty only after a conflict or an aborted turn.
        diff: i.diff.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            const repos: RepoChanges[] = [];
            for (const { repo, base, landedTip } of entry.repos) {
                try {
                    const changes = await services.git.changesAgainstBase(services.agentWorktrees.worktreeDir(entry.id, repo), landedTip ?? base);
                    if (changes.length > 0) {
                        repos.push({ repo, branch: entry.branch, changes });
                    }
                } catch (error) {
                    // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
                    services.logger.warn({ err: error, repo, id: entry.id }, "agents diff: repo skipped");
                }
            }
            return { repos };
        }),
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            const composed = entry.repos.find((repo) => repo.repo === input.repo);
            if (composed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "repo not in this agent's composition" });
            }
            const dir = services.agentWorktrees.worktreeDir(entry.id, input.repo);
            if (resolveWithin(dir, input.path) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            return services.git.fileDiff(dir, input.path, composed.landedTip ?? composed.base);
        }),
        // Manual land — the recovery path after a conflicted or aborted auto-land; same patch-apply mechanics.
        land: i.land.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            notRunning(input.id);
            const result = await landAgent(services.agentWorktrees, entry);
            await services.agents.recordLanded(input.id, result.repos, result.diff);
            await services.agents.finish(input.id, Date.now(), result.landed ? "landed" : "conflict");
            if (result.landed && result.changed) {
                // The main tree changed under the user — same attribution convention as git.discard.
                services.history.notifyUserWrite();
            }
            return { landed: result.landed, ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}) };
        }),
        discard: i.discard.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            notRunning(input.id);
            await services.agentWorktrees.remove(entry.id, entry.repos);
            await services.agents.remove(entry.id);
            return { ok: true } as const;
        }),
    };
};
