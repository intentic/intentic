<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useEnvironment } from "../composables/sandbox/useEnvironment";
import { useSandboxVersion } from "../composables/sandbox/useSandboxVersion";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { showOutageGate } from "../composables/sandbox/connection";
import { useSandboxSession } from "../composables/sandbox/sandboxSession";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../composables/workspace/useWorkspaceTree";
import SandboxConnecting from "./SandboxConnecting.vue";
import SandboxUnauthorized from "./SandboxUnauthorized.vue";
import SandboxWarming from "./SandboxWarming.vue";
import { daemonReady } from "../composables/sandbox/useDaemonBoot";

/* The sandbox-readiness gates + global banners, shared by both shells (desktop grid, mobile tabs): the
 * pre-bind account-mismatch nudge, the denied (403) and connecting gates, and the environment action banner.
 * Renders the slot — the live view — only for a reachable daemon, so a not-ready (or just-switched-to)
 * sandbox never presents dead controls or another sandbox's data. Multi-root on purpose: the host's <main>
 * provides the flex column and the positioning context for the absolute mismatch bar. */

const { user } = useAuth();
const { clearCredential } = useGoogleIdentity();
const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();
const { reachable, connection } = useSandbox();
// The daemon answered and refused this Google account (403) — its own screen, distinct from every reason the
// daemon simply didn't answer. Read off the failure's tag rather than a separate sticky boolean.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
// A SUSTAINED failure (or a blocked one), as opposed to one blip the next attempt heals. This is what decides
// whether a hydrated cache may keep painting: a sandbox that is merely slow — or briefly starved under its
// own builds — deserves the stale view; one that is positively down must not look operable (connection.ts
// showOutageGate owns the line between the two).
const outage = computed(() => showOutageGate(connection.value));
// The daemon answered and is still converging its boot chain — reachable, and unable to serve a single data
// route until it finishes (useDaemonBoot). Its own gate, ahead of the hydrated-cache paint below, because this
// is the one unreachable-ish state a stale paint actively harms: everything it renders is operable-LOOKING and
// every request it makes parks. `phase === online` rather than `reachable`, which this very fact gates.
const warming = computed(() => connection.value.phase === `online` && !daemonReady.value);
// A hydrated (IndexedDB-restored) tree marks the sandbox as previously visited: paint it stale-while-
// revalidate instead of the connecting gate; the SSE connect refetches everything the moment it lands.
const { tree } = useWorkspaceTree();
// The sandbox's environment overlay: a pending rebuild or an unreviewed agent proposal is otherwise buried on
// the /sandbox hub (no rail tile), so surface it as a global bar with a one-click route to where it's handled.
const { pending: envPending, proposal: envProposal } = useEnvironment();
// A newer sandbox image (optional, non-blocking): a gentle, dismissible nudge to /sandbox. Lower priority than
// the env-rebuild bar — only shown when no env action is pending, so at most one bar competes for attention.
const { bannerVisible: versionUpdateVisible, dismiss: dismissVersionUpdate } = useSandboxVersion();

// Pre-check: the browser holds both the platform account email and the identity it presents to the daemon
// (useSandboxSession). Before the daemon binds (the pre-bind window: not yet reachable, not yet 403), warn if
// they differ so the wrong account never silently becomes owner. Suppressed once denied (the "no access"
// screen names both) and once reachable (a reachable mismatch is a legit member on a second Google identity).
const accountMismatch = computed(
    () =>
        user.value?.email !== undefined &&
        presentedEmail.value !== undefined &&
        user.value.email.toLowerCase() !== presentedEmail.value.toLowerCase(),
);
const switchAccount = (): void => {
    clearCredential();
    invalidateSession();
    void getSessionToken();
};
</script>

<template>
    <div
        v-if="accountMismatch && !denied && !reachable"
        class="absolute inset-x-0 top-0 z-10 m-3 flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
        <Icon name="exclamation-triangle" />
        <span class="min-w-0 flex-1">
            You're signed into Google as <span class="font-medium">{{ presentedEmail }}</span
            >, but your intentic account is <span class="font-medium">{{ user?.email }}</span
            >.
        </span>
        <button type="button" class="shrink-0 font-medium underline underline-offset-2 hover:no-underline" @click="switchAccount">
            Switch account
        </button>
    </div>
    <SandboxUnauthorized v-if="denied" />
    <!-- A daemon still converging its boot: ALWAYS its own screen, cached tree or not. The stale paint below
         exists to ride out a sandbox that is slow to answer; a warming one answers instantly and refuses
         everything, which the paint would present as a working workspace. -->
    <SandboxWarming v-else-if="warming" />
    <!-- Cached paint while connecting is unresolved OR through a short blip: only a sustained/blocked failure
         falls back to the full gate, so a dead sandbox (cleanup.sh, stopped container) never renders an
         operable-looking workspace for more than the couple of attempts that prove it dead. -->
    <SandboxConnecting v-else-if="!reachable && (tree.length === 0 || outage)" />
    <template v-else>
        <!-- The sandbox environment needs owner action that lives on the Sandbox ▸ Environment tab — surface it
             everywhere, since that hub has no rail tile. Rebuild takes priority over an unreviewed proposal. -->
        <RouterLink
            v-if="envPending || envProposal"
            to="/sandbox/environment"
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
