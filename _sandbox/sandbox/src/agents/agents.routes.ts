import { errorMessage } from "@intentic/base/errors";
import {
    agentsContract,
    type AgentChange,
    type AgentHistoryCommit,
    type AgentRepoChanges,
    type AgentRepoHistory,
    capabilitiesOf,
    type TurnEnding,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { opt } from "../agent/run/opt.js";
import { type LimitFailure, pendingLimitFailure } from "../agent/run/turn/turn-resume.js";
import { cancelWatchersFor } from "../agent/verification/watchers.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { deliverToListenerChannel } from "../extensions/listener-deliver.js";
import { conversationLines, matchLines } from "../sessions/transcript-search.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { headSha } from "../git/changes/changes.js";
import { agentRepoReview, agentRepoModules, anchorOf, presentInMain } from "./land/agent-changes.js";
import { commitsCarrying, historySpanStart } from "./land/landed-history.js";
import { type IsolatedAgent, isIsolated, type PersistedAgent } from "./registry/agents-store.js";
import { archivable, archiveAgents, purgeArchived } from "./registry/archive.js";
import { landAgent, outstandingConflicts } from "./land/land.js";
import { syncBeforeLand } from "./land/sync.js";
import { describeLandingInBackground } from "./land/landed-subject.js";

// Fleet routes: list/get the registry, review a worktree's delta against its recorded bases, land it, archive it, or
// discard it. Unknown id is NOT_FOUND; land/discard/archive on a running turn is CONFLICT.
export const createAgentsRoutes = (services: Services) => {
    const i = implement(agentsContract).$context<OrpcContext>();
    const entryOf = (id: string): PersistedAgent => {
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
        }
        return entry;
    };
    // Branch-only half of the registry, for routes that act on a worktree; a workspace conversation can't answer these,
    // so it's BAD_REQUEST, not NOT_FOUND.
    const isolatedEntryOf = (id: string): IsolatedAgent => {
        const entry = entryOf(id);
        if (!isIsolated(entry)) {
            throw new ORPCError("BAD_REQUEST", { message: "this conversation works in the shared workspace and has no isolated branch" });
        }
        return entry;
    };
    const notRunning = (id: string): void => {
        if (services.agents.running(id)) {
            throw new ORPCError("CONFLICT", { message: "the agent's turn is running, wait for it to finish" });
        }
    };
    // Softer than notRunning: a land only reads the checkout, so it asks whether anyone is mid-sentence, not whether
    // the turn is alive. Parked on a question passes; genuine mid-write needs an explicit `force`.
    const landable = (id: string, force: boolean): void => {
        if (services.agents.writing(id) && !force) {
            throw new ORPCError("CONFLICT", { message: "the agent is still writing, land again to apply its work as it stands" });
        }
    };
    // Recorded from the turn's `session` frame, not re-derived from where it ran: an isolated worktree is the workspace
    // root, so its path has no session. `sessionIdOf`, not `entry.sessionId`, flushed only at finish.
    const sdkSessionIdOf = (agent: Pick<PersistedAgent, "id" | "provider" | "harness">): string | undefined =>
        capabilitiesOf(agent.provider, agent.harness).runtime === "claude-code" ? services.agents.sessionIdOf(agent.id) : undefined;
    // Off the projected `get` status, never raw `entry.status`, which stays `interrupted` through a running turn. Adds
    // reasons stop/kill don't cover (a spent allowance, an outage); repair failures are excluded.
    // Whether the held turn ran, what each way of moving on costs, and where a policy is sending it.
    const heldEnding = (held: LimitFailure): NonNullable<TurnEnding["held"]> => ({
        ran: held.ran,
        ...(held.contextTokens !== undefined ? { contextTokens: held.contextTokens } : {}),
        ...(held.handoffTokens !== undefined ? { handoffTokens: held.handoffTokens } : {}),
        ...(held.move !== undefined ? { moving: held.move.account } : {}),
    });
    const endingOf = (id: string): TurnEnding | undefined => {
        const summary = services.agents.get(id);
        if (summary === undefined) {
            return undefined;
        }
        if (summary.status === "stopped" || summary.status === "interrupted") {
            return { reason: "stopped" };
        }
        // Reads the failure the card currently reports; a resumed, landed or overtaken turn has none (agents-registry).
        if (summary.status !== "error") {
            return undefined;
        }
        if (summary.failureCode === "rate_limit") {
            // Live hold, not the summary's `limitHeld` flag: a restart clears it, so only it backs a re-run.
            const held = pendingLimitFailure(id);
            return {
                reason: "limit",
                ...(summary.limitResetsAt !== undefined ? { resetsAt: summary.limitResetsAt } : {}),
                ...(held !== undefined ? { held: heldEnding(held) } : {}),
                ...(summary.limitScheduled === true ? { scheduled: true } : {}),
            };
        }
        if (summary.failureCode === "provider-outage") {
            return { reason: "outage" };
        }
        // Uncoded error is stopped work: nothing to repair, so `{ reason: "stopped" }` offers to just carry on.
        return summary.failureCode === undefined ? { reason: "stopped" } : undefined;
    };
    // `i.router()`, not a plain object: typechecked against agentsContract, so a dropped handler fails the build.
    return i.router({
        // Revision the roster was taken at, so the browser can tell this apart from a racing /events snapshot
        // (AgentsListSchema). Refreshes standings first, which is what makes a roster read self-healing.
        list: i.list.handler(async () => {
            await services.agents.refreshStandings();
            // Approvals ride along as `held`; approve/reject stay the automations routes' own verbs.
            return { agents: services.agents.list(), rev: services.agents.revision(), held: await services.heldWakes.list() };
        }),
        // Off `list` by construction, pulled on demand since /events never carries it; newest-archived first
        // (registry.listArchived).
        archived: i.archived.handler(() => ({ agents: services.agents.listArchived(), rev: services.agents.revision() })),
        // Answers over the live roster and the archive, since the board hides finished/archived agents from the live
        // list. Matches the title or either side's said lines; a title hit carries no snippet.
        search: i.search.handler(async ({ input }) => {
            // Folded once here so needle and haystack share a case; the index folds its side the same way.
            const caseSensitive = input.caseSensitive === true;
            const needle = caseSensitive ? input.query : input.query.toLowerCase();
            const entries = [...services.agents.list(), ...services.agents.listArchived()];
            // One query for the whole fleet, not a read per entry.
            const said = await services.saidIndex.search(input.query, "conversation", caseSensitive);
            const matches = entries.flatMap((agent) => {
                const title = caseSensitive ? agent.title : agent.title?.toLowerCase();
                if (title?.includes(needle) === true) {
                    return [{ id: agent.id }];
                }
                const indexed = said.get(agent.id);
                // Write-lag overlay: prompts routed but not settled stay searchable before the index catches up.
                const pending = matchLines(conversationLines(agent.id, []), needle, caseSensitive);
                // A recorded user line beats a just-sent prompt, beats the agent's; ties go to the older line.
                const snippet = indexed?.speaker === "user" ? indexed : pending?.speaker === "user" ? pending : (indexed ?? pending);
                return snippet === undefined ? [] : [{ id: agent.id, snippet }];
            });
            // `indexing`: true means the backfill hasn't indexed everything yet, so this result can still grow.
            return { matches, scanned: entries.length, indexing: services.saidIndex.indexing() };
        }),
        get: i.get.handler(({ input }) => {
            const summary = services.agents.get(input.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Root-scoped: the workspace root is the working dir every turn saw, so restored paths match what streamed.
        // Answers for every agent from the daemon's own record (sessions/transcript-record.ts), not only ones a harness
        // keeps a readable session store for. `sessionId` is a separate lookup: which session the client should resume.
        transcript: i.transcript.handler(async ({ input }) => {
            const agent = entryOf(input.id);
            const sessionId = sdkSessionIdOf(agent);
            // One page, newest turns first, walking back on each `before`, not the whole conversation every time.
            const { rows: messages, from, more } = await services.transcripts.page(agent, { ...opt("before", input.before), ...opt("turns", input.turns) });
            // Session/provider/account are the entry's own values, not the client's, which can disagree after a switch.
            return {
                ...(sessionId !== undefined
                    ? {
                          sessionId,
                          provider: agent.provider,
                          harness: agent.harness,
                          ...(agent.account !== undefined ? { account: agent.account } : {}),
                      }
                    : {}),
                // How the last turn ended, so any tab opened later can offer the press the prior window kept to itself.
                ...opt("ending", endingOf(input.id)),
                messages,
                from,
                more,
            };
        }),
        // Speaks as the agent: appends the user's words as an assistant row marked `placed` (human-only, never
        // agent-facing).
        // - clears the session so the next turn reseeds from the record instead of stale runtime memory
        // - runs under the rewind lease, not notRunning, so a resuming turn cannot race the clear
        // - a channel-origin conversation delivers to the provider's gateway before appending; a failed delivery
        //   refuses the whole place
        place: i.place.handler(async ({ input }) => {
            const agent = entryOf(input.id);
            const origin = agent.origin;
            const outcome = await services.agents.withRewindLease(input.id, async () => {
                if (origin?.channelId !== undefined) {
                    let delivered: "delivered" | "no-gateway";
                    try {
                        delivered = await deliverToListenerChannel(services, origin.provider, origin.channelId, input.text);
                    } catch (error) {
                        throw new ORPCError("BAD_GATEWAY", { message: errorMessage(error) });
                    }
                    if (delivered === "delivered") {
                        // Outbound trail: same row an agent's own send leaves, so the feed shows the channel got it.
                        void services.activity
                            .append({
                                provider: origin.provider,
                                direction: "out",
                                type: "message.send",
                                channelId: origin.channelId,
                                content: input.text,
                                conversationId: agent.id,
                                ...(agent.title !== undefined ? { title: agent.title } : {}),
                                origin,
                            })
                            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
                    }
                }
                await services.transcripts.append(agent, [{ role: "assistant", text: input.text, placed: true }]);
                await services.agents.clearSession(input.id);
                return true;
            });
            if (outcome === undefined) {
                throw new ORPCError("CONFLICT", { message: "the agent's turn is running, wait for it to finish" });
            }
            return { ok: true } as const;
        }),
        // Legal mid-turn: a title touches no worktree state, and the registry re-reads the entry at begin/finish.
        rename: i.rename.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setTitle(input.id, input.title, "user");
            if (summary === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "title is empty" });
            }
            return summary;
        }),
        // Legal mid-turn: the flag is read at completion, so flipping it mid-run holds this turn's work for review.
        autoLand: i.autoLand.handler(async ({ input }) => {
            isolatedEntryOf(input.id);
            const summary = await services.agents.setAutoLand(input.id, input.autoLand);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Uses `entryOf`, not `isolatedEntryOf`: an outage can hit a workspace chat too. The resume pass re-polls
        // often, so arming it just after a dying turn arms the very turn that bounced.
        resumeAfterOutage: i.resumeAfterOutage.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setResumeAfterOutage(input.id, input.resumeAfterOutage);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Uses `entryOf` for the same reason: a spent allowance can refuse a workspace chat too. The window this arms
        // can be hours out, which is why the offer lives on the card and not only in an open transcript.
        resumeAfterLimit: i.resumeAfterLimit.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setResumeAfterLimit(input.id, input.resumeAfterLimit);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Whether a spent allowance moves this conversation's held turn to another account with room
        // (SandboxSettingsSchema.moveAfterLimit).
        moveAfterLimit: i.moveAfterLimit.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setMoveAfterLimit(input.id, input.moveAfterLimit);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Isolated agents only, a workspace conversation has no land to ask for. Legal mid-turn, like `autoLand`; needs
        // a verified identity to attribute the request to.
        requestLand: i.requestLand.handler(async ({ input, context }) => {
            isolatedEntryOf(input.id);
            if (context.identity === undefined) {
                throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to attribute the request to" });
            }
            const summary = await services.agents.requestLand(
                input.id,
                { email: context.identity.email, ...(context.identity.name !== undefined ? { name: context.identity.name } : {}) },
                Date.now(),
            );
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Daemon-side read marker: the unread badge survives a browser cache wipe and clears on other devices too.
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
        // The only user-initiated way to end a watch; every other exit is automatic (it fires, times out, or a later
        // turn stops it). Legal in every state, including mid-turn, since a watch is a timer, not turn state.
        stopWatching: i.stopWatching.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            // Awaited: the disarm must reach the watch journal, or a recreate would restore it on boot.
            await cancelWatchersFor(entry.id);
            // Reads back through `get`, not the live roster: an archived conversation can still hold armed watches.
            const summary = services.agents.get(entry.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Measured against main as it stands, not the last land's record. A committed row leaves the list; uncommitted
        // stays flagged `landed`; discarded-after-land goes back to unflagged.
        diff: i.diff.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            const repos: AgentRepoChanges[] = [];
            let absorbed = 0;
            for (const composed of entry.repos) {
                try {
                    // Same reading agent-changes.ts uses for the land's totals, so the two cannot disagree.
                    const changes = await agentRepoReview(services.agentWorktrees, entry, composed);
                    if (changes.length === 0) {
                        continue;
                    }
                    const present = await presentInMain(
                        services.agentWorktrees,
                        entry,
                        composed,
                        changes.map((change) => change.path),
                    );
                    absorbed += present.absorbed.size;
                    // Object.assign, not a spread: `changes` is this call's own array, so nothing needs copying.
                    const flagged = changes
                        .filter((change) => !present.absorbed.has(change.path))
                        .map((change): AgentChange => Object.assign(change, { landed: present.inWorkspace.has(change.path) }));
                    if (flagged.length === 0) {
                        continue;
                    }
                    // Reads the worktree's own layout; /workspace/modules walks /work, missing a new package.
                    const modules = await agentRepoModules(services.agentWorktrees, entry, composed.repo);
                    repos.push({ repo: composed.repo, branch: entry.branch, changes: flagged, modules });
                } catch (error) {
                    // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
                    services.logger.warn({ err: error, repo: composed.repo, id: entry.id }, "agents diff: repo skipped");
                }
            }
            // Re-derived, not replayed: the stored refusal is from land time, rows may since be committed.
            const conflicts = entry.conflicts === undefined ? [] : await outstandingConflicts(services.agentWorktrees, entry);
            // Tells apart an agent that wrote nothing from one whose every file is committed (AgentChangesSchema).
            return { repos, absorbed, ...(conflicts.length > 0 ? { conflicts } : {}) };
        }),
        // Reads the same rows `diff` filtered out to absorbed, from the same pass over the tree, so the two routes
        // can't disagree. Span starts at the recorded `landedHead` when it still resolves, else the merge-base anchor.
        history: i.history.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            const repos: AgentRepoHistory[] = [];
            let unaccounted = 0;
            for (const composed of entry.repos) {
                try {
                    const changes = await agentRepoReview(services.agentWorktrees, entry, composed);
                    if (changes.length === 0) {
                        continue;
                    }
                    const present = await presentInMain(
                        services.agentWorktrees,
                        entry,
                        composed,
                        changes.map((change) => change.path),
                    );
                    // Nothing of this repo's work is in history yet; the common case, and free to check.
                    const absorbed = changes.filter((change) => present.absorbed.has(change.path));
                    if (absorbed.length === 0) {
                        continue;
                    }
                    const main = services.agentWorktrees.mainDir(composed.repo);
                    const head = await headSha(main);
                    if (head === undefined) {
                        unaccounted += absorbed.length;
                        continue;
                    }
                    // Anchor read only when the recorded head can't serve: rare, saves a merge-base spawn.
                    const landed = composed.landedHead === undefined ? undefined : await historySpanStart(main, composed.landedHead, head);
                    const from = landed ?? (await anchorOf(main, main, entry.branch, undefined, composed.base));
                    const byPath = new Map(absorbed.map((change) => [change.path, change]));
                    const commits: AgentHistoryCommit[] = [];
                    let placed = 0;
                    for (const commit of await commitsCarrying(
                        main,
                        from,
                        head,
                        absorbed.map((change) => change.path),
                    )) {
                        const rows = commit.paths.flatMap((path) => {
                            const row = byPath.get(path);
                            return row === undefined ? [] : [row];
                        });
                        if (rows.length === 0) {
                            continue;
                        }
                        placed += rows.length;
                        commits.push({
                            sha: commit.sha,
                            short: commit.short,
                            subject: commit.subject,
                            author: commit.author,
                            at: commit.at,
                            changes: rows,
                        });
                    }
                    // Absorbed but placed nowhere: reached main by a road other than a commit in this span.
                    unaccounted += absorbed.length - placed;
                    if (commits.length === 0) {
                        continue;
                    }
                    const modules = await agentRepoModules(services.agentWorktrees, entry, composed.repo);
                    repos.push({ repo: composed.repo, commits, modules });
                } catch (error) {
                    // One unreadable repo must not take down the others, same reasoning as the review above.
                    services.logger.warn({ err: error, repo: composed.repo, id: entry.id }, "agents history: repo skipped");
                }
            }
            return { repos, unaccounted };
        }),
        // Diffs from the same cumulative anchor as the list above, so a file can't drop out of its own row when it
        // lands, and another agent's synced-in work can't appear as this one's.
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            const composed = entry.repos.find((repo) => repo.repo === input.repo);
            if (composed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "repo not in this agent's composition" });
            }
            const main = services.agentWorktrees.mainDir(input.repo);
            // Retired checkout: both sides are blobs from main, same seam as `diff`; the guard still runs.
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
        // Manual land, the recovery path after a conflicted or aborted auto-land; same patch-apply mechanics.
        land: i.land.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            landable(input.id, input.force === true);
            // Span is snapshotted before the land advances `landedTip`, matching what auto-land captures.
            // Same pre-land rebase as auto-land; a git fault here lands on the old base instead of failing the land.
            let composition = entry.repos;
            try {
                composition = [...(await syncBeforeLand(services.agentWorktrees, entry, services.agents.recordWorktree))];
            } catch (error) {
                services.logger.warn({ err: error, id: entry.id }, "agents: pre-land sync failed, landing on the old base");
            }
            // Snapshotted after the sync: a rebase orphans the sha a stale span would name.
            const span = composition.map(({ repo, base, landedTip }) => ({
                repo,
                from: input.span === "cumulative" ? base : (landedTip ?? base),
                dir: services.agentWorktrees.worktreeDir(entry.id, repo),
            }));
            const result = await landAgent(services.agentWorktrees, { ...entry, repos: composition }, input.mode, input.span);
            // Stores the tips and conflict report, re-derives standing, and clears the prior ending without a turn.
            await services.agents.recordLanded(input.id, result);
            // Only on a resting agent: a running turn would have its mutex freed and its ending overwritten.
            if (!services.agents.running(input.id)) {
                await services.agents.finish(input.id, Date.now());
            }
            if (result.landed && result.changed) {
                // Drafted from the diff now sitting in the tree, for the Changes panel's commit-box chip; not awaited.
                describeLandingInBackground(services, entry.id);
                // Main tree changed under the user, same attribution convention as git.discard.
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
                // A `merge` land's leftover-conflict paths; omitting it blanked the panel's finish-N-files strip.
                ...(result.resolving !== undefined ? { resolving: result.resolving } : {}),
                ...(result.held === true ? { held: true } : {}),
            };
        }),
        discard: i.discard.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            notRunning(input.id);
            // Disarmed first, while the conversation exists: an outlived watch would target a removed id.
            await cancelWatchersFor(entry.id);
            // Resources before worktree: a running shell or dev server must not be mid-write in a tree being deleted.
            await services.reaper.reapConversation(entry.id, { force: true });
            await services.agentWorktrees.remove(entry.id, entry.repos);
            await services.agents.remove([entry.id]);
            return { ok: true } as const;
        }),
        // Named ids archive what the user pointed at; no ids clears the whole Finished lane. Answers with what moved,
        // not the roster, so overlapping requests can't undo each other.
        archive: i.archive.handler(async ({ input }) => {
            if (input.ids !== undefined) {
                for (const id of input.ids) {
                    entryOf(id);
                    notRunning(id);
                }
            }
            // Re-probes standings, since 'archivable right now' isn't visible on the persisted entry (archive.ts). Only
            // for the bulk clear: a named archive's ids are already the user's own decision.
            const archivableNow = async (): Promise<string[]> => {
                await services.agents.refreshStandings();
                return services.agents
                    .list()
                    .filter(archivable)
                    .map((agent) => agent.id);
            };
            const targets = input.ids ?? (await archivableNow());
            const { archived, failed } = await archiveAgents(services, targets, Date.now());
            // Read after the archive: summaries carry a fresh archivedAt and revision; a failed id is only reported.
            return {
                moved: archived.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined),
                failed,
                rev: services.agents.revision(),
            };
        }),
        unarchive: i.unarchive.handler(async ({ input }) => {
            for (const id of input.ids) {
                entryOf(id);
            }
            // No worktree restore: the next turn's ensure() rebuilds the checkout from the branch.
            await services.agents.clearArchived(input.ids);
            return {
                moved: input.ids.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined),
                rev: services.agents.revision(),
            };
        }),
        // Destructive: deletes everything filed away, branches included (purgeArchived). Archived run records go too,
        // since their steps must not point into an emptied archive.
        purge: i.purge.handler(async () => {
            // Same disarm-before-delete as `discard`: an outlived watch would try to start a turn on a removed id.
            for (const summary of services.agents.listArchived()) {
                await cancelWatchersFor(summary.id);
            }
            const removed = await purgeArchived(services);
            for (const run of (await services.workflowRuns.list()).filter((candidate) => candidate.archivedAt !== undefined)) {
                await services.workflowRuns.forget(run.runId);
            }
            return { removed };
        }),
    });
};
