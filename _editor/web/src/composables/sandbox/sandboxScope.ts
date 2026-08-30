import { watch } from "vue";
import { loadArchived, resetAgents, resetArchive } from "../agents/useAgents";
import { loadAccountStatus, resetChat } from "../chat/useChat";
import { resetCodeStats } from "../workspace/useCodeStats";
import { resetEditBuffers } from "../workspace/useEditBuffers";
import { resetPreviewSurface } from "../preview/previewSurface";
import { resetPresence } from "../usePresence";
import { resetPushFlow } from "../workspace/usePushFlow";
import { useSandbox } from "./useSandbox";
import { resetTerminalOpen } from "../useLayout";
import { resetWorkspaceLive } from "../workspace/useWorkspaceLive";
import { resetWorkspaceTabs } from "../workspace/useWorkspaceTabs";
import { resetWorkspaceTreeState } from "../workspace/useWorkspaceTree";

/* One central place that re-scopes the browser's client-side state to the active sandbox. vue-query server
 * state is already scoped by sandboxKey (its keys carry the active id), but the module-level singletons,
 * chat, editor buffers, the shared file-action feedback, live outside the component tree and would otherwise
 * carry one sandbox's data onto the next. Reachable + the liveness stream are re-scoped in useSandboxLiveness.
 *
 * THREE SUBSYSTEMS RE-SCOPE THEMSELVES rather than being reset from here, and all three are named so a reader
 * looking for the whole picture finds it: the liveness stream (useSandboxLiveness, above), the BROWSER→SANDBOX
 * CREDENTIALS (sandboxSession, whose own watch settles a Google mint left parked for the outgoing sandbox, so
 * its sign-in gate cannot land over the incoming one), and the EXTENSION HOST (extension-host/useExtensionHost).
 * The last is not a tidiness call, an extension's state is not this app's to reset. What runs, what each one
 * has read and what its rail tile is claiming are answers belonging to the sandbox that was asked, so the host
 * retires every activation and empties the extensions' own scope (extension-api/scope.ts) before loading the
 * new box's list. Importing that chain from here would also close a cycle: the host reaches apiImpl, which
 * reaches most of these composables.
 *
 * This watch is registered at module scope (imported once from main.ts) rather than inside the shell on
 * purpose: the "add sandbox" flow changes the active sandbox while the shell is UNMOUNTED (on /setup), so a
 * shell-scoped watcher would miss exactly the switch that triggers the reported bug. A dedicated module also
 * avoids the useChat → sandboxClient → useSandbox import cycle. */

const { activeSandboxId, reachable } = useSandbox();

/* The /work-derived half of the reset, chat, edit buffers, tree, and the editor strip, everything whose
 * content names paths or conversations in ONE workspace. Shared with the hello's workspace-replaced handling
 * (systemEvents): a workspace wiped and recreated under the same sandbox id is, for this state, exactly a
 * switch, what it remembers names things that no longer exist, except the id never changed, so the watch
 * below can't be the one to notice. */
export const resetWorkspaceScopedState = (): void => {
    resetChat();
    resetEditBuffers();
    resetWorkspaceTreeState();
    // The editor strip goes with the tree it browses: both are paths into ONE sandbox's /work, and each sandbox
    // has its own snapshot to come back to.
    resetWorkspaceTabs();
    resetTerminalOpen();
    // What moved in /work and how recently, path-keyed, and two sandboxes of the same project share every path,
    // so this is stale rather than merely surplus: rows flashing for another box's edits, and a file viewer that
    // believes it already holds a version it has never read.
    resetWorkspaceLive();
    // Outgoing work: a staged push names commits in ONE workspace, and offering to send them from another is the
    // most consequential thing on this list.
    resetPushFlow();
    // Content-keyed, so never wrong, just unbounded. A switch is where it is worth letting go.
    resetCodeStats();
    // The preview shows ONE sandbox's app; the parked panel goes with the box, and the new box's own last
    // target comes back (a floating window survives, see resetPreviewSurface).
    resetPreviewSurface();
};

watch(activeSandboxId, (id, previous) => {
    if (id === previous) {
        return;
    }
    resetWorkspaceScopedState();
    // The roster belongs to the daemon it came from; the new sandbox's stream repaints it on connect.
    resetPresence();
    // Same for the fleet, and it can't be left to the liveness loop, which only clears it when a stream FAILS
    // and stands down entirely when the failure was this switch aborting it. What survived was not just stale
    // cards: the applied registry revision came along too, so an incoming daemon whose counter starts lower
    // (a fresh container, a restart) had every roster frame it sent dropped as out-of-order, leaving the
    // previous sandbox's agents on the board and its titles renaming this sandbox's tabs.
    resetAgents();
    // The archive half goes with it, but ONLY here, not on stream failures (see resetArchive on why).
    resetArchive();
});

// Account status lives on the daemon, so (re)load it whenever the ACTIVE daemon is reachable: first liveness
// success (initial page load), reconnects after an outage, and sandbox switches (the reset above just zeroed
// `connections`). activeSandboxId is in the source so a switch between two recently-healthy sandboxes, where
// liveness keeps `reachable` true and it never flips, still reloads. Registered after the reset watch so a
// switch resets before the reload fires.
watch([reachable, activeSandboxId], ([isReachable]) => {
    if (isReachable) {
        void loadAccountStatus();
        // The archive list rides the same seam: it is pull-only (the roster stream never carries it), and the
        // daemon that just (re)appeared may have filed agents away itself, its boot sweep archives entries
        // whose worktree vanished, its retention pass archives what aged out. Without this re-read, the
        // Finished header's count froze at whatever the last visit saw, a daemon restart away from reading 0
        // and hiding the archive door with every agent the user ever ran behind it.
        void loadArchived();
    }
});

/* HELD WAKES ARE PULL-ONLY TOO, but they are NOT read here, and the reason is worth writing down because this
 * is where they were tried first and it does not work.
 *
 * A roster read carries its epoch (useAgents), the revision line it was issued on, and drops its own answer
 * if that line has moved. On a switch the line moves TWICE: once for the reset above, and again for the new
 * stream's hello, which opens the new daemon's line. A read fired from this watch sits between the two, so its
 * answer arrives on a line nobody is on and is discarded by design. The badge then undercounted for the rest
 * of the session, which is a quieter version of the bug this whole file exists to prevent.
 *
 * So the read belongs after the hello, where the line is settled, and that is where it is: systemEvents. */
