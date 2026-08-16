<script setup lang="ts">
import { computed } from "vue";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { sandboxRequiresGate } from "../composables/sandbox/availability";
import { useSandboxAvailability } from "../composables/sandbox/useSandboxAvailability";
import { useSandboxSession } from "../composables/sandbox/sandboxSession";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../composables/workspace/useWorkspaceTree";
import SandboxConnecting from "./SandboxConnecting.vue";
import SandboxBusy from "./SandboxBusy.vue";
import SandboxUnauthorized from "./SandboxUnauthorized.vue";
import SandboxWarming from "./SandboxWarming.vue";

/* The sandbox-readiness gates, shared by both shells (desktop grid, mobile tabs): the pre-bind
 * account-mismatch nudge, and the denied (403) / warming / connecting gates. Once this sandbox has a cached
 * workspace snapshot, transient failures leave the live view mounted and only exact reachability gates its
 * daemon actions. Multi-root on purpose: the host's <main> provides the flex column and the positioning
 * context for the absolute mismatch bar.
 *
 * Every one of these is a GATE: the view behind it is unusable, which is what earns an interruption. The
 * sandbox's non-blocking errands (rebuild, proposal, secrets, a new release) used to ride here as bars too —
 * they now badge the rail's sandbox chip, where a standing condition belongs. The mismatch nudge stays because
 * it fires in the pre-bind window, before there is a bound sandbox for a chip to be about. */

const { user } = useAuth();
const { clearCredential } = useGoogleIdentity();
const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();
const { reachable, connection } = useSandbox();
// The daemon answered and refused this Google account (403) — its own screen, distinct from every reason the
// daemon simply didn't answer. Read off the failure's tag rather than a separate sticky boolean.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
// A hydrated (IndexedDB-restored) tree marks the sandbox as previously visited: paint it stale-while-
// revalidate instead of the connecting gate; the SSE connect refetches everything the moment it lands.
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const gated = computed(() => sandboxRequiresGate(reachable.value, hasSnapshot.value, availability.value));

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
    <!-- A first connection whose daemon is still converging has no workspace to paint yet. An established
         workspace stays mounted through the same warm-up, with its exact live actions still disabled. -->
    <SandboxWarming v-else-if="gated && availability === `warming`" />
    <!-- A gate is for a workspace that has never painted, or a cause waiting cannot repair. Once a snapshot
         exists, transient transport loss leaves the real DOM mounted indefinitely: retry velocity says nothing
         about whether the user's workspace stopped being useful. -->
    <SandboxConnecting v-else-if="gated" />
    <template v-else>
        <!-- Delayed and non-modal: ordinary load stalls heal before this exists, while a sustained one gets one
             calm sentence without erasing the context the reader was in. -->
        <SandboxBusy v-if="availability === `busy`" />
        <slot />
    </template>
</template>
