import { errorMessage } from "@intentic/base/errors";
import { agentsContract, type AgentChange, type AgentRepoChanges, capabilitiesOf } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { cancelWatchersFor } from "../agent/watchers.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { deliverToListenerChannel } from "../extensions/listener-deliver.js";
import { conversationLines, matchLines } from "../sessions/transcript-search.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { agentRepoChanges, agentRepoModules, anchorOf } from "./agent-changes.js";
import { type IsolatedAgent, isIsolated, type PersistedAgent } from "./agents-store.js";
import { archivable, archiveAgents, purgeArchived } from "./archive.js";
import { landAgent, outstandingConflicts } from "./land.js";
import { syncBeforeLand } from "./sync.js";
import { describeLandingInBackground } from "./landed-subject.js";

// The fleet routes: list/get the registry, review a conversation worktree's delta vs its recorded bases
// (the same GitChanges shape the Changes panel renders), land it into the main tree, archive it off the board,
// or discard it. An unknown {id} is NOT_FOUND; land/discard/archive while the conversation's turn is running
// is CONFLICT, the worktree is the turn's live working state.
export const createAgentsRoutes = (services: Services) => {
    const i = implement(agentsContract).$context<OrpcContext>();
    const entryOf = (id: string): PersistedAgent => {
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
        }
        return entry;
    };
    // The branch-backed half of the registry, for the routes that act on a worktree. A workspace conversation is
    // a legitimate agent that simply cannot answer these, so it is BAD_REQUEST rather than NOT_FOUND.
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
    /* THE LAND GUARD, which is a softer thing than notRunning and deliberately so.
     *
     * Discard and archive take the whole worktree away, so a live turn rules them out flatly. A land only READS
     * that checkout and copies what it finds into the main tree, and the copy arrives as uncommitted changes
     * the user reviews, so the question is not "is a turn alive" but "is anyone mid-sentence".
     *
     * Two of the three answers let it through. A turn PARKED on a question or a permission card is writing
     * nothing, and refusing there was the sharpest form of the bug: the turn could only end once the user
     * answered, so "wait for it to finish" asked them to do the very thing they had come here instead of doing.
     * A turn genuinely mid-write is the one real hazard, half a rename, three files of five, and that is the
     * user's call to make with the facts in front of them, so it costs an explicit `force` rather than a
     * refusal. Both halves of that hazard are recoverable, which is why it is a warning and not a wall: the
     * land is uncommitted, and the remainder of the turn lands on top of it at completion.
     *
     * Unforced mid-write still answers CONFLICT, and the message says which of the two states it means, the
     * old one named the wrong one for a parked agent and sent people to wait on a turn that was waiting on
     * them. */
    const landable = (id: string, force: boolean): void => {
        if (services.agents.writing(id) && !force) {
            throw new ORPCError("CONFLICT", { message: "the agent is still writing, land again to apply its work as it stands" });
        }
    };
    /* Which SDK session holds this conversation's transcript, asked of the REGISTRY, which recorded it from
     * the turn's own `session` frame, never re-derived from where the turn happened to run. An isolated turn
     * runs in a mount namespace where its worktree IS the workspace root (agents/isolation.ts), so the SDK
     * files the session under the root's project key and the worktree path is not a project key at all.
     * Probing that directory answered "no session" for every isolated agent, and a card with no transcript
     * reads as a conversation that never happened.
     *
     * `sessionIdOf` and not `entry.sessionId`: the entry is only flushed with the id at finish, so a running
     * first turn, the one most likely to be opened, would otherwise have none. */
    const sdkSessionIdOf = (agent: Pick<PersistedAgent, "id" | "provider" | "harness">): string | undefined =>
        capabilitiesOf(agent.provider, agent.harness).runtime === "claude-code" ? services.agents.sessionIdOf(agent.id) : undefined;
    // i.router(), not a bare object literal: it is what makes the contract EXHAUSTIVE at compile time. A plain
    // literal is structurally fine while missing a route, so a handler deleted in passing (which is how
    // `archived` was lost, the router kept compiling and the archive door quietly stopped rendering) fails no
    // build and no test. The router builder types the shape against agentsContract, so the next one is a
    // typecheck error instead of a 404 the browser swallows.
    return i.router({
        /* Every roster read carries the revision it was taken at, so the browser can tell this answer apart
         * from the /events snapshots racing it, see AgentsListSchema.
         *
         * The refresh first is what makes a roster read SELF-HEALING. Every other trigger fires on something
         * the daemon did; a hand-merge in a terminal, a rebuild, a sibling agent's land absorbing the same
         * hunks all move the shas with nothing to hook. Loading the board is the moment the user is asking
         * about, so it is the honest place to re-ask git, and it also broadcasts, every other open surface
         * heals with it. */
        list: i.list.handler(async () => {
            await services.agents.refreshStandings();
            // The approvals queue rides along as `held`, the wakes waiting at the door belong on the board
            // beside the agents that got through it. Approve/reject stay the automations routes' verbs.
            return { agents: services.agents.list(), rev: services.agents.revision(), held: await services.approvals.list() };
        }),
        // The archive's own roster, the other half of the fleet, off `list` by construction and pulled on
        // demand (the /events stream never carries it). Newest-archived first; see registry.listArchived.
        archived: i.archived.handler(() => ({ agents: services.agents.listArchived(), rev: services.agents.revision() })),
        /* The board's filter, and the popped-out rail's. Answers over BOTH halves of the fleet in one pass,
         * the live roster and the archive, because the board hides by design (its Finished lane windows to a
         * handful, archived agents are off the roster entirely), and a filter that reports "no matches" while
         * the agent sits one click away is a lie the user only catches once.
         *
         * Matches the TITLE (which is the sanitized first prompt) or anything either side SAID in the
         * conversation, the user's later prompts and the agent's own replies, while thinking, tool output and
         * daemon protocol stay out (see AgentSearchQuerySchema for where that line is drawn, and matchLines for
         * why the user's own words are the snippet when both sides hit). A title match carries no snippet: the
         * card already shows it.
         *
         * A draft agent has no session and so nothing said, and never appears here, the browser matches those
         * against the title it holds locally, which is all a conversation with no turn yet has.
         */
        search: i.search.handler(async ({ input }) => {
            // The field's Aa switch, applied by FOLDING once here: the needle and every line it is tested against
            // meet in the same case, so the whole title test is one substring test either way. The index folds
            // its own side by the same rule (see search-index.ts on why that fold is JS's and not sqlite's).
            const caseSensitive = input.caseSensitive === true;
            const needle = caseSensitive ? input.query : input.query.toLowerCase();
            const entries = [...services.agents.list(), ...services.agents.listArchived()];
            /* ONE QUERY FOR THE WHOLE FLEET, rather than a read per entry. This used to be a Promise.all over
             * every registry entry, each awaiting that conversation's extracted lines: on a real workspace
             * (1418 entries, 545 MB of records) the first such query was seconds of blocking parse and every
             * one after it re-scanned 30 572 lines in memory. The index answers all of them at once. */
            const said = await services.saidIndex.search(input.query, "conversation", caseSensitive);
            const matches = entries.flatMap((agent) => {
                const title = caseSensitive ? agent.title : agent.title?.toLowerCase();
                if (title?.includes(needle) === true) {
                    return [{ id: agent.id }];
                }
                const indexed = said.get(agent.id);
                /* The WRITE-LAG OVERLAY: prompts this daemon has routed but no turn has settled yet, so the
                 * index cannot hold them. Small, in memory, and only for conversations touched since boot.
                 * Without it the words a user just sent are unsearchable for as long as the turn runs, which is
                 * precisely when they are most likely to be searched for. */
                const pending = matchLines(conversationLines(agent.id, []), needle, caseSensitive);
                /* THE USER'S OWN WORDS WIN, and among theirs the OLDEST, which is the index's rule too. A
                 * recorded user line therefore beats a just-sent prompt (it is older), a just-sent prompt beats
                 * anything the agent said, and with neither the agent's line stands as the evidence. */
                const snippet = indexed?.speaker === "user" ? indexed : pending?.speaker === "user" ? pending : (indexed ?? pending);
                return snippet === undefined ? [] : [{ id: agent.id, snippet }];
            });
            /* `indexing` is the honest half of the answer: while the backfill is still working the index does
             * not yet hold everything said in this workspace, so this result can still grow. The board says so
             * rather than presenting a partial list as the whole one. */
            return { matches, scanned: entries.length, indexing: services.saidIndex.indexing() };
        }),
        get: i.get.handler(({ input }) => {
            const summary = services.agents.get(input.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // The transcript a card redraws, read root-scoped: the workspace root is the working dir every turn
        // saw, so restored tool locations and attachment paths come back relative to the same tree they
        // streamed against.
        /* A conversation's transcript, for a client opening its tab. Answers for EVERY agent, the transcript is
         * the daemon's own record now (sessions/transcript-record.ts), so it no longer depends on the agent
         * running a harness that keeps a readable session store. This route used to return `{messages: []}` for
         * anything `sdkSessionIdOf` had no answer for, which is every codex/grok NATIVE and every ACP agent:
         * their chats opened blank, permanently, with the work sitting on disk the whole time.
         *
         * `sessionId` still comes from the SDK-shaped lookup, because it answers a different question, which
         * session the client should ADOPT so its next turn resumes the right thread, and only the Claude Code
         * loop has one of those to hand over. */
        transcript: i.transcript.handler(async ({ input }) => {
            const agent = entryOf(input.id);
            const sessionId = sdkSessionIdOf(agent);
            const messages = await services.transcripts.read(agent);
            /* WHAT THAT SESSION IS BOUND TO rides with it: the runtime and the credential it was minted under,
             * which is the entry's own record of the last turn (the registry files the account with the id, see
             * its `session` case). The client cannot work these out — its tab holds the picks the NEXT turn
             * would use, and after a mid-chat switch those are exactly the ones the session does NOT belong to,
             * so a client filling them in itself announced a fresh session for the account actually holding it
             * and retired a resumable session on the next send. Only sent with a session; there is nothing to
             * bind otherwise. */
            return {
                ...(sessionId !== undefined
                    ? {
                          sessionId,
                          provider: agent.provider,
                          harness: agent.harness,
                          ...(agent.account !== undefined ? { account: agent.account } : {}),
                      }
                    : {}),
                messages,
            };
        }),
        /* SPEAK AS THE AGENT, the user's words appended to the record as an assistant row, no turn behind them,
         * no reply. Marked `placed` so a HUMAN re-reading the transcript can tell (the flag never reaches any
         * agent-facing text, see RestoredMessageSchema).
         *
         * The session drop is the half that makes it real. Appending alone would show the line to every reader
         * but the one that matters: a next turn that RESUMES its provider session never re-reads the record, so
         * the agent would carry on from a memory the transcript no longer matches. Forgetting the session is
         * rewind's own move, the next turn then opens a fresh runtime session seeded from the record
         * (agent.routes.ts → handoffHistory), where the placed line renders exactly like every line the agent
         * genuinely said.
         *
         * OPEN BEFORE APPEND, and not as ceremony: for a conversation still served off the provider-store
         * backfill the record does not exist yet, and a bare append would create it holding ONLY the placed
         * line, which, the record being authoritative wherever it exists, would silently disappear the whole
         * conversation behind it. `open` adopts that history first.
         *
         * UNDER THE REWIND LEASE rather than a notRunning check, for rewind's own reason: a turn admitted
         * between check and append would resume the very session this exists to retire, and the placed line
         * would sit in a transcript the running turn's memory knows nothing about. The lease is the same mutex
         * a turn takes, so the two cannot interleave; a held lease answers undefined ⇒ CONFLICT.
         *
         * A CHANNEL CONVERSATION'S AUDIENCE IS THE CHANNEL. One woken by an outside message (a Discord mention,
         * a Telegram chat, origin.channelId names the thread) has two readers: the transcript and whoever is
         * waiting where the message came from. A placed line that only reached the record answered into the
         * void, the channel saw nothing, while the transcript claims the agent spoke, so the line is carried
         * out through the provider's gateway first (extensions/listener-deliver.ts), and carried FIRST: a
         * delivery that fails refuses the whole place (BAD_GATEWAY, with the gateway's own sentence), leaving
         * the record untouched rather than holding a sentence its audience never got. Origins with no gateway
         * (webchat, webhook) have no channel transport and place into the record alone, as every conversation
         * without an origin does. */
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
                        // The outbound trail: the same row an agent's own send leaves, so the activity feed
                        // shows the channel got this line even though no turn ran.
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
                await services.transcripts.open(agent);
                await services.transcripts.append(agent, [{ role: "assistant", text: input.text, placed: true }]);
                await services.agents.clearSession(input.id);
                return true;
            });
            if (outcome === undefined) {
                throw new ORPCError("CONFLICT", { message: "the agent's turn is running, wait for it to finish" });
            }
            return { ok: true } as const;
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
        // the agent works is exactly "hold THIS turn's work for review", the press that matters most.
        autoLand: i.autoLand.handler(async ({ input }) => {
            isolatedEntryOf(input.id);
            const summary = await services.agents.setAutoLand(input.id, input.autoLand);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        /* THIS conversation's outage posture. `entryOf`, not `isolatedEntryOf`, the one place this route
         * deliberately differs from the one above it: a provider outage kills a workspace chat as readily as a
         * branch-backed one, and nothing about picking the turn back up touches a worktree.
         *
         * Legal mid-turn, and the press that matters most arrives just AFTER one: the offer is raised by the
         * failure frame of the turn that died, so the ordinary caller is a chat whose turn is still unwinding.
         * The resume pass re-reads the posture every few seconds, which is what makes arming it then arm the
         * very turn that bounced. */
        resumeAfterOutage: i.resumeAfterOutage.handler(async ({ input }) => {
            entryOf(input.id);
            const summary = await services.agents.setResumeAfterOutage(input.id, input.resumeAfterOutage);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        /* A collaborator's ask for a land they may not perform (role floors put land/discard at maintainer).
         * Isolated agents only, a workspace conversation has no land for anyone to perform. Legal mid-turn
         * (no notRunning): the ask is about whatever the branch holds when a maintainer answers it, exactly
         * like flipping autoLand. Loopback mode has no identity to attribute the ask to, and no collaborators
         * to make one. */
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
        /* THE USER'S HAND ON THE AGENT'S STANDING ARRANGEMENT. Everything else that ends a watch is the
         * daemon's or the agent's: it fires, it times out, or a later turn calls `watch stop`. This is the
         * press for the case none of those cover, the user reading a card that says it is waiting for
         * something they no longer want waited for.
         *
         * Legal in every state, deliberately, including mid-turn. A watch is not the turn's working state (it
         * is a timer with an env snapshot), nothing is half-written by disarming one, and the moment a person
         * most wants this press is while the conversation is awake and busy doing the thing they have decided
         * against.
         *
         * The disarm itself republishes the card (watchers.ts `discard` → the projection → a roster
         * broadcast), so by the time the summary below is read it has already lost its watches. */
        stopWatching: i.stopWatching.handler(async ({ input }) => {
            const entry = entryOf(input.id);
            // Awaited: the disarm has to reach the watch journal too, or a container recreate moments after
            // this press would restore at boot the very watch the user has just dismissed.
            await cancelWatchersFor(entry.id);
            // Read back through `get` rather than off the live roster: an ARCHIVED conversation can hold armed
            // watches (archiving takes a card off the board, it does not disarm anything), and it is the one
            // that most needs this press, since its watch would wake it straight back onto the board.
            const summary = services.agents.get(entry.id);
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        // The review shows the agent's CUMULATIVE output (anchor → worktree), so work stays inspectable after
        // it lands, which is the normal case, clean turn completions auto-landing within ms of finishing.
        // What landing changes is per-file: a second pass from `landedTip` names the remainder still waiting
        // for "Land now" (everything, when nothing has landed yet), and every other file is flagged `landed`.
        diff: i.diff.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            const repos: AgentRepoChanges[] = [];
            for (const composed of entry.repos) {
                try {
                    /* The one reading of this agent's delta (agent-changes.ts), the same call the land totals
                     * for the card's counter, so the two surfaces cannot disagree about what the agent did.
                     * The cumulative span keeps landed work inspectable (a clean turn auto-lands within ms of
                     * finishing); the outstanding one is the land's own incremental span, and flags the rest. */
                    const changes = await agentRepoChanges(services.agentWorktrees, entry, composed, "cumulative");
                    if (changes.length === 0) {
                        continue;
                    }
                    const pending =
                        composed.landedTip === undefined
                            ? new Set(changes.map((change) => change.path))
                            : new Set((await agentRepoChanges(services.agentWorktrees, entry, composed, "outstanding")).map((change) => change.path));
                    // Object.assign, not a spread: `changes` is this call's own freshly-parsed array, so the
                    // flag goes onto the objects that are about to be serialized and nothing is copied.
                    const flagged = changes.map((change): AgentChange => Object.assign(change, { landed: !pending.has(change.path) }));
                    // The tree's own package layout, for the review to group those rows under (agent-changes.ts).
                    // Read here rather than looked up from /workspace/modules: that read walks /work, which cannot
                    // see a package living so far only in this agent's worktree.
                    const modules = await agentRepoModules(services.agentWorktrees, entry, composed.repo);
                    repos.push({ repo: composed.repo, branch: entry.branch, changes: flagged, modules });
                } catch (error) {
                    // One broken worktree (mid-repair, deleted dir) must not 500 the whole review.
                    services.logger.warn({ err: error, repo: composed.repo, id: entry.id }, "agents diff: repo skipped");
                }
            }
            /* The last land's refusal travels with the review it is about: the panel is opened FROM the
             * conflicted card, so it has to arrive already knowing what blocked and why (see
             * AgentChangesSchema). Re-derived, not replayed from the entry: the stored report is the refusal
             * AT LAND TIME, and its `workspace` rows point at uncommitted edits the user may since have
             * committed, served verbatim, they kept the resolve flow refusing ("commit or stash them") over
             * a spotless tree. The entry keeps the event; the probes answer for today (outstandingConflicts).
             * Omitted once nothing refuses anymore, a report with no rows is not a report. */
            const conflicts = entry.conflicts === undefined ? [] : await outstandingConflicts(services.agentWorktrees, entry);
            return { repos, ...(conflicts.length > 0 ? { conflicts } : {}) };
        }),
        // Against the same cumulative anchor as the list above: one row means one question, "what did this
        // agent do to this file", and its answer must not change the moment the work lands. (Diffing from
        // `landedTip` would silently empty out every already-landed row; diffing from the frozen base would
        // show other agents' synced-in work, disagreeing with the list.)
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            const composed = entry.repos.find((repo) => repo.repo === input.repo);
            if (composed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "repo not in this agent's composition" });
            }
            const main = services.agentWorktrees.mainDir(input.repo);
            // Retired checkout: both sides are blobs, read from the main repo, the same per-repo seam as
            // `diff` above. The path guard still applies, it is validating the REQUEST, not the disk, and a
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
        // Manual land, the recovery path after a conflicted or aborted auto-land; same patch-apply mechanics.
        land: i.land.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            landable(input.id, input.force === true);
            // Snapshotted before the land advances every landedTip, the span a chore diffs from, exactly as
            // the auto-land path captures it before its own land (see streamIsolatedTurn). A cumulative land
            // reads from the base for the same reason the land itself does: the rung it is putting back is
            // the one before anything landed, so a chore told otherwise would diff an empty range.
            /* The same last-moment rebase the auto-land takes (agents/sync.ts syncBeforeLand), and this road
             * needs it more: "Land now" is clicked minutes or hours after the turn that wrote the work, with
             * the user having landed other cards in between, which is precisely the main-line movement that
             * makes a patch refuse over lines this agent never touched.
             *
             * Best-effort: the work is finished and on the branch, so a git fault costs the rebase and never
             * the land the user just asked for. */
            let composition = entry.repos;
            try {
                composition = [...(await syncBeforeLand(services.agentWorktrees, entry, services.agents.recordWorktree))];
            } catch (error) {
                services.logger.warn({ err: error, id: entry.id }, "agents: pre-land sync failed, landing on the old base");
            }
            // Snapshotted AFTER the sync, for the reason the auto-land path spells out: a rebase orphans the
            // sha a span names, and a chore diffed from it carries every main-line commit underneath.
            const span = composition.map(({ repo, base, landedTip }) => ({
                repo,
                from: input.span === "cumulative" ? base : (landedTip ?? base),
                dir: services.agentWorktrees.worktreeDir(entry.id, repo),
            }));
            const result = await landAgent(services.agentWorktrees, { ...entry, repos: composition }, input.mode, input.span);
            // Both halves of what the card will show: recordLanded stores the tips and the conflict report,
            // and re-derives the standing from them. `finish` no longer carries a verdict, it clears how the
            // LAST TURN ended, which a deliberate land is the user moving past (an `error` card they chose to
            // land must not keep wearing the error), and takes no turn off the counter because none ran.
            await services.agents.recordLanded(input.id, result);
            /* ...but ONLY once the turn it describes is over. `finish` flushes the turn's usage, releases the
             * conversation's mutex and writes how the turn ended, the right close for a land on a resting
             * agent, and a lie on a live one. Called under a running turn it would free the mutex a second
             * turn could then claim beside the first, and stamp an ending on a turn still streaming frames
             * that will stamp their own. The land itself is complete either way; what waits is the
             * bookkeeping, and the turn's own completion does it. */
            if (!services.agents.running(input.id)) {
                await services.agents.finish(input.id, Date.now());
            }
            if (result.landed && result.changed) {
                // What this work DID, drafted from the diff now sitting in the tree, for the Changes panel's
                // chip to file into the commit box. Not awaited, the card's response does not wait on it.
                describeLandingInBackground(services, entry.id);
                // The main tree changed under the user, same attribution convention as git.discard.
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
                // A `merge` land's report of the paths it left carrying conflict markers, dropping this is
                // how the panel's "Landed with N files to finish" strip went permanently dark.
                ...(result.resolving !== undefined ? { resolving: result.resolving } : {}),
                ...(result.held === true ? { held: true } : {}),
            };
        }),
        discard: i.discard.handler(async ({ input }) => {
            const entry = isolatedEntryOf(input.id);
            notRunning(input.id);
            /* Its armed watches go with it, and they have to go FIRST, while the conversation they would wake
             * still exists. A watch outliving its conversation is not a stale readout, it is a timer that will
             * eventually try to start a turn on an id nothing answers to, hours after the user threw the agent
             * away. The registry can only forget the card's copy (see its `remove`); this is the disarm. */
            await cancelWatchersFor(entry.id);
            // Resources first, worktree second: a shell or dev server the conversation left running must not
            // be mid-write in a tree that is being deleted under it (platform/reaper.ts).
            await services.reaper.reapConversation(entry.id, { force: true });
            await services.agentWorktrees.remove(entry.id, entry.repos);
            await services.agents.remove([entry.id]);
            return { ok: true } as const;
        }),
        // Named ids archive whatever the user pointed at (a card, or a bulk undo's inverse); no ids means
        // "clear the Finished lane", every agent that is archivable RIGHT NOW, ignoring the retention clock.
        // Both routes answer with what MOVED and not with the roster afterwards: see AgentsMovedSchema, a
        // snapshot would let two overlapping requests undo each other's work in the browser.
        archive: i.archive.handler(async ({ input }) => {
            if (input.ids !== undefined) {
                for (const id of input.ids) {
                    entryOf(id);
                    notRunning(id);
                }
            }
            /* THE RE-PROBE IS THE BULK PRESS'S ALONE. "Every agent that is archivable right now" is a question
             * about the DERIVED half of the status, which is invisible from the persisted entry (see
             * archive.ts), so "Clear" has to re-ask git before it can decide what qualifies.
             *
             * A named archive has already been decided, by the user, about a card they are looking at: the ids
             * ARE the answer that probe would produce. Awaiting it anyway made one click cost a standing read
             * over the whole live roster, cheap while every verdict's key still holds, and a git pass per
             * agent the moment anything moved main (a land, a hand-commit, a restart empties the cache
             * outright). That is the whole of "archiving one card is sometimes ultra slow" on a board with a
             * thousand sessions on it: the press paid for the fleet before it did the one thing it was for.
             * Nothing downstream needs the fresher verdict either, the guards a named archive owes the user
             * are `notRunning` above, and archiveAgents re-reads each entry as it goes. */
            const archivableNow = async (): Promise<string[]> => {
                await services.agents.refreshStandings();
                return services.agents
                    .list()
                    .filter(archivable)
                    .map((agent) => agent.id);
            };
            const targets = input.ids ?? (await archivableNow());
            const { archived, failed } = await archiveAgents(services, targets, Date.now());
            // Read AFTER the archive, so each summary carries the archivedAt the card dates itself by, and with
            // the revision that applied it, the browser holds these ids off the board until a roster at least
            // that new arrives, so an in-flight older snapshot can't put them back.
            //
            // `failed` rides along rather than becoming an error: an archive that moved nine cards and refused
            // one is not a failed request, and the one it refused is not "nothing to archive" either, which is
            // the only thing the board could say while the reason stayed in the log.
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
            // No worktree restore: the next turn's ensure() rebuilds the checkout from the branch, so putting a
            // card back is a registry write and nothing else.
            await services.agents.clearArchived(input.ids);
            return {
                moved: input.ids.map((id) => services.agents.get(id)).filter((summary) => summary !== undefined),
                rev: services.agents.revision(),
            };
        }),
        /* The archive's own exit, and the destructive one: everything filed away is deleted outright, branches
         * included. Answers with the ids that actually went, a teardown that fails on one agent leaves that one
         * in the archive rather than failing the press (see purgeArchived).
         *
         * The ARCHIVED RUN RECORDS go with them, because an archived run is the row the archive lists its steps
         * under: leaving it behind would draw a workflow in an emptied archive whose sessions no longer exist,
         * and clicking it would open nothing. Only archived runs, a run still on the board is not in the pile
         * this press is about, even if the retention sweep filed some of its steps away on their own.
         */
        purge: i.purge.handler(async () => {
            // Same disarm-before-delete as `discard` one route up, and the same reason: an archived
            // conversation can be sitting on armed watches, and a timer that outlives the agent it belongs to
            // eventually tries to start a turn on an id nothing answers to.
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
