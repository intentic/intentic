import { fileBoundQueryKeys, runtimeBoundQueryKeys, staleQueryKeys, staleRuntimeQueryKeys, type SystemEvent } from "@intentic/sandbox-contract";
import { contributedFileBindings } from "../../extension-host/fileBindings";
import { emitFilesChanged } from "../../extension-host/fileEvents";
import { emitRefsChanged } from "../../extension-host/refEvents";
import { resetEditBuffers } from "../workspace/useEditBuffers";
import { desyncAgents, refreshAgents, setAgents } from "../agents/useAgents";
import { useChat } from "../chat/useChat";
import { GIT_CHANGES, HISTORY_SNAPSHOTS, PANELS } from "../queryKeys";
import { queryClient } from "../queryPersistence";
import { throttleTrailing } from "../throttleTrailing";
import { setPresenceUsers } from "../usePresence";
import { markWorkspaceChanged, worktreeMovedRecently } from "../workspace/useWorkspaceLive";
import { resetWorkspaceScopedState } from "./sandboxScope";
import { daemonRebuilt, dropSandboxLocalState, sandboxQueryPredicate, workspaceReplaced } from "./systemEventRouting";
import { setDaemonBoot } from "./useDaemonBoot";
import { setDaemonRoutes } from "./useDaemonRoutes";
import { useSandbox } from "./useSandbox";

/* Where a daemon `/events` frame LANDS. Everything here is routing, which store takes a roster, which queries
 * a changed path invalidates, and none of it is about whether the connection is alive; that is connection.ts.
 * Splitting the two is what lets the reconnect loop be a loop again (see useSandboxLiveness).
 *
 * The frame arrives already typed: the daemon declares /events as an oRPC event iterator over SystemEvent, and
 * sandboxRpc decodes it back into that union, so this switch is exhaustive by the compiler, and a new frame
 * kind on the contract is a build error here instead of a silently-ignored frame. */

// One review refetch per second while writes keep landing. Each one is the daemon's most expensive read, a
// full discoverRepos walk plus a `git status` per repo, and the watcher batches every 250ms, so a
// drag-dropped repo used to fire ~15 of them in 9 seconds. A second of staleness is imperceptible next to that.
const CHANGES_REFRESH_MS = 1000;

const refreshChanges = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: GIT_CHANGES.every }), CHANGES_REFRESH_MS);

// Only to tell whether a workspace-replaced frame concerns the sandbox the user is LOOKING at, the storage
// sweep is safe for any sandbox's frame, but the live re-scope must not blank the view of a different one.
const { activeSandboxId } = useSandbox();

/** Route one typed `/events` frame to whatever it makes stale. `sandboxId` is the sandbox the STREAM belongs
 *  to, passed in rather than read live, so a frame in flight during a switch can never be applied to the
 *  sandbox the user just moved to. */
export const applySystemEvent = (event: SystemEvent, sandboxId: string): void => {
    switch (event.kind) {
        case `hello`: {
            /* A NEW CONNECTION IS A NEW REVISION LINE, and this frame is the only thing that sees every one of
             * them. The fleet roster is versioned by a counter the daemon keeps in its own memory, so a daemon
             * that restarted, a rebuild, an update, a crash, numbers from 0 again while this tab still holds
             * the high-water mark from the process before it, and `setAgents` then drops that daemon's every
             * snapshot as "older than what we have". The board freezes at the instant before the restart:
             * statuses stop moving, finished agents never leave their lane, agents started since never appear,
             * and /agents/:id for one of them has nothing to show. Only a reload clears it, which is exactly
             * how it kept being reported.
             *
             * The stream's failure path already reset it, but that is one of the four ways a stream can end,
             * and a REBUILD takes another: the loopback listener dies with the container, the client demotes to
             * the tunnel and reconnects, and that branch stands down without a word to the roster. Resetting
             * here instead of in each branch is what stops the next branch from forgetting. */
            desyncAgents();
            /* And the one piece of board state the stream will never send: the WAKES HELD for approval. The
             * roster arrives in frames, so it repaints itself; holds are read from GET /agents and from
             * nowhere else, so every moment that invalidates them has to pull them back itself.
             *
             * Here, and deliberately not on the reachable seam beside the archive's read (sandboxScope says
             * why): a read issued before this frame is issued on the OLD revision line and drops its own
             * answer when this line opens. After a sandbox switch, which clears the holds, because they name
             * one daemon's automations, that left the rail's Agents badge undercounting until somebody opened
             * the board, which is the trip the badge exists to save. A daemon restart is the same story with
             * the same fix. */
            void refreshAgents();
            // The advertised route surface first: it gates features for the rest of this connection. Shapes
            // ride with it, same frame, same lifetime, and read by the same store.
            setDaemonRoutes(event.routes, event.shapes);
            // Then where the daemon's boot is: `reachable` reads it, so learning this before anything else
            // decides whether a single daemon query is allowed to fire this tick.
            setDaemonBoot(event.boot);
            /* Two independent reasons the cache this browser persisted for the sandbox may describe something
             * that no longer exists, a workspace wiped and recreated under the same sandbox id, and a daemon
             * rebuilt into one that shapes its answers differently. Either one makes hydrating that cache a
             * lie, and the remedy is the same, so they share it. Both RECORD on every hello (evaluated as two
             * statements so neither short-circuits the other's record), so only the first one after the change
             * reports true. */
            const replaced = workspaceReplaced(sandboxId, event.workspaceId);
            const rebuilt = daemonRebuilt(sandboxId, event.build);
            if (replaced || rebuilt) {
                // Reset, not remove: active observers must refetch rather than render an empty cache.
                void queryClient.resetQueries({ predicate: sandboxQueryPredicate(sandboxId) });
            }
            /* A REPLACED workspace goes further than the query cache: everything this browser remembers about
             * it, tabs, open folders, terminal cosmetics, drafts, names things the new /work does not have.
             * Storage is swept first, then the live view state re-scoped (it re-reads the now-empty snapshots),
             * because a snapshot restored at boot has already painted by the time this frame arrives. A REBUILT
             * daemon deliberately does not do this: /work survived, so the tabs are still true. */
            if (replaced) {
                dropSandboxLocalState(sandboxId);
                if (activeSandboxId.value === sandboxId) {
                    resetWorkspaceScopedState();
                }
            }
            /* Every file-bound view re-asks on a new connection, because the file push is its ONLY live feed
             * and this stream's predecessor may have died holding frames: a workflow step that settled, a
             * draft that appeared, an automation that fired, all written to disk, pushed once, and pushed to
             * nobody. Those views are deliberately unpolled, so without this a missed frame was not a delay,
             * it was staleness with no end. One cheap read per key, deduped, only on (re)connect. */
            for (const key of fileBoundQueryKeys(contributedFileBindings())) {
                void queryClient.invalidateQueries({ queryKey: [key] });
            }
            // And the same catch-up for what an invalidation cannot reach: a rail badge has nothing mounted, so
            // marking its query stale moves nothing until something reads it. Announced as an empty batch, which
            // is this channel's "something changed and we cannot say what" (fileEvents.ts).
            emitFilesChanged([]);
            /* And every RUNTIME-bound view, for the same reason and with more of it to miss: a panel that
             * finished starting, a session that exited, a port that closed while this browser was away were all
             * pushed once, to a stream that had already ended. These views carry no poll to catch up on their
             * own any more, so the reconnect is the catch-up. */
            for (const key of runtimeBoundQueryKeys()) {
                void queryClient.invalidateQueries({ queryKey: key });
            }
            return;
        }
        case `heartbeat`:
            // Liveness only, the connection machine already consumed this frame's arrival.
            return;
        case `boot`:
            // A step moved. The frame IS the whole snapshot (snapshot-not-diff, like the rosters), and the
            // `kind` discriminant is the only field the progress itself doesn't carry.
            setDaemonBoot({ ready: event.ready, startedAt: event.startedAt, steps: event.steps });
            return;
        case `presence`:
            setPresenceUsers(event.users);
            return;
        case `agents`:
            // With the revision it was taken at, the roster is NOT last-frame-wins: it races an explicit
            // GET /agents and this browser's own optimistic archive/restore, so the store needs to know when
            // each snapshot was true rather than which one arrived last. See useAgents.ts.
            setAgents(event.agents, event.rev);
            return;
        case `runtimeChanged`:
            /* Something RUNNING moved, the daemon says which domain, this table says which views. The frame
             * carries no roster on purpose: invalidation only reaches a query something is observing, so a tab
             * showing none of these pays the frame and no request, while the tab with the terminal panel open
             * refetches exactly the one list it draws. */
            for (const key of staleRuntimeQueryKeys(event.domains)) {
                void queryClient.invalidateQueries({ queryKey: key });
            }
            return;
        case `reposChanged`:
            // The rail's panel list is derived from the repo set. The watcher never sees .git paths, so no
            // workspaceChanged batch could carry this, the daemon diffs its own discovery instead.
            void queryClient.invalidateQueries({ queryKey: PANELS.every });
            return;
        case `refsChanged`: {
            /* A commit, checkout, branch, tag or rebase landed, usually the AGENT's, out-of-band, with no HTTP
             * mutation in this tab to hang an invalidation on. Three things go stale, and the third is the one
             * that is easy to miss:
             *   • the Changes review, because ahead/behind and what is staged both move with the refs;
             *   • the Checkpoints timeline, because every destructive git verb snapshots before it runs;
             *   • the open editor BUFFERS, when the worktree was swapped under them (a checkout, a reset, a
             *     rebase). Saving is baseline-guarded daemon-side so a stale buffer cannot overwrite the new
             *     branch's file, but every open file would otherwise sit behind a "changed on disk" notice.
             * The buffers are dropped only when the worktree actually moved, which `workspaceChanged` has
             * already told us: a plain commit leaves the tree identical and must not cost the user an edit. */
            refreshChanges();
            void queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.every });
            if (worktreeMovedRecently()) {
                resetEditBuffers();
            }
            // Extensions own their own caches; the host only says a ref moved (see extension-host/refEvents).
            emitRefsChanged(event.repos);
            return;
        }
        case `workspaceChanged`: {
            markWorkspaceChanged(event.paths);
            /* Core's table unioned with what the ACTIVATED extensions declared, one push, both halves. An
             * extension that isn't running contributes nothing, which is the point of asking the host rather
             * than the installed list.
             *
             * AN EMPTY BATCH TAKES EVERY KEY, and it used to take none: the daemon sends no path list past
             * MAX_PATHS, and matching "no paths" against a prefix table yields nothing, so the one frame that
             * means the MOST changed (a branch switch, a codegen run, a mass delete) was the one frame that made
             * nothing stale. Every file-bound view then sat on pre-switch content until its file's next
             * individual write. Same union, same one-cheap-read-per-key cost as a reconnect. */
            const stale =
                event.paths.length === 0 ? fileBoundQueryKeys(contributedFileBindings()) : staleQueryKeys(event.paths, contributedFileBindings());
            for (const key of stale) {
                void queryClient.invalidateQueries({ queryKey: [key] });
            }
            /* THE SAME FRAME, ANNOUNCED, for the readers an invalidation can never reach: a rail badge is fed by
             * a query with nothing mounted on it, so evicting the entry above changes what the tile says only
             * once somebody asks again. This is what makes a badge react to the write instead of to a timer.
             *
             * Unconditional on `event.paths`, unlike the eviction: an empty batch is the daemon's "more paths
             * than fit in a frame", so it is the LARGEST change there is, and matching it against nothing would
             * drop precisely that one (fileEvents.ts). */
            emitFilesChanged(event.paths);
            // Any worktree write surfaces in the Changes review, but not during a streaming turn, whose
            // constant writes would hammer `git status`; useChanges' stream-end invalidation covers that batch.
            if (!useChat().streaming.value) {
                refreshChanges();
            }
            return;
        }
    }
};
