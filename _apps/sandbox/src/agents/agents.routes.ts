import { agentsContract, type AgentChange, type AgentRepoChanges, type GitChange } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { PersistedAgent } from "./agents-store.js";
import { archivable, archiveAgents } from "./archive.js";
import { landAgent } from "./land.js";

// The fleet routes: list/get the registry, review a conversation worktree's delta vs its recorded bases
// (the same GitChanges shape the Changes panel renders), land it into the main tree, archive it off the board,
// or discard it. An unknown {id} is NOT_FOUND; land/discard/archive while the conversation's turn is running
// is CONFLICT — the worktree is the turn's live working state.
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
        archived: i.archived.handler(() => ({ agents: services.agents.listArchived() })),
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
        // The read marker behind the card's unread badge. Daemon-side, so the badge stays cleared after a
        // browser cache wipe and clears on the other devices the moment one of them opens the agent.
        seen: i.seen.handler(async ({ input }) => {
            const summary = await services.agents.markSeen(input.id, Date.now());
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        seenAll: i.seenAll.handler(async () => {
            await services.agents.markAllSeen(Date.now());
            return { agents: services.agents.list() };
        }),
        // The review shows the agent's CUMULATIVE output (`base` → worktree), so work stays inspectable after
        // it lands — which is the normal case, clean turn completions auto-landing within ms of finishing.
        // What landing changes is per-file: a second pass from `landedTip` names the remainder still waiting
        // for "Land now" (everything, when nothing has landed yet), and every other file is flagged `landed`.
        diff: i.diff.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            const repos: AgentRepoChanges[] = [];
            // An ARCHIVED agent has no checkout, so its review reads the two refs out of the main repo instead
            // (the object store is shared, and archiving committed the worktree's remainder onto the branch —
            // so this is the same delta the worktree would have shown, not a lesser one).
            const archived = entry.archivedAt !== undefined;
            for (const { repo, base, landedTip } of entry.repos) {
                try {
                    const dir = archived ? services.agentWorktrees.mainDir(repo) : services.agentWorktrees.worktreeDir(entry.id, repo);
                    const against = (from: string): Promise<GitChange[]> =>
                        archived ? services.git.changesBetweenRefs(dir, from, entry.branch) : services.git.changesAgainstBase(dir, from);
                    const changes = await against(base);
                    if (changes.length === 0) {
                        continue;
                    }
                    const pending =
                        landedTip === undefined
                            ? new Set(changes.map((change) => change.path))
                            : new Set((await against(landedTip)).map((change) => change.path));
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
            // Archived: both sides are blobs, read from the main repo (see diff above). The path guard still
            // applies — it is validating the REQUEST, not the disk, and a `..` here would escape into rev-spec
            // territory just as readily.
            if (entry.archivedAt !== undefined) {
                const main = services.agentWorktrees.mainDir(input.repo);
                if (resolveWithin(main, input.path) === undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
                }
                return services.git.refFileDiff(main, input.path, composed.base, entry.branch);
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
            // Snapshotted before the land advances every landedTip — the span a chore diffs from, exactly as
            // the auto-land path captures it before its own land (see streamIsolatedTurn).
            const span = entry.repos.map(({ repo, base, landedTip }) => ({
                repo,
                from: landedTip ?? base,
                dir: services.agentWorktrees.worktreeDir(entry.id, repo),
            }));
            const result = await landAgent(services.agentWorktrees, entry);
            await services.agents.recordLanded(input.id, result.repos, result.diff);
            await services.agents.finish(input.id, Date.now(), result.landed ? "landed" : "conflict");
            if (result.landed && result.changed) {
                // The main tree changed under the user — same attribution convention as git.discard.
                services.history.notifyUserWrite();
                emitWorkspaceEvent(
                    services,
                    {
                        event: "agent.landed",
                        agentId: entry.id,
                        ...(entry.title !== undefined ? { title: entry.title } : {}),
                        branch: entry.branch,
                        outcome: "landed",
                        repos: span,
                    },
                    streamAgent,
                );
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
        // Named ids archive whatever the user pointed at (a card, or a bulk undo's inverse); no ids means
        // "clear the Finished lane" — every agent that is archivable RIGHT NOW, ignoring the retention clock.
        // Both routes answer with what MOVED and not with the roster afterwards: see AgentsMovedSchema — a
        // snapshot would let two overlapping requests undo each other's work in the browser.
        archive: i.archive.handler(async ({ input }) => {
            if (input.ids !== undefined) {
                for (const id of input.ids) {
                    entryOf(id);
                    notRunning(id);
                }
            }
            const targets =
                input.ids ??
                services.agents
                    .ids()
                    .map((id) => services.agents.entry(id))
                    .filter((entry) => entry !== undefined)
                    .filter((entry) => archivable(entry, services.agents.running(entry.id)))
                    .map((entry) => entry.id);
            const archived = await archiveAgents(services, targets, Date.now());
            // Read AFTER the archive, so each summary carries the archivedAt the card dates itself by.
            return { moved: archived.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined) };
        }),
        unarchive: i.unarchive.handler(async ({ input }) => {
            for (const id of input.ids) {
                entryOf(id);
            }
            // No worktree restore: the next turn's ensure() rebuilds the checkout from the branch, so putting a
            // card back is a registry write and nothing else.
            await services.agents.clearArchived(input.ids);
            return { moved: input.ids.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined) };
        }),
    };
};
