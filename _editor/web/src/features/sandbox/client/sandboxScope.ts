import { watch } from "vue";
import { resetAgents } from "../../agents/fleet/useAgents";
import { loadArchived, resetArchive } from "../../agents/fleet/useAgents-registry";
import { resetChat } from "../../chat/run/useChat";
import { loadAccountStatus } from "../../chat/accounts/useChat-accounts";
import { resetEditBuffers } from "../../workspace/files/useEditBuffers";
import { resetPreviewSurface } from "../../preview/previewSurface";
import { resetPresence } from "../../../shell/presence/usePresence";
import { resetPushFlow } from "../../workspace/push/usePushFlow";
import { useSandbox } from "./useSandbox";
import { resetTerminalOpen } from "../../../shell/window/useLayout";
import { resetWorkspaceLive } from "../../workspace/changes/useWorkspaceLive";
import { resetWorkspaceTabs } from "../../workspace/tabs/useWorkspaceTabs";
import { resetWorkspaceTreeState } from "../../workspace/explorer/useWorkspaceTree";

// Re-scopes client-side singleton state to the active sandbox; vue-query is already scoped by key, but these
// live outside the component tree. Liveness, sandboxSession's credentials and the extension host re-scope
// themselves rather than being called from here. Registered at module scope, not in the shell, since the active
// sandbox can change while the shell is unmounted (the add-sandbox flow).

const { activeSandboxId, reachable } = useSandbox();

// The /work-derived half of the reset: chat, edit buffers, tree and tabs. Also runs when the hello reports the
// workspace itself was replaced under the same sandbox id, since nothing else would notice that.
export const resetWorkspaceScopedState = (): void => {
    resetChat();
    resetEditBuffers();
    resetWorkspaceTreeState();
    // The editor strip goes with the tree it browses: both are paths into one sandbox's /work.
    resetWorkspaceTabs();
    resetTerminalOpen();
    // Path-keyed, and two sandboxes of the same project share every path, so this is stale, not just surplus,
    // without a reset.
    resetWorkspaceLive();
    // A staged push names commits in one workspace; offering to send them from another is the most consequential
    // item here.
    resetPushFlow();
    // Content-keyed and unbounded; the preview and its parked panel belong to one sandbox's app, so a switch is
    // where it's dropped.
    resetPreviewSurface();
};

watch(activeSandboxId, (id, previous) => {
    if (id === previous) {
        return;
    }
    resetWorkspaceScopedState();
    // The roster belongs to the daemon it came from; the new sandbox's stream repaints it on connect.
    resetPresence();
    // Not handled by liveness, which only clears the fleet on stream failure; a switch must reset it separately.
    resetAgents();
    // Also reset here, but not on stream failures; resetArchive's own comment says why.
    resetArchive();
});

// Reloads account status on first reachability, a reconnect, or a switch; activeSandboxId is watched too so a
// switch between two already-healthy boxes still fires it. Runs after the reset watch above.
watch([reachable, activeSandboxId], ([isReachable]) => {
    if (isReachable) {
        void loadAccountStatus();
        // Pull-only, rides the same seam: a reachable daemon may have archived agents itself since the last read.
        void loadArchived();
    }
});

// Held wakes are pull-only too, but reading them here doesn't work: the revision line moves twice on a switch
// (this reset, then the new hello), and a read fired between the two lands on a line nobody is on and is
// discarded. That read belongs after the hello, in systemEvents.
