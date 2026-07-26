import { agentsContract, type AgentChange, type AgentRepoChanges } from "@intentic/sandbox-contract";
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
        // The review shows the agent's CUMULATIVE output (`base` → worktree), so work stays inspectable after
        // it lands — which is the normal case, clean turn completions auto-landing within ms of finishing.
        // What landing changes is per-file: a second pass from `landedTip` names the remainder still waiting
        // for "Land now" (everything, when nothing has landed yet), and every other file is flagged `landed`.
        diff: i.diff.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            const repos: AgentRepoChanges[] = [];
            for (const { repo, base, landedTip } of entry.repos) {
                try {
                    const worktree = services.agentWorktrees.worktreeDir(entry.id, repo);
                    const changes = await services.git.changesAgainstBase(worktree, base);
                    if (changes.length === 0) {
                        continue;
                    }
                    const pending =
                        landedTip === undefined
                            ? new Set(changes.map((change) => change.path))
                            : new Set((await services.git.changesAgainstBase(worktree, landedTip)).map((change) => change.path));
                    // Object.assign, not a spread: `changes` is this call's own freshly-parsed array, so the
                    // flag goes onto the objects that are about to be serialized and nothing is copied.
                    const flagged = changes.map((change): AgentChange => Object.assign(change, { landed: !pending.has(change.path) }));
                    repos.push({ repo, branch: entry.branch, changes: flagged });
                } catch (error) {
                    // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
                    services.logger.warn({ err: error, repo, id: entry.id }, "agents diff: repo skipped");
                }
            }
            return { repos };
        }),
        // Against `base`, matching the list: one row means one question — "what did this agent do to this
        // file" — and its answer must not change the moment the work lands. (Diffing from `landedTip` would
        // silently empty out every already-landed row.)
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
            return services.git.fileDiff(dir, input.path, composed.base);
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
