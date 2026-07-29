import { agentsContract, type AgentChange, type AgentRepoChanges, type GitChange, runsClaudeCode } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { matchPrompts } from "../sessions/prompt-index.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { PersistedAgent } from "./agents-store.js";
import { archivable, archiveAgents, purgeArchived } from "./archive.js";
import { anchorOf, landAgent } from "./land.js";

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
    const sdkSessionIdOf = (agent: Pick<PersistedAgent, "id" | "provider" | "harness">): Promise<string | undefined> =>
        runsClaudeCode(agent.provider, agent.harness)
            ? services.sessions.sessionIdForConversation(services.agentWorktrees.conversationDir(agent.id))
            : Promise.resolve(undefined);
    // i.router(), not a bare object literal: it is what makes the contract EXHAUSTIVE at compile time. A plain
    // literal is structurally fine while missing a route, so a handler deleted in passing (which is how
    // `archived` was lost — the router kept compiling and the archive door quietly stopped rendering) fails no
    // build and no test. The router builder types the shape against agentsContract, so the next one is a
    // typecheck error instead of a 404 the browser swallows.
    return i.router({
        /* Every roster read carries the revision it was taken at, so the browser can tell this answer apart
         * from the /events snapshots racing it — see AgentsListSchema.
         *
         * The refresh first is what makes a roster read SELF-HEALING. Every other trigger fires on something
         * the daemon did; a hand-merge in a terminal, a rebuild, a sibling agent's land absorbing the same
         * hunks all move the shas with nothing to hook. Loading the board is the moment the user is asking
         * about, so it is the honest place to re-ask git, and it also broadcasts — every other open surface
         * heals with it. */
        list: i.list.handler(async () => {
            await services.agents.refreshStandings();
            return { agents: services.agents.list(), rev: services.agents.revision() };
        }),
        // The archive's own roster — the other half of the fleet, off `list` by construction and pulled on
        // demand (the /events stream never carries it). Newest-archived first; see registry.listArchived.
        archived: i.archived.handler(() => ({ agents: services.agents.listArchived(), rev: services.agents.revision() })),
        /* The board's filter, and the popped-out rail's. Answers over BOTH halves of the fleet in one pass —
         * the live roster and the archive — because the board hides by design (its Finished lane windows to a
         * handful, archived agents are off the roster entirely), and a filter that reports "no matches" while
         * the agent sits one click away is a lie the user only catches once.
         *
         * Matches the TITLE (which is the sanitized first prompt) or any later prompt the user wrote — see
         * AgentSearchQuerySchema for why an agent's own replies and its tool output are excluded. A title match
         * carries no snippet: the card already shows it.
         *
         * A draft agent has no session and so no prompts, and never appears here — the browser matches those
         * against the title it holds locally, which is all a conversation with no turn yet has.
         */
        search: i.search.handler(async ({ input }) => {
            const needle = input.query.toLowerCase();
            const entries = [...services.agents.list(), ...services.agents.listArchived()];
            const matches = await Promise.all(
                entries.map(async (agent) => {
                    if (agent.title?.toLowerCase().includes(needle) === true) {
                        return { id: agent.id };
                    }
                    const sessionId = await sdkSessionIdOf(agent);
                    if (sessionId === undefined) {
                        return undefined;
                    }
                    const snippet = matchPrompts(
                        await services.sessions.prompts(services.agentWorktrees.conversationDir(agent.id), sessionId),
                        needle,
                    );
                    return snippet === undefined ? undefined : { id: agent.id, snippet };
                }),
            );
            return { matches: matches.filter((match) => match !== undefined), scanned: entries.length };
        }),
        get: i.get.handler(({ input }) => {
            const summary = services.agents.get(input.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        transcript: i.transcript.handler(async ({ input }) => {
            const agent = entryOf(input.id);
            if (!runsClaudeCode(agent.provider, agent.harness)) {
                return { messages: [] };
            }
            return (await services.sessions.readConversation(services.agentWorktrees.conversationDir(input.id))) ?? { messages: [] };
        }),
        // Legal mid-turn (no notRunning): a title touches no worktree state, and the registry re-reads the
        // entry at begin/finish, so the rename survives a running turn.
        rename: i.rename.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setTitle(input.id, input.title, "user");
            if (summary === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "title is empty" });
            }
            return summary;
        }),
        // Legal mid-turn too (no notRunning): the override is read at turn COMPLETION, so flipping it while
        // the agent works is exactly "hold THIS turn's work for review" — the press that matters most.
        autoLand: i.autoLand.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setAutoLand(input.id, input.autoLand);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
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
            return { agents: services.agents.list(), rev: services.agents.revision() };
        }),
        // The review shows the agent's CUMULATIVE output (anchor → worktree), so work stays inspectable after
        // it lands — which is the normal case, clean turn completions auto-landing within ms of finishing.
        // What landing changes is per-file: a second pass from `landedTip` names the remainder still waiting
        // for "Land now" (everything, when nothing has landed yet), and every other file is flagged `landed`.
        diff: i.diff.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            const repos: AgentRepoChanges[] = [];
            for (const { repo, base, landedTip } of entry.repos) {
                try {
                    // The checkout when it is on disk, the two refs out of the main repo when it is not —
                    // decided per repo, NOT by archivedAt: a restored agent keeps the marker clear while its
                    // checkout stays retired until the next turn re-attaches it, and reading the worktree path
                    // then reported a full branch as "no changes". The refs tell the same story either way
                    // (retiring committed the worktree's remainder onto the branch; the object store is shared).
                    const attached = await services.agentWorktrees.attached(entry.id, repo);
                    const mainDir = services.agentWorktrees.mainDir(repo);
                    const refDir = attached ? services.agentWorktrees.worktreeDir(entry.id, repo) : mainDir;
                    const against = (from: string): Promise<GitChange[]> =>
                        attached ? services.git.changesAgainstBase(refDir, from) : services.git.changesBetweenRefs(mainDir, from, entry.branch);
                    /* Measured from the anchor land itself uses (land.ts anchorOf), not the frozen
                     * creation-time base — a worktree that synced onto newer main commits otherwise reviews
                     * as having authored everything main gained in between: one agent's card showed a
                     * hundred files of other agents' landed work as its own. The cumulative pass drops the
                     * landedTip rung (landed work must stay inspectable); the pending pass keeps it, which
                     * is exactly the land's own incremental span. */
                    const changes = await against(await anchorOf(refDir, mainDir, entry.branch, undefined, base));
                    if (changes.length === 0) {
                        continue;
                    }
                    const pending =
                        landedTip === undefined
                            ? new Set(changes.map((change) => change.path))
                            : new Set((await against(await anchorOf(refDir, mainDir, entry.branch, landedTip, base))).map((change) => change.path));
                    // Object.assign, not a spread: `changes` is this call's own freshly-parsed array, so the
                    // flag goes onto the objects that are about to be serialized and nothing is copied.
                    const flagged = changes.map((change): AgentChange => Object.assign(change, { landed: !pending.has(change.path) }));
                    repos.push({ repo, branch: entry.branch, changes: flagged });
                } catch (error) {
                    // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
                    services.logger.warn({ err: error, repo, id: entry.id }, "agents diff: repo skipped");
                }
            }
            // The last land's refusal travels with the review it is about: the panel is opened FROM the
            // conflicted card, so it has to arrive already knowing what blocked and why (see AgentChangesSchema).
            return { repos, ...(entry.conflicts !== undefined ? { conflicts: entry.conflicts } : {}) };
        }),
        // Against the same cumulative anchor as the list above: one row means one question — "what did this
        // agent do to this file" — and its answer must not change the moment the work lands. (Diffing from
        // `landedTip` would silently empty out every already-landed row; diffing from the frozen base would
        // show other agents' synced-in work, disagreeing with the list.)
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            const composed = entry.repos.find((repo) => repo.repo === input.repo);
            if (composed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "repo not in this agent's composition" });
            }
            const main = services.agentWorktrees.mainDir(input.repo);
            // Retired checkout: both sides are blobs, read from the main repo — the same per-repo seam as
            // `diff` above. The path guard still applies — it is validating the REQUEST, not the disk, and a
            // `..` here would escape into rev-spec territory just as readily.
            if (!(await services.agentWorktrees.attached(entry.id, input.repo))) {
                if (resolveWithin(main, input.path) === undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
                }
                const anchor = await anchorOf(main, main, entry.branch, undefined, composed.base);
                return services.git.refFileDiff(main, input.path, anchor, entry.branch);
            }
            const dir = services.agentWorktrees.worktreeDir(entry.id, input.repo);
            if (resolveWithin(dir, input.path) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            return services.git.fileDiff(dir, input.path, await anchorOf(dir, main, entry.branch, undefined, composed.base));
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
            const result = await landAgent(services.agentWorktrees, entry, input.mode);
            // Both halves of what the card will show: recordLanded stores the tips and the conflict report,
            // and re-derives the standing from them. `finish` no longer carries a verdict — it clears how the
            // LAST TURN ended, which a deliberate land is the user moving past (an `error` card they chose to
            // land must not keep wearing the error), and takes no turn off the counter because none ran.
            await services.agents.recordLanded(input.id, result);
            await services.agents.finish(input.id, Date.now());
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
            return {
                landed: result.landed,
                ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
                // A `merge` land's report of the paths it left carrying conflict markers — dropping this is
                // how the panel's "Landed with N files to finish" strip went permanently dark.
                ...(result.resolving !== undefined ? { resolving: result.resolving } : {}),
                ...(result.held === true ? { held: true } : {}),
            };
        }),
        discard: i.discard.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            notRunning(input.id);
            await services.agentWorktrees.remove(entry.id, entry.repos);
            await services.agents.remove([entry.id]);
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
            // Over the roster, so "archivable right now" is decided by the same status the card is wearing —
            // including the derived half, which is invisible from the persisted entry (see archive.ts).
            await services.agents.refreshStandings();
            const targets = input.ids ?? services.agents.list().filter(archivable).map((agent) => agent.id);
            const archived = await archiveAgents(services, targets, Date.now());
            // Read AFTER the archive, so each summary carries the archivedAt the card dates itself by, and with
            // the revision that applied it — the browser holds these ids off the board until a roster at least
            // that new arrives, so an in-flight older snapshot can't put them back.
            return {
                moved: archived.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined),
                rev: services.agents.revision(),
            };
        }),
        unarchive: i.unarchive.handler(async ({ input }) => {
            for (const id of input.ids) {
                entryOf(id);
            }
            // No worktree restore: the next turn's ensure() rebuilds the checkout from the branch, so putting a
            // card back is a registry write and nothing else.
            await services.agents.clearArchived(input.ids);
            return {
                moved: input.ids.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined),
                rev: services.agents.revision(),
            };
        }),
        // The archive's own exit, and the destructive one: everything filed away is deleted outright, branches
        // included. Answers with the ids that actually went — a teardown that fails on one agent leaves that one
        // in the archive rather than failing the press (see purgeArchived).
        purge: i.purge.handler(async () => ({ removed: await purgeArchived(services) })),
    });
};
