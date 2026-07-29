import { watch } from "vue";
import { loadArchived, resetAgents, resetArchive } from "../agents/useAgents";
import { loadAccountStatus, resetChat } from "../chat/useChat";
import { resetEditBuffers } from "../workspace/useEditBuffers";
import { resetPresence } from "../usePresence";
import { useSandbox } from "./useSandbox";
import { resetWorkspaceTreeState } from "../workspace/useWorkspaceTree";

/* One central place that re-scopes the browser's client-side state to the active sandbox. vue-query server
 * state is already scoped by sandboxKey (its keys carry the active id), but the module-level singletons —
 * chat, editor buffers, the shared file-action feedback — live outside the component tree and would otherwise
 * carry one sandbox's data onto the next. Reachable + the liveness stream are re-scoped in useSandboxLiveness.
 *
 * This watch is registered at module scope (imported once from main.ts) rather than inside the shell on
 * purpose: the "add sandbox" flow changes the active sandbox while the shell is UNMOUNTED (on /setup), so a
 * shell-scoped watcher would miss exactly the switch that triggers the reported bug. A dedicated module also
 * avoids the useChat → sandboxClient → useSandbox import cycle. */

const { activeSandboxId, reachable } = useSandbox();

watch(activeSandboxId, (id, previous) => {
    if (id === previous) {
        return;
    }
    resetChat();
    resetEditBuffers();
    resetWorkspaceTreeState();
    // The roster belongs to the daemon it came from; the new sandbox's stream repaints it on connect.
    resetPresence();
    // Same for the fleet — and it can't be left to the liveness loop, which only clears it when a stream FAILS
    // and stands down entirely when the failure was this switch aborting it. What survived was not just stale
    // cards: the applied registry revision came along too, so an incoming daemon whose counter starts lower
    // (a fresh container, a restart) had every roster frame it sent dropped as out-of-order, leaving the
    // previous sandbox's agents on the board and its titles renaming this sandbox's tabs.
    resetAgents();
    // The archive half goes with it — but ONLY here, not on stream failures (see resetArchive on why).
    resetArchive();
});

// Account status lives on the daemon, so (re)load it whenever the ACTIVE daemon is reachable: first liveness
// success (initial page load), reconnects after an outage, and sandbox switches (the reset above just zeroed
// `connections`). activeSandboxId is in the source so a switch between two recently-healthy sandboxes — where
// liveness keeps `reachable` true and it never flips — still reloads. Registered after the reset watch so a
// switch resets before the reload fires.
watch([reachable, activeSandboxId], ([isReachable]) => {
    if (isReachable) {
        void loadAccountStatus();
        // The archive list rides the same seam: it is pull-only (the roster stream never carries it), and the
        // daemon that just (re)appeared may have filed agents away itself — its boot sweep archives entries
        // whose worktree vanished, its retention pass archives what aged out. Without this re-read, the
        // Finished header's count froze at whatever the last visit saw — a daemon restart away from reading 0
        // and hiding the archive door with every agent the user ever ran behind it.
        void loadArchived();
    }
});
