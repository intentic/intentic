import { fileBoundQueryKeys, runtimeBoundQueryKeys, staleQueryKeys, staleRuntimeQueryKeys, type SystemEvent } from "@intentic/sandbox-contract";
import { contributedFileBindings } from "../../../extension-host/fileBindings";
import { emitFilesChanged } from "../../../extension-host/fileEvents";
import { emitRefsChanged } from "../../../extension-host/refEvents";
import { resetEditBuffers } from "../../workspace/files/useEditBuffers";
import { desyncAgents } from "../../agents/fleet/useAgents";
import { auditRoster, refreshAgents, setAgents } from "../../agents/fleet/useAgents-registry";
import { providerRefusals, setAccountUsage } from "../../chat/accounts/providerAccounts";
import { useChat } from "../../chat/run/useChat";
import { AGENT_DIFF, GIT_CHANGES, HISTORY_SNAPSHOTS, PANELS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { throttleTrailing } from "../../../lib/throttleTrailing";
import { setPresenceUsers } from "../../../shell/presence/usePresence";
import { markWorkspaceChanged, worktreeMovedRecently } from "../../workspace/changes/useWorkspaceLive";
import { emitRuntimeChanged } from "./runtimeEvents";
import { resetWorkspaceScopedState } from "../client/sandboxScope";
import { daemonRebuilt, dropSandboxLocalState, sandboxQueryPredicate, workspaceReplaced } from "./systemEventRouting";
import { setDaemonBoot } from "../overview/useDaemonBoot";
import { setDaemonRoutes } from "../overview/useDaemonRoutes";
import { useSandbox } from "../client/useSandbox";

// Routes a daemon `/events` frame to whatever it invalidates; connection liveness lives elsewhere (see
// useSandboxLiveness). The switch is exhaustive over the `SystemEvent` union, so an unhandled frame kind is a
// compile error.

// Throttle for review refetches; each one walks every repo and runs `git status` per repo.
const CHANGES_REFRESH_MS = 1000;

const refreshChanges = throttleTrailing(() => {
    void queryClient.invalidateQueries({ queryKey: GIT_CHANGES.every });
    // A review compares the agent's branch against this tree, not just its own commits, so tree changes invalidate it
    // too.
    void queryClient.invalidateQueries({ predicate: (query) => AGENT_DIFF.matches(query.queryKey) });
}, CHANGES_REFRESH_MS);

// Used only to scope the storage sweep to the sandbox in view; the sweep itself runs for any sandbox's frame.
const { activeSandboxId } = useSandbox();

/**
 * Routes one typed `/events` frame to whatever it makes stale.
 * `sandboxId` is passed in rather than read live, so a frame in flight during a sandbox switch can't apply to the new
 * one.
 */
export const applySystemEvent = (event: SystemEvent, sandboxId: string): void => {
    switch (event.kind) {
        case `hello`: {
            // A new connection may restart the daemon's revision counter; reset here so a lower revision isn't dropped
            // as stale.
            desyncAgents();
            // Wakes held for approval arrive only via GET /agents, never the stream, so refetch them explicitly on
            // every hello.
            void refreshAgents();
            // Route surface gates features for the rest of this connection; shapes ride the same frame.
            setDaemonRoutes(event.routes, event.shapes);
            // Daemon boot state, needed before other daemon queries are allowed to fire this tick.
            setDaemonBoot(event.boot);
            // Workspace replaced (recreated under the same id) or daemon rebuilt into a differently-shaped one; either
            // makes the
            // cached workspace state stale.
            const replaced = workspaceReplaced(sandboxId, event.workspaceId);
            const rebuilt = daemonRebuilt(sandboxId, event.build);
            if (replaced || rebuilt) {
                // Reset, not remove, so active observers refetch rather than render empty.
                void queryClient.resetQueries({ predicate: sandboxQueryPredicate(sandboxId) });
            }
            // A replaced workspace also clears remembered tabs/folders/drafts and re-scopes the live view; a rebuild
            // leaves them,
            // since `/work` is unchanged.
            if (replaced) {
                dropSandboxLocalState(sandboxId);
                if (activeSandboxId.value === sandboxId) {
                    resetWorkspaceScopedState();
                }
            }
            // File-bound views are pushed-only, so refetch each key once on (re)connect to catch frames missed while
            // disconnected.
            for (const key of fileBoundQueryKeys(contributedFileBindings())) {
                void queryClient.invalidateQueries({ queryKey: [key] });
            }
            // Catches views an invalidation can't reach (nothing mounted); an empty batch is this channel's "something
            // changed,
            // unspecified" (fileEvents.ts).
            emitFilesChanged([]);
            // Runtime-bound views are also pushed-only with no poll to fall back on, so refetch them on reconnect too.
            for (const key of runtimeBoundQueryKeys()) {
                void queryClient.invalidateQueries({ queryKey: key });
            }
            return;
        }
        case `heartbeat`:
            // A heartbeat means this connection has nothing queued, so the roster reconciles itself against this
            // revision
            // (auditRoster).
            auditRoster(event.rev);
            return;
        case `boot`:
            // Boot frame is a full snapshot, not a diff, like the roster frames.
            setDaemonBoot({ ready: event.ready, startedAt: event.startedAt, steps: event.steps });
            return;
        case `presence`:
            setPresenceUsers(event.users);
            return;
        case `accountUsage`:
            // Newest reading wins into the shared usage map every account UI reads (providerAccounts.usageByAccount).
            setAccountUsage(event.provider, event.account, event.usage);
            return;
        case `providerRefusal`: {
            // Records or clears the observed refusal state for this provider.
            const { [event.provider]: _previous, ...rest } = providerRefusals.value;
            providerRefusals.value = event.refusal === undefined ? rest : { ...rest, [event.provider]: event.refusal };
            return;
        }
        case `agents`:
            // Roster is versioned, not last-frame-wins: it races GET /agents and this browser's own optimistic
            // archive/restore
            // (see useAgents.ts).
            setAgents(event.agents, event.rev);
            return;
        case `runtimeChanged`:
            // No roster in the frame: invalidation only reaches queries someone is observing, so an idle tab pays
            // nothing.
            for (const key of staleRuntimeQueryKeys(event.domains)) {
                void queryClient.invalidateQueries({ queryKey: key });
            }
            // Same frame, announced for readers that hold plain refs instead of queries (pairing cards), so they need
            // no poll.
            emitRuntimeChanged(event.domains);
            return;
        case `reposChanged`:
            // Watcher never sees `.git` paths, so no workspaceChanged batch covers this; the daemon diffs its own repo
            // discovery.
            void queryClient.invalidateQueries({ queryKey: PANELS.every });
            return;
        case `refsChanged`: {
            // Refs moved (commit, checkout, branch, tag, rebase) outside this tab; three things go stale:
            // - the Changes review, since ahead/behind and staged files move with refs
            // - the Checkpoints timeline
            // - open editor buffers, only if the worktree itself moved
            refreshChanges();
            void queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.every });
            if (worktreeMovedRecently()) {
                resetEditBuffers();
            }
            // Extensions own their own caches; this only announces that a ref moved (see extension-host/refEvents).
            emitRefsChanged(event.repos);
            return;
        }
        case `workspaceChanged`: {
            markWorkspaceChanged(event.paths);
            // Keys are core's table unioned with what activated extensions declare; an inactive extension contributes
            // nothing.
            // An empty path list means the daemon truncated the batch, so it invalidates every file-bound key, not
            // none.
            const stale =
                event.paths.length === 0 ? fileBoundQueryKeys(contributedFileBindings()) : staleQueryKeys(event.paths, contributedFileBindings());
            for (const key of stale) {
                void queryClient.invalidateQueries({ queryKey: [key] });
            }
            // Same frame, announced for rail badges with no mounted query; sent even for an empty batch, the largest
            // change there is.
            emitFilesChanged(event.paths);
            // Skipped during a streaming turn to avoid hammering `git status` on every write; useChanges covers it at
            // stream-end.
            if (!useChat().streaming.value) {
                refreshChanges();
            }
            return;
        }
    }
};
