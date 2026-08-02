import { staleQueryKeys, type SystemEvent } from "@intentic/sandbox-contract";
import { contributedFileBindings } from "../../extension-host/fileBindings";
import { desyncAgents, setAgents } from "../agents/useAgents";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { throttleTrailing } from "../throttleTrailing";
import { setPresenceUsers } from "../usePresence";
import { markWorkspaceChanged } from "../workspace/useWorkspaceLive";
import { daemonRebuilt, sandboxQueryPredicate, workspaceReplaced } from "./systemEventRouting";
import { setDaemonBoot } from "./useDaemonBoot";
import { setDaemonRoutes } from "./useDaemonRoutes";

/* Where a daemon `/events` frame LANDS. Everything here is routing — which store takes a roster, which queries
 * a changed path invalidates — and none of it is about whether the connection is alive; that is connection.ts.
 * Splitting the two is what lets the reconnect loop be a loop again (see useSandboxLiveness).
 *
 * The frame arrives already typed: the daemon declares /events as an oRPC event iterator over SystemEvent, and
 * sandboxRpc decodes it back into that union — so this switch is exhaustive by the compiler, and a new frame
 * kind on the contract is a build error here instead of a silently-ignored frame. */

// One review refetch per second while writes keep landing. Each one is the daemon's most expensive read — a
// full discoverRepos walk plus a `git status` per repo — and the watcher batches every 250ms, so a
// drag-dropped repo used to fire ~15 of them in 9 seconds. A second of staleness is imperceptible next to that.
const CHANGES_REFRESH_MS = 1000;

const refreshChanges = throttleTrailing(() => void queryClient.invalidateQueries({ queryKey: [`git`, `changes`] }), CHANGES_REFRESH_MS);

/** Route one typed `/events` frame to whatever it makes stale. `sandboxId` is the sandbox the STREAM belongs
 *  to — passed in rather than read live, so a frame in flight during a switch can never be applied to the
 *  sandbox the user just moved to. */
export const applySystemEvent = (event: SystemEvent, sandboxId: string): void => {
    switch (event.kind) {
        case `hello`: {
            /* A NEW CONNECTION IS A NEW REVISION LINE, and this frame is the only thing that sees every one of
             * them. The fleet roster is versioned by a counter the daemon keeps in its own memory, so a daemon
             * that restarted — a rebuild, an update, a crash — numbers from 0 again while this tab still holds
             * the high-water mark from the process before it, and `setAgents` then drops that daemon's every
             * snapshot as "older than what we have". The board freezes at the instant before the restart:
             * statuses stop moving, finished agents never leave their lane, agents started since never appear,
             * and /agents/:id for one of them has nothing to show. Only a reload clears it, which is exactly
             * how it kept being reported.
             *
             * The stream's failure path already reset it — but that is one of the four ways a stream can end,
             * and a REBUILD takes another: the loopback listener dies with the container, the client demotes to
             * the tunnel and reconnects, and that branch stands down without a word to the roster. Resetting
             * here instead of in each branch is what stops the next branch from forgetting. */
            desyncAgents();
            // The advertised route surface first: it gates features for the rest of this connection.
            setDaemonRoutes(event.routes);
            // Then where the daemon's boot is: `reachable` reads it, so learning this before anything else
            // decides whether a single daemon query is allowed to fire this tick.
            setDaemonBoot(event.boot);
            /* Two independent reasons the cache this browser persisted for the sandbox may describe something
             * that no longer exists — a workspace wiped and recreated under the same sandbox id, and a daemon
             * rebuilt into one that shapes its answers differently. Either one makes hydrating that cache a
             * lie, and the remedy is the same, so they share it. Both RECORD on every hello, so only the first
             * one after the change reports true. */
            if (workspaceReplaced(sandboxId, event.workspaceId) || daemonRebuilt(sandboxId, event.build)) {
                // Reset, not remove: active observers must refetch rather than render an empty cache.
                void queryClient.resetQueries({ predicate: sandboxQueryPredicate(sandboxId) });
            }
            return;
        }
        case `heartbeat`:
            // Liveness only — the connection machine already consumed this frame's arrival.
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
            // With the revision it was taken at — the roster is NOT last-frame-wins: it races an explicit
            // GET /agents and this browser's own optimistic archive/restore, so the store needs to know when
            // each snapshot was true rather than which one arrived last. See useAgents.ts.
            setAgents(event.agents, event.rev);
            return;
        case `reposChanged`:
            // The rail's panel list is derived from the repo set. The watcher never sees .git paths, so no
            // workspaceChanged batch could carry this — the daemon diffs its own discovery instead.
            void queryClient.invalidateQueries({ queryKey: [`panels`] });
            return;
        case `workspaceChanged`: {
            markWorkspaceChanged(event.paths);
            // Core's table unioned with what the ACTIVATED extensions declared — one push, both halves. An
            // extension that isn't running contributes nothing, which is the point of asking the host rather
            // than the installed list.
            for (const key of staleQueryKeys(event.paths, contributedFileBindings())) {
                void queryClient.invalidateQueries({ queryKey: [key] });
            }
            // Any worktree write surfaces in the Changes review — but not during a streaming turn, whose
            // constant writes would hammer `git status`; useChanges' stream-end invalidation covers that batch.
            if (!useChat().streaming.value) {
                refreshChanges();
            }
            return;
        }
    }
};
