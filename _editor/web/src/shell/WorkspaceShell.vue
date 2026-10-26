<script setup lang="ts">
import { loadChunk, useDevice } from "@intentic/ui";
import { computed, defineAsyncComponent, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { watchAgentsScope } from "../models/fleet/board/agentsTile";
import { watchDeviceReturns } from "../features/sandbox/devices/useDeviceReturns";
import { useExtensionHost } from "../extension-host/useExtensionHost";
import { useMainWindow } from "../workbench/window/mainWindow";
import { openInWorkspace, openWorkspaceRef } from "../models/workspace/files/openFileRef";
import { openBrowsersBeside } from "../workbench/browsers/browsersSurface";
import { parseTabKey } from "../workbench/browsers/browsersPaths";
import { revealSideView } from "../workbench/side/sideViews";
import { prefetchViewsAtIdle } from "./prefetch/prefetch";
import { useChat } from "../models/conversations/run/useChat";
import { mobileChatPath } from "../lib/routes/phoneScreens";
import { useGuestFence } from "./guestFence";
import SkipToContent from "./SkipToContent.vue";
import { markBoot } from "../app/perf/boot";
import {
    ADD_SANDBOX_HOME_PATH,
    ADD_SANDBOX_QUERY,
    ADD_SANDBOX_VALUE,
    addSandboxAsked,
    askAddSandbox,
    closeAddSandbox,
    useAddsOnHome,
} from "../models/sandbox/addSandbox";
import { newSandboxBusy, newSandboxGeneration, newSandboxShownBy } from "../features/home/newSandbox/newSandbox";
import { useAuth } from "../client/auth/useAuth";
import { signInAt } from "../lib/routes/signIn";
import { loadShellDesktop, loadShellMobile } from "./shellChunks";

// Persistent post-login chrome, split by form factor: ShellDesktop (rail, side panel, terminal) under a
// pointer, ShellMobile (a rail on the board, full-screen views) below 768px. State lives in module composables, so
// the breakpoint swap doesn't restart it; liveness and the panels mount above the router (WorkspaceRuntime.vue).

const ShellDesktop = defineAsyncComponent(() => loadChunk(loadShellDesktop));
const ShellMobile = defineAsyncComponent(() => loadChunk(loadShellMobile));
// Fetched the first time somebody presses "Add sandbox", not with the shell.
const AddSandboxDialog = defineAsyncComponent(() => import(`../features/setup/add/AddSandboxDialog.vue`));
// Home's new sandbox's run, fetched the first time Home is asked for one (features/home/newSandbox/newSandbox.ts).
const NewSandboxHost = defineAsyncComponent(() => import(`../features/home/newSandbox/NewSandboxHost.vue`));

const { mobile } = useDevice();
// Boot installed third-party extensions once the sandbox is reachable (idempotent across shell remounts).
useExtensionHost();
// A guest is kept to the screens the daemon answers it on.
useGuestFence();
// Keeps other sandboxes live while the board's scope is wide; shared so both chromes need only one poll.
watchAgentsScope();
// Answers an agent update's wait once the machine is read back on its new agent, whichever screen is open by then.
watchDeviceReturns();
// Pulls every view's chunk in the background once the shell is up (idempotent); see shell/prefetch/prefetch.ts.
onMounted(prefetchViewsAtIdle);
onMounted(() => markBoot(`shell`));
const router = useRouter();
const route = useRoute();
const { user } = useAuth();

// Runs an errand a popped-out panel can't: opening a file, showing something beside, or taking a route. Announced only
// from here, since only a mounted shell can promise there's somewhere to put it (mainWindow.ts).
useMainWindow((errand) => {
    if (errand.kind === `file`) {
        void (errand.home === true ? openInWorkspace : openWorkspaceRef)(errand.path, errand.line, errand.scope);
    } else if (errand.kind === `browsers`) {
        openBrowsersBeside(router, errand.tab === undefined ? undefined : parseTabKey(errand.tab));
    } else if (errand.kind === `side`) {
        revealSideView(errand.view, errand.input, { keep: errand.keep });
    } else {
        void router.push(errand.path);
    }
});

// Route guards only fire on navigation, not a live resize, so growing past the breakpoint on a
// mobile-only page (menu, terminal) bounces to the workspace; shrinking off full-screen chat lands on the same
// conversation's phone screen, as the /chat guard would have.
watch(mobile, (isMobile) => {
    if (!isMobile && [`menu`, `terminal`].includes(String(route.name))) {
        void router.push(`/workspace`);
    }
    if (isMobile && route.name === `chat`) {
        void router.replace(mobileChatPath(useChat().active.value.conversationId));
    }
});

// THE ASK FOR A NEW SANDBOX AS AN ADDRESS: every press on a desktop (models/sandbox/addSandbox.ts), the desktop app's
// folder window handing its "Add sandbox" here (switcherPlace.ts), a sign-in coming back. On a desktop it is Home's own
// address while the new sandbox's dialog or page is up, so it stays, and anywhere else it is taken to Home. Where there is no Home
// to make it on, the dialog opens over the workspace and the address loses its ask, so a reload does not raise it again.
// Signed out, the ask waits in the address for the sign-in; in the desktop app that sign-in is a dialog over this same
// view (features/auth/signInDialog.ts), so the account arriving is what answers it, not a navigation.
const addsOnHome = useAddsOnHome();
watch(
    () => [route.query[ADD_SANDBOX_QUERY], route.name, mobile.value, user.value !== null] as const,
    ([value, name, _mobile, signedIn]) => {
        if (value !== ADD_SANDBOX_VALUE) {
            return;
        }
        if (!signedIn) {
            void router.replace(signInAt(ADD_SANDBOX_HOME_PATH));
            return;
        }
        if (addsOnHome()) {
            if (name !== `home`) {
                void router.replace(ADD_SANDBOX_HOME_PATH);
            }
            return;
        }
        askAddSandbox();
        const { [ADD_SANDBOX_QUERY]: _asked, ...rest } = route.query;
        void router.replace({ query: rest });
    },
    { immediate: true },
);
// The new sandbox's run is held here, above Home, so another tile pressed or a sandbox entered meanwhile leaves it going;
// a fresh host for each run, and none once a run has ended and Home no longer asks for one.
const newSandboxHosted = computed(() => user.value !== null && (newSandboxBusy.value || (!mobile.value && newSandboxShownBy(route))));

// A dead sandbox no longer bounces the shell to /setup, which now only creates a new one.
// SandboxSwitcher and the liveness probe handle switching or adding one instead.
</script>

<template>
    <SkipToContent />
    <ShellMobile v-if="mobile" />
    <ShellDesktop v-else />
    <AddSandboxDialog v-if="addSandboxAsked" @close="closeAddSandbox" />
    <NewSandboxHost v-if="newSandboxHosted" :key="newSandboxGeneration" />
</template>
