import { watch } from "vue";
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
});

// Account status lives on the daemon, so (re)load it whenever the ACTIVE daemon is reachable: first liveness
// success (initial page load), reconnects after an outage, and sandbox switches (the reset above just zeroed
// `connections`). activeSandboxId is in the source so a switch between two recently-healthy sandboxes — where
// liveness keeps `reachable` true and it never flips — still reloads. Registered after the reset watch so a
// switch resets before the reload fires.
watch([reachable, activeSandboxId], ([isReachable]) => {
    if (isReachable) {
        void loadAccountStatus();
    }
});
