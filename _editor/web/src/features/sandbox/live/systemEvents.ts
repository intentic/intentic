import { resetSandboxScope } from "@intentic/extension-api";
import { fileBoundQueryKeys, staleQueryKeys, staleRuntimeQueryKeys, type SystemEvent } from "@intentic/sandbox-contract";
import { contributedFileBindings } from "../../../extension-host/fileBindings";
import { emitFilesChanged } from "../../../extension-host/fileEvents";
import { emitRefsChanged, emitReposChanged } from "../../../extension-host/repoEvents";
import { dropEditBuffers } from "../../workspace/files/useEditBuffers";
import { desyncAgents } from "../../agents/fleet/useAgents";
import { auditRoster, refreshAgents, setAgents } from "../../agents/fleet/useAgents-registry";
import { providerRefusals, setAccountUsage } from "../../chat/accounts/providerAccounts";
import { useChat } from "../../chat/run/useChat";
import { agentReviewPrefixes, pushedKeys, rpcPrefix } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { throttleTrailing } from "../../../lib/throttleTrailing";
import { setPresenceUsers } from "../../../shell/presence/usePresence";
import { landingNow } from "../../workspace/changes/landing";
import { applyTreeChanged, markDerivedChanged, markWorkspaceChanged, worktreeMovedRecently } from "../../workspace/changes/live/useWorkspaceLive";
import { emitRuntimeChanged } from "./runtimeEvents";
import { daemonRebuilt, dropSandboxLocalState, sandboxQueryPredicate, workspaceReplaced } from "./systemEventRouting";
import { setDaemonBoot } from "../overview/useDaemonBoot";
import { setDaemonRoutes } from "../overview/useDaemonRoutes";
import { useSandbox } from "../client/useSandbox";

// Routes a daemon `/events` frame to whatever it invalidates; connection liveness lives elsewhere (see
// useSandboxLiveness). The switch is exhaustive over the `SystemEvent` union, so an unhandled frame kind is a
// compile error.

// Throttle for review refetches; each one walks every repo and runs `git status` per repo.
export const CHANGES_REFRESH_MS = 1000;

const refreshChanges = throttleTrailing(() => {
    // Nothing worth reading while a land is applying: the patch is half in the tree, and the scan would take the git
    // subprocesses the land is waiting on. useChanges refetches once the lease clears.
    if (landingNow.value) {
        return;
    }
    for (const key of pushedKeys([`git`, `changes`])) {
        void queryClient.invalidateQueries({ queryKey: key });
    }
    // A review compares the agent's branch against this tree, not just its own commits, so tree changes invalidate it
    // too, whole.
    for (const key of agentReviewPrefixes) {
        void queryClient.invalidateQueries({ queryKey: key });
    }
}, CHANGES_REFRESH_MS);

// Whether a replaced workspace is the one in view, whose scope starts over; the storage sweep runs for any sandbox.
const { activeSandboxId } = useSandbox();

// A (re)connection, which is the one frame that reconciles rather than invalidates: everything pushed-only has to be
// refetched here, since frames that landed while this browser was away are simply gone.
const applyHello = (event: Extract<SystemEvent, { kind: `hello` }>, sandboxId: string): void => {
    // Workspace replaced (recreated under the same id) or daemon rebuilt into a differently-shaped one; either makes the
    // cached workspace state stale.
    const replaced = workspaceReplaced(sandboxId, event.workspaceId);
    const rebuilt = daemonRebuilt(sandboxId, event.build);
    // A replaced workspace is a new sandbox scope under the same id: its remembered tabs, folders and drafts are swept
    // first, so the scope reads nothing back from storage, and the rest of this hello fills it like any first connect.
    if (replaced) {
        dropSandboxLocalState(sandboxId);
        if (activeSandboxId.value === sandboxId) {
            resetSandboxScope();
        }
    }
    // A new connection may restart the daemon's revision counter; reset here so a lower revision isn't dropped as stale.
    desyncAgents();
    // Wakes held for approval arrive only via GET /agents, never the stream, so refetch them explicitly on every hello.
    void refreshAgents();
    // Route surface gates features for the rest of this connection; shapes ride the same frame.
    setDaemonRoutes(event.routes, event.shapes);
    // Daemon boot state, needed before other daemon queries are allowed to fire this tick.
    setDaemonBoot(event.boot);
    // Between events a cached read is taken as true (staleTime, queryPersistence), which makes a (re)connect the one
    // moment that has to distrust every one of them: frames that landed while this browser was away are gone, and a
    // cache hydrated from disk can be hours old. What is on screen refetches now; the rest is marked for its next
    // mount. This covers every pushed-only (file- and runtime-bound) key too; naming one again would cancel its read
    // in flight and start another, which the daemon answers twice. Ahead of the reset below, so a replaced workspace
    // still gets the stronger treatment.
    void queryClient.invalidateQueries({ refetchType: `active` });
    // A rebuild leaves the scope alone, since `/work` is unchanged; either way the cached reads go.
    if (replaced || rebuilt) {
        // Reset, not remove, so active observers refetch rather than render empty.
        void queryClient.resetQueries({ predicate: sandboxQueryPredicate(sandboxId) });
    }
    // Catches views an invalidation can't reach (nothing mounted); an empty batch is this channel's "something changed,
    // unspecified" (fileEvents.ts).
    emitFilesChanged([]);
};

// Paths the daemon saw change on disk, or the unnamed batch that stands for "something moved and I cannot say what".
const applyWorkspaceChanged = (event: Extract<SystemEvent, { kind: `workspaceChanged` }>): void => {
    markWorkspaceChanged(event.paths);
    // Keys are core's table unioned with what activated extensions declare; an inactive extension contributes nothing.
    // An empty path list means the daemon truncated the batch, so it invalidates every file-bound key, not none.
    const stale = event.paths.length === 0 ? fileBoundQueryKeys(contributedFileBindings()) : staleQueryKeys(event.paths, contributedFileBindings());
    for (const key of stale.flatMap((name) => pushedKeys([name]))) {
        void queryClient.invalidateQueries({ queryKey: key });
    }
    // Same frame, announced for rail badges with no mounted query; sent even for an empty batch, the largest change
    // there is.
    emitFilesChanged(event.paths);
    // Skipped during a streaming turn to avoid hammering `git status` on every write; useChanges covers it at
    // stream-end. An unnamed batch is exempt: it is the daemon saying it cannot name what moved (a truncated burst, a
    // reconnect, a check whose build rewrote tracked files under a dir the watcher prunes), and the review has no other
    // way to hear it — skipping one leaves whatever was read mid-write standing as the answer.
    if (event.paths.length === 0 || !useChat().streaming.value) {
        refreshChanges();
    }
};

/** Routes one typed `/events` frame to whatever it makes stale. */
export const applySystemEvent = (event: SystemEvent, sandboxId: string): void => {
    switch (event.kind) {
        case `hello`:
            applyHello(event, sandboxId);
            return;
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
            for (const key of staleRuntimeQueryKeys(event.domains).flatMap(pushedKeys)) {
                void queryClient.invalidateQueries({ queryKey: key });
            }
            // Same frame, announced for readers that hold plain refs instead of queries (pairing cards), so they need
            // no poll.
            emitRuntimeChanged(event.domains);
            return;
        case `reposChanged`:
            // Watcher never sees `.git` paths, so no workspaceChanged batch covers this; the daemon diffs its own repo
            // discovery.
            void queryClient.invalidateQueries({ queryKey: rpcPrefix(`panels.list`) });
            // Extensions own their own caches; this only announces the new set (see extension-host/repoEvents).
            emitReposChanged(event.repos);
            return;
        case `refsChanged`: {
            // Refs moved (commit, checkout, branch, tag, rebase) outside this tab; three things go stale:
            // - the Changes review, since ahead/behind and staged files move with refs
            // - the Checkpoints timeline
            // - open editor buffers, only if the worktree itself moved
            refreshChanges();
            void queryClient.invalidateQueries({ queryKey: rpcPrefix(`history.list`) });
            if (worktreeMovedRecently()) {
                dropEditBuffers();
            }
            // Extensions own their own caches; this only announces that a ref moved (see extension-host/repoEvents).
            emitRefsChanged(event.repos);
            return;
        }
        case `derivedChanged`:
            // Only the derived-text surfaces care, and they hold a ref rather than a query: a shadow is read by path on
            // demand, never cached per file, so there is no key to invalidate here.
            markDerivedChanged(event.paths, event.queue);
            return;
        case `workspaceChanged`:
            applyWorkspaceChanged(event);
            return;
        case `treeChanged`:
            applyTreeChanged(event);
            return;
    }
};
