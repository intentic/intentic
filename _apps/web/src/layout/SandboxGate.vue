<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useEnvironment } from "../composables/sandbox/useEnvironment";
import { useSandboxVersion } from "../composables/sandbox/useSandboxVersion";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandbox } from "../composables/useSandbox";
import { useWorkspaceTree } from "../composables/workspace/useWorkspaceTree";
import SandboxConnecting from "./SandboxConnecting.vue";
import SandboxUnauthorized from "./SandboxUnauthorized.vue";

/* The sandbox-readiness gates + global banners, shared by both shells (desktop grid, mobile tabs): the
 * pre-bind account-mismatch nudge, the denied (403) and connecting gates, and the environment action banner.
 * Renders the slot — the live view — only for a reachable daemon, so a not-ready (or just-switched-to)
 * sandbox never presents dead controls or another sandbox's data. Multi-root on purpose: the host's <main>
 * provides the flex column and the positioning context for the absolute mismatch bar. */

const { user } = useAuth();
const { signedInEmail, clearCredential, getIdToken } = useGoogleIdentity();
const { reachable, denied, probeError } = useSandbox();
// A hydrated (IndexedDB-restored) tree marks the sandbox as previously visited: paint it stale-while-
// revalidate instead of the connecting gate; the SSE connect refetches everything the moment it lands.
const { tree } = useWorkspaceTree();
// The sandbox's environment overlay: a pending rebuild or an unreviewed agent proposal is otherwise buried on
// the /sandbox hub (no rail tile), so surface it as a global bar with a one-click route to where it's handled.
const { pending: envPending, proposal: envProposal } = useEnvironment();
// A newer sandbox image (optional, non-blocking): a gentle, dismissible nudge to /sandbox. Lower priority than
// the env-rebuild bar — only shown when no env action is pending, so at most one bar competes for attention.
const { bannerVisible: versionUpdateVisible, dismiss: dismissVersionUpdate } = useSandboxVersion();

// Pre-check: the browser holds both the platform account email and the Google identity it presents to the
// daemon. Before the daemon binds (the pre-bind window: not yet reachable, not yet 403), warn if they differ
// so the wrong account never silently becomes owner. Suppressed once denied (the "no access" screen names both)
// and once reachable (a reachable mismatch is a legit member on a second Google identity — not an error).
const accountMismatch = computed(
    () =>
        user.value?.email !== undefined && signedInEmail.value !== undefined && user.value.email.toLowerCase() !== signedInEmail.value.toLowerCase(),
);
const switchAccount = (): void => {
    clearCredential();
    void getIdToken();
};
</script>

<template>
    <div
        v-if="accountMismatch && !denied && !reachable"
        class="absolute inset-x-0 top-0 z-10 m-3 flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
        <Icon name="exclamation-triangle" />
        <span class="min-w-0 flex-1">
            You're signed into Google as <span class="font-medium">{{ signedInEmail }}</span
            >, but your intentic account is <span class="font-medium">{{ user?.email }}</span
            >.
        </span>
        <button type="button" class="shrink-0 font-medium underline underline-offset-2 hover:no-underline" @click="switchAccount">
            Switch account
        </button>
    </div>
    <SandboxUnauthorized v-if="denied" />
    <!-- Cached paint only while connecting is unresolved: the moment an attempt fails (probeError), fall back
         to the full gate so a dead sandbox (cleanup.sh, stopped container) never renders an operable-looking
         workspace. -->
    <SandboxConnecting v-else-if="!reachable && (tree.length === 0 || probeError !== undefined)" />
    <template v-else>
        <!-- The sandbox environment needs owner action that lives on /sandbox — surface it everywhere, since
             that hub has no rail tile. Rebuild takes priority over an unreviewed proposal. -->
        <RouterLink
            v-if="envPending || envProposal"
            to="/sandbox"
            class="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning hover:bg-warning/15"
        >
            <Icon name="exclamation-triangle" />
            <span class="min-w-0 flex-1">
                <template v-if="envPending">Your sandbox needs a quick rebuild to finish setting up your new capabilities.</template>
                <template v-else>The agent proposed a change to your sandbox environment — review it.</template>
            </span>
            <span class="shrink-0 font-medium underline underline-offset-2">{{ envPending ? "Show me how" : "Review" }} →</span>
        </RouterLink>
        <!-- Lower priority than the env bar (v-else-if), so only one competes for attention. Optional + non-
             blocking, so muted (not warning) chrome and a dismiss ×; a newer release re-shows it (per-version). -->
        <div
            v-else-if="versionUpdateVisible"
            class="flex shrink-0 items-center gap-3 border-b border-line bg-overlay/60 px-4 py-2 text-xs text-muted"
        >
            <Icon name="arrow-circle-up" />
            <RouterLink to="/sandbox" class="min-w-0 flex-1 hover:text-content">
                A new sandbox version is available — update when convenient.
                <span class="font-medium underline underline-offset-2">Show me how →</span>
            </RouterLink>
            <button type="button" aria-label="Dismiss" class="shrink-0 hover:text-content" @click="dismissVersionUpdate">
                <Icon name="times" />
            </button>
        </div>
        <slot />
    </template>
</template>
