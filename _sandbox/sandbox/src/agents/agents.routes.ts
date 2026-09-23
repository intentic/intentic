import { rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import {
    agentsContract,
    type AgentChange,
    type AgentChanges,
    type AgentScratch,
    type AgentHistoryCommit,
    type AgentRepoChanges,
    type AgentRepoHistory,
    type AgentSummary,
    type ScratchPath,
    capabilitiesOf,
    type TurnEnding,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { withBaseText } from "../agent/prompt/prompt-disclosure.js";
import type { HeldTurn } from "../agent/run/turn/turn-resume.js";
import { opt } from "../opt.js";
import { cancelWatcher, cancelWatchersFor } from "../agent/verification/watchers.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { deliverToListenerChannel } from "../extensions/listener-deliver.js";
import { conversationLines, matchLines } from "../sessions/transcript-search.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { headSha } from "../git/changes/changes.js";
import { pruneEmptiedDirs } from "../git/changes/changes-index.js";
import { scratchScopeOf } from "../git/changes/scratch.js";
import { agentRepoReview, agentRepoModules, checkpointOf, presentInMain } from "./land/agent-changes.js";
import { commitsCarrying, historySpanStart } from "./land/landed-history.js";
import { type IsolatedAgent, isIsolated, type PersistedAgent, type RepoRecord } from "./registry/agents-store.js";
import { MAX_REACTION_KINDS } from "./registry/agents-registry.js";
import { archivable, archiveAgents, forgetConversations, purgeArchived } from "./registry/archive.js";
import { landAgent, outstandingConflicts } from "./land/land.js";
import { assignVerdict, fenceVerdict, isMemberAddress } from "./ownership.js";
import { provenanceOf, refuseUnlessVisible, visibleTo } from "../auth/fleet-scope.js";
import { syncBeforeLand } from "./land/sync.js";
import { verifyLandedTree } from "./land/verify-landed.js";
import { settleLandingInBackground } from "./land/version-landed.js";
import { routeLandBreakage } from "./land/land-breakage.js";

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
    // The same lookup for a route a guest may reach: theirs, or FORBIDDEN (auth/fleet-scope.ts).
    const entryFor = (id: string, context: OrpcContext): PersistedAgent => {
        const entry = entryOf(id);
        refuseUnlessVisible(context.identity, provenanceOf(entry));
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
        if (services.conversations.running(id)) {
            throw new ORPCError("CONFLICT", { message: "the agent's turn is running, wait for it to finish" });
        }
    };
    // The review's `scratch`: repos with none left out, and the field absent when no repo has any.
    const scratchField = (scratch: NonNullable<AgentChanges["scratch"]>): Pick<AgentChanges, "scratch"> => {
        const some = scratch.filter((repo) => repo.paths.length > 0);
        return some.length > 0 ? { scratch: some } : {};
    };
    // Scratch of a resting conversation's live copy, as it stands now and exactly as named: a list the review drew
    // earlier must not reach a file that has since stopped looking like scratch.
    const scratchNamed = async (input: AgentScratch): Promise<{ dir: string; named: ScratchPath[] }> => {
        const entry = isolatedEntryOf(input.id);
        notRunning(input.id);
        // Refused like a second land press, not queued behind the lease: a land reads this very index.
        if (services.conversations.landing(input.id)) {
            throw new ORPCError("CONFLICT", { message: "this agent is landing, wait for it to finish" });
        }
        if (!entry.placement.repos.some((composed) => composed.repo === input.repo)) {
            throw new ORPCError("NOT_FOUND", { message: "repo not in this agent's composition" });
        }
        if (!(await services.agentWorktrees.attached(entry.id, input.repo))) {
            throw new ORPCError("CONFLICT", { message: "this conversation's copy is gone, and its scratch went with it" });
        }
        const dir = services.agentWorktrees.worktreeDir(entry.id, input.repo);
        const scratch = await services.git.scratchOf(dir, await scratchScopeOf(input.repo, services.agentWorktrees.mainDir("root")));
        const named = scratch.filter((candidate) => input.paths.includes(candidate.path));
        const stale = input.paths.filter((path) => !named.some((candidate) => candidate.path === path));
        if (stale.length > 0) {
            throw new ORPCError("CONFLICT", { message: `no longer scratch: ${stale.join(", ")}` });
        }
        return { dir, named };
    };
    // Softer than notRunning: a land only reads the checkout, so it asks whether anyone is mid-sentence, not whether
    // the turn is alive. Parked on a question passes; genuine mid-write needs an explicit `force`.
    const landable = (id: string, force: boolean): void => {
        if (services.conversations.writing(id) && !force) {
            throw new ORPCError("CONFLICT", { message: "the agent is still writing, land again to apply its work as it stands" });
        }
    };
    // Recorded from the turn's `session` frame, not re-derived from where it ran: an isolated worktree is the workspace
    // root, so its path has no session. `sessionIdOf`, not `entry.sessionId`, flushed only at finish.
    const sdkSessionIdOf = (agent: Pick<PersistedAgent, "id" | "profile">): string | undefined =>
        capabilitiesOf(agent.profile.provider, agent.profile.harness).runtime === "claude-code" ? services.conversations.sessionIdOf(agent.id) : undefined;
    // Off the projected `get` status, never raw `entry.status`, which stays `interrupted` through a running turn. Adds
    // reasons stop/kill don't cover (a spent allowance, an outage); repair failures are excluded.
    // Whether the held turn ran, what each way of moving on costs, and where a policy is sending it.
    const heldEnding = (held: HeldTurn): NonNullable<TurnEnding["held"]> => ({
        ran: held.ran,
        ...(held.contextTokens !== undefined ? { contextTokens: held.contextTokens } : {}),
        ...(held.handoffTokens !== undefined ? { handoffTokens: held.handoffTokens } : {}),
        ...(held.move !== undefined ? { moving: held.move.account } : {}),
    });
    // The live hold, never a summary flag: a restart clears the hold, so only it backs a re-run rather than a message.
    const heldOn = (id: string): Pick<TurnEnding, "held"> => {
        const held = services.conversations.state(id)?.resume.held;
        return held === undefined ? {} : { held: heldEnding(held) };
    };
    const failureEnding = (id: string, summary: AgentSummary): TurnEnding | undefined => {
        if (summary.failureCode === "rate_limit") {
            return {
                reason: "limit",
                ...(summary.limitResetsAt !== undefined ? { resetsAt: summary.limitResetsAt } : {}),
                ...heldOn(id),
                ...(summary.limitScheduled === true ? { scheduled: true } : {}),
            };
        }
        if (summary.failureCode === "provider-outage") {
            return { reason: "outage" };
        }
        // A coded failure names something to repair first, so no offer beats a press that would only re-fail.
        // Uncoded is stopped work: nothing to repair, so the press just carries on.
        return summary.failureCode === undefined ? { reason: "stopped", ...heldOn(id) } : undefined;
    };
    const endingOf = (id: string): TurnEnding | undefined => {
        const summary = services.agents.get(id);
        if (summary === undefined) {
            return undefined;
        }
        if (summary.status === "stopped" || summary.status === "interrupted") {
            return { reason: "stopped" };
        }
        // Reads the failure the card currently reports; a resumed, landed or overtaken turn has none (agents-registry).
        return summary.status === "error" ? failureEnding(id, summary) : undefined;
    };
    // The composition a manual land applies: the same pre-land rebase as auto-land, with `base` moved onto what each
    // repo now sits on. A git fault here lands on the old base instead of failing the land.
    const syncedComposition = async (entry: IsolatedAgent): Promise<RepoRecord[]> => {
        try {
            return [
                ...(await syncBeforeLand(
                    services.agentWorktrees,
                    { id: entry.id, title: entry.social.title?.text, repos: entry.placement.repos },
                    services.agents.recordWorktree,
                )),
            ];
        } catch (error) {
            services.logger.warn({ err: error, id: entry.id }, "agents: pre-land sync failed, landing on the old base");
            return [...entry.placement.repos];
        }
    };
    // What a land that reached the tree sets in motion: the commit-box chip's draft (not awaited), the user-write
    // attribution (same convention as git.discard), and the workspace event.
    const announceLanded = (entry: IsolatedAgent, span: readonly { repo: string; from: string; dir: string }[]): void => {
        settleLandingInBackground(services, entry.id);
        services.history.notifyUserWrite();
        services.events.publish("workspace", {
            event: "agent.landed",
            agentId: entry.id,
            ...opt("title", entry.social.title?.text),
            branch: entry.placement.branch,
            outcome: "landed",
            repos: [...span],
        });
    };
    // `i.router()`, not a plain object: typechecked against agentsContract, so a dropped handler fails the build.
    return i.router({
        // Revision the roster was taken at, so the browser can tell this apart from a racing /events snapshot
        // (AgentsListSchema). Refreshes standings first, which is what makes a roster read self-healing.
        list: i.list.handler(async ({ context }) => {
            await services.agents.refreshStandings();
            // Approvals ride along as `held`; approve/reject stay the automations routes' own verbs. A guest sees its
            // own conversations and no held wake: a wake is somebody else's automation.
            const caller = context.identity;
            const agents = services.agents.list().filter((agent) => visibleTo(caller, agent));
            const held = caller?.role === "guest" ? [] : await services.heldWakes.list();
            return { agents, rev: services.agents.revision(), held };
        }),
        // Off `list` by construction, pulled on demand since /events never carries it; newest-archived first
        // (registry.listArchived).
        archived: i.archived.handler(({ context }) => ({
            agents: services.agents.listArchived().filter((agent) => visibleTo(context.identity, agent)),
            rev: services.agents.revision(),
        })),
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
        get: i.get.handler(({ input, context }) => {
            const summary = services.agents.get(input.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            refuseUnlessVisible(context.identity, summary);
            return summary;
        }),
        // Root-scoped: the workspace root is the working dir every turn saw, so restored paths match what streamed.
        // Answers for every agent from the daemon's own record (sessions/transcript-record.ts), not only ones a harness
        // keeps a readable session store for. `sessionId` is a separate lookup: which session the client should resume.
        transcript: i.transcript.handler(async ({ input, context }) => {
            const agent = entryFor(input.id, context);
            const sessionId = sdkSessionIdOf(agent);
            // One page, newest turns first, walking back on each `before`, not the whole conversation every time.
            const { rows: messages, from, more } = await services.transcripts.page(agent, { ...opt("before", input.before), ...opt("turns", input.turns) });
            // Session/provider/account are the entry's own values, not the client's, which can disagree after a switch.
            return {
                ...(sessionId !== undefined
                    ? {
                          sessionId,
                          provider: agent.profile.provider,
                          harness: agent.profile.harness,
                          ...opt("account", agent.profile.account),
                      }
                    : {}),
                // How the last turn ended, so any tab opened later can offer the press the prior window kept to itself.
                ...opt("ending", endingOf(input.id)),
                messages,
                from,
                more,
            };
        }),
        // Fills in what `transcript` counted rather than carried. Off the record, so it answers for an archived
        // conversation too, unlike the subagent registry, which is an in-memory map.
        toolChildren: i.toolChildren.handler(async ({ input }) => ({ children: await services.transcripts.toolChildren(entryOf(input.id), input.toolId) })),
        // The turn's other half, which the transcript never carries. Absent for a conversation whose last turn predates
        // the record; the base's own text is filled in here rather than stored, since it belongs to the sandbox, not to
        // the conversation.
        systemPrompt: i.systemPrompt.handler(async ({ input, context }) => {
            entryFor(input.id, context);
            const recorded = await services.promptRecord.of(input.id);
            return recorded === undefined ? {} : { prompt: await withBaseText(recorded, services.workspace.root) };
        }),
        // Speaks as the agent: appends the user's words as an assistant row marked `placed` (human-only, never
        // agent-facing).
        // - clears the session so the next turn reseeds from the record instead of stale runtime memory
        // - runs under the rewind lease, not notRunning, so a resuming turn cannot race the clear
        // - a channel-origin conversation delivers outward before appending (a Visitor chat into the visitor's outbox,
        //   every other provider to its gateway); a failed delivery refuses the whole place
        place: i.place.handler(async ({ input }) => {
            const agent = entryOf(input.id);
            const origin = agent.identity.origin;
            const outcome = await services.conversations.withRewindLease(input.id, async () => {
                if (origin?.channelId !== undefined) {
                    let delivered: "delivered" | "no-gateway";
                    try {
                        delivered = await deliverToListenerChannel(services, origin, input.text);
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
                                ...opt("title", agent.social.title?.text),
                                origin,
                            })
                            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
                    }
                }
                await services.transcripts.append(agent, [{ role: "assistant", text: input.text, placed: true }]);
                await services.conversations.send(input.id, { kind: "session-cleared" }).settled;
                return true;
            });
            if (outcome === undefined) {
                throw new ORPCError("CONFLICT", { message: "the agent's turn is running, wait for it to finish" });
            }
            return { ok: true } as const;
        }),
        // Legal mid-turn: a title touches no worktree state, and the registry re-reads the entry at begin/finish.
        rename: i.rename.handler(async ({ input, context }) => {
            entryFor(input.id, context);
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
        // Uses `entryOf`, not `isolatedEntryOf`: every one of these walls hits a workspace chat too. The resume pass
        // re-polls often, so answering just after a dying turn answers for the very turn that bounced, and a limit's
        // window can be hours out, which is why the control also lives on the card and not only in an open transcript.
        // A NOT_FOUND covers both misses the registry can report: an unknown conversation, and an answer this ending
        // does not allow.
        breakPolicy: i.breakPolicy.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setBreakPolicy(input.id, input.ending, input.policy);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent, or an answer that ending cannot take" });
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
        // Changes hands. Legal in every state, like a reaction: it says who answers for the work, not anything about it.
        assign: i.assign.handler(async ({ input, context }) => {
            const entry = entryOf(input.id);
            if (context.identity === undefined) {
                throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to assign on behalf of" });
            }
            const verdict = assignVerdict(entry.social.owner, context.identity);
            if (verdict.kind === "forbidden") {
                throw new ORPCError("FORBIDDEN", { message: verdict.message });
            }
            const members = await services.members.list();
            if (!isMemberAddress(input.to, await services.ownerEmail(), members)) {
                throw new ORPCError("BAD_REQUEST", { message: `${input.to} is not a member of this sandbox` });
            }
            // The recipient's own fence, as the roster holds it; the sandbox owner is on no row and is unfenced.
            const fenced = fenceVerdict(entry.identity.areas, members.find((member) => member.email === input.to)?.areas, input.to);
            if (fenced.kind === "forbidden") {
                throw new ORPCError("FORBIDDEN", { message: fenced.message });
            }
            // A name is known only for the caller's own sign-in; a colleague named by address gets theirs from presence
            // on the board.
            const name = input.to === context.identity.email.toLowerCase() ? context.identity.name : undefined;
            const summary = await services.agents.assign(input.id, { email: input.to, ...opt("name", name) }, Date.now());
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // The one write in this family a viewer may make (auth/role-floor.ts): a mark says something about the people
        // reading the board, not about the work. Legal in every state — mid-turn, archived, conflicted — since it
        // touches none of it.
        react: i.react.handler(async ({ input, context }) => {
            const entry = entryFor(input.id, context);
            if (context.identity === undefined) {
                throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to attribute the reaction to" });
            }
            const kinds = new Set(entry.social.reactions.map((mark) => mark.emoji));
            if (input.on && !kinds.has(input.emoji) && kinds.size >= MAX_REACTION_KINDS) {
                throw new ORPCError("BAD_REQUEST", { message: `this conversation already carries ${MAX_REACTION_KINDS} different reactions` });
            }
            const summary = await services.agents.react(
                input.id,
                input.emoji,
                { email: context.identity.email, ...(context.identity.name !== undefined ? { name: context.identity.name } : {}) },
                input.on,
                Date.now(),
            );
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // Daemon-side read marker: the unread badge survives a browser cache wipe and clears on other devices too.
        seen: i.seen.handler(async ({ input, context }) => {
            entryFor(input.id, context);
            const summary = await services.agents.markSeen(input.id, Date.now());
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        seenAll: i.seenAll.handler(async ({ context }) => {
            const caller = context.identity;
            if (caller?.role === "guest") {
                // Only its own: "all" for a guest is the roster it can see.
                for (const agent of services.agents.list().filter((entry) => visibleTo(caller, entry))) {
                    await services.agents.markSeen(agent.id, Date.now());
                }
            } else {
                await services.agents.markAllSeen(Date.now());
            }
            return { agents: services.agents.list().filter((agent) => visibleTo(caller, agent)), rev: services.agents.revision() };
        }),
        // The only user-initiated way to end a watch; every other exit is automatic (it fires, times out, or a later
        // turn stops it). Legal in every state, including mid-turn, since a watch is a timer, not turn state.
        stopWatching: i.stopWatching.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            // Awaited: the disarm must reach the watch journal, or a recreate would restore it on boot. A named watch
            // is disarmed alone; an unknown name is already-gone, not an error, since it may have fired mid-press.
            await (input.watchId === undefined ? cancelWatchersFor(entry.id) : cancelWatcher(entry.id, input.watchId));
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
            const scratch: NonNullable<AgentChanges["scratch"]> = [];
            let absorbed = 0;
            for (const composed of entry.placement.repos) {
                try {
                    // Same reading agent-changes.ts uses for the land's totals, so the two cannot disagree.
                    const review = await agentRepoReview(services.agentWorktrees, entry, composed);
                    // Before the empty check: a conversation that wrote nothing but scratch still has something to show.
                    scratch.push({ repo: composed.repo, paths: review.scratch });
                    const { changes } = review;
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
                    repos.push({ repo: composed.repo, branch: entry.placement.branch, changes: flagged, modules });
                } catch (error) {
                    // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
                    services.logger.warn({ err: error, repo: composed.repo, id: entry.id }, "agents diff: repo skipped");
                }
            }
            // Re-derived, not replayed: the stored refusal is from land time, rows may since be committed. Served as stored
            // while a land holds one of its repos, since re-deriving would queue this read behind that land.
            const conflicts =
                entry.landing.conflicts === undefined
                    ? []
                    : entry.placement.repos.some(({ repo }) => services.agentWorktrees.repoBusy(repo))
                      ? entry.landing.conflicts
                      : await outstandingConflicts(services.agentWorktrees, entry);
            // Asked of the whole composition, not of the repos that produced rows: a conversation that did all its work
            // on a branch of its own leaves `agent/<id>` empty, which is the case with no row to hang this on.
            const elsewhere = await services.agentWorktrees.elsewhere(entry.id, entry.placement.repos);
            // Tells apart an agent that wrote nothing from one whose every file is committed (AgentChangesSchema).
            return {
                repos,
                absorbed,
                ...scratchField(scratch),
                ...(conflicts.length > 0 ? { conflicts } : {}),
                ...(elsewhere.length > 0 ? { elsewhere: elsewhere.map(({ repo, branch }) => ({ repo, ...(branch === undefined ? {} : { branch }) })) } : {}),
            };
        }),
        // Reads the same rows `diff` filtered out to absorbed, from the same pass over the tree, so the two routes
        // can't disagree. Span starts at the recorded `landedHead` when it still resolves, else the merge-base anchor.
        history: i.history.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            const repos: AgentRepoHistory[] = [];
            let unaccounted = 0;
            for (const composed of entry.placement.repos) {
                try {
                    const { changes } = await agentRepoReview(services.agentWorktrees, entry, composed);
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
                    const from = landed ?? (await checkpointOf(main, main, entry.placement.branch, undefined, composed.base));
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
            const composed = entry.placement.repos.find((repo) => repo.repo === input.repo);
            if (composed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "repo not in this agent's composition" });
            }
            const main = services.agentWorktrees.mainDir(input.repo);
            // Retired checkout: both sides are blobs from main, same seam as `diff`; the guard still runs.
            if (!(await services.agentWorktrees.attached(entry.id, input.repo))) {
                if (resolveWithin(main, input.path) === undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
                }
                const anchor = await checkpointOf(main, main, entry.placement.branch, undefined, composed.base);
                return services.git.refFileDiff(main, input.path, anchor, entry.placement.branch);
            }
            const dir = services.agentWorktrees.worktreeDir(entry.id, input.repo);
            if (resolveWithin(dir, input.path) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            return services.git.fileDiff(dir, input.path, await checkpointOf(dir, main, entry.placement.branch, undefined, composed.base));
        }),
        includeScratch: i.includeScratch.handler(async ({ input }) => {
            const { dir, named } = await scratchNamed(input);
            if (named.some((entry) => entry.reason === "checkout")) {
                throw new ORPCError("BAD_REQUEST", { message: "a checkout of its own cannot ride a merge; add it to the workspace as a repository" });
            }
            // Staged, not committed: the next capture commits it with the rest of the work.
            await services.git.stagePaths(
                dir,
                named.map((entry) => entry.path),
            );
            return { ok: true } as const;
        }),
        deleteScratch: i.deleteScratch.handler(async ({ input }) => {
            const { dir, named } = await scratchNamed(input);
            for (const entry of named) {
                await rm(join(dir, entry.path), { recursive: true, force: true });
            }
            await pruneEmptiedDirs(
                dir,
                named.map((entry) => entry.path.replace(/\/$/, "")),
            );
            return { ok: true } as const;
        }),
        // Manual land, the recovery path after a conflicted or aborted auto-land; same patch-apply mechanics.
        land: i.land.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            landable(input.id, input.force === true);
            // A second press while one is in flight would rebase the worktree the first is reading; the card already
            // reads `landing`, so a refusal is all it needs.
            if (services.conversations.landing(input.id)) {
                throw new ORPCError("CONFLICT", { message: "this agent is already landing, wait for it to finish" });
            }
            const mode = input.mode ?? "check";
            const rung = input.span ?? "outstanding";
            return services.conversations.withLandLease(input.id, async () => {
                const composition = await syncedComposition(entry);
                // Snapshotted after the sync: a rebase orphans the sha a stale span would name.
                const span = composition.map(({ repo, base, landedTip }) => ({
                    repo,
                    from: rung === "cumulative" ? base : (landedTip ?? base),
                    dir: services.agentWorktrees.worktreeDir(entry.id, repo),
                }));
                const result = await services.perf.track("agent.land", { id: entry.id, mode, span: rung }, () =>
                    landAgent(services.agentWorktrees, { ...entry, placement: { ...entry.placement, repos: composition } }, mode, rung),
                );
                // Stores the tips and conflict report, re-derives standing, and clears the prior ending without a turn.
                await services.agents.recordLanded(input.id, result);
                // Only on a resting agent: a running turn would have its mutex freed and its ending overwritten.
                if (!services.conversations.running(input.id)) {
                    await services.conversations.send(input.id, { kind: "settle" }).settled;
                }
                if (result.landed && result.changed) {
                    announceLanded(entry, span);
                    // The whole repository's check, the same one an auto-land queues; the Land button used to skip it, which
                    // is how a week of lands produced a dozen verdicts.
                    void verifyLandedTree(
                        services,
                        {
                            kind: "land",
                            agentId: entry.id,
                            ...opt("title", entry.social.title?.text),
                            branch: entry.placement.branch,
                            repos: [...span],
                        },
                        (breakage) => routeLandBreakage(services, breakage),
                    ).catch((error: unknown) => services.logger.warn({ err: error, id: entry.id }, "agents: land verify could not be queued"));
                }
                return {
                    landed: result.landed,
                    // Carried, not dropped: a press that found nothing on the branch is the one outcome the review can't
                    // see for itself, and it used to reach the button as plain success.
                    changed: result.changed,
                    ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
                    // A `merge` land's leftover-conflict paths; omitting it blanked the panel's finish-N-files strip.
                    ...(result.resolving !== undefined ? { resolving: result.resolving } : {}),
                    ...(result.held === true ? { held: true } : {}),
                };
            });
        }),
        discard: i.discard.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            notRunning(input.id);
            // Disarmed first, while the conversation exists: an outlived watch would target a removed id.
            await cancelWatchersFor(entry.id);
            // Resources before worktree: a running shell or dev server must not be mid-write in a tree being deleted.
            await services.reaper.reapConversation(entry.id, { force: true });
            await services.agentWorktrees.remove(entry.id, entry.placement.repos);
            await forgetConversations(services, [entry]);
            return { ok: true } as const;
        }),
        // Named ids archive what the user pointed at; no ids clears the whole Finished lane. Answers with what moved,
        // not the roster, so overlapping requests can't undo each other.
        archive: i.archive.handler(async ({ input, context }) => {
            if (input.ids !== undefined) {
                for (const id of input.ids) {
                    entryFor(id, context);
                    notRunning(id);
                }
            }
            // Re-probes standings, since 'archivable right now' isn't visible on the persisted entry (archive.ts). Only
            // for the bulk clear: a named archive's ids are already the user's own decision.
            const archivableNow = async (): Promise<string[]> => {
                await services.agents.refreshStandings();
                return services.agents
                    .list()
                    .filter((agent) => archivable(agent) && visibleTo(context.identity, agent))
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
        unarchive: i.unarchive.handler(async ({ input, context }) => {
            for (const id of input.ids) {
                entryFor(id, context);
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
