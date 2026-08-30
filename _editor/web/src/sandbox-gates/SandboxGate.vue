<script setup lang="ts">
import { computed } from "vue";
import { sandboxRequiresGate } from "../composables/sandbox/availability";
import { useSandboxAvailability } from "../composables/sandbox/useSandboxAvailability";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../composables/workspace/useWorkspaceTree";
import SandboxConnecting from "./SandboxConnecting.vue";
import SandboxUnauthorized from "./SandboxUnauthorized.vue";
import SandboxWarming from "./SandboxWarming.vue";

/* The sandbox-readiness gates, shared by both shells (desktop grid, mobile tabs): the denied (403) / warming /
 * connecting screens. Once this sandbox has a cached workspace snapshot, transient failures leave the live view
 * mounted and only exact reachability gates its daemon actions.
 *
 * EVERY ONE OF THESE IS A GATE — the view behind it is unusable, which is what earns replacing the screen. That
 * is now the only thing this file does. Two things that were NOT gates used to ride here and no longer do: the
 * pre-bind account-mismatch nudge and the "sandbox is busy" pill, both of which floated over a workspace that
 * still worked. Neither was ever a gate; each was a standing condition wearing a gate's clothes, and each drew
 * itself at a different absolute offset with a z-index of its own. They are declared as conditions now
 * (composables/notificationSources.ts) and drawn in the app's one notification lane, which is where a fact about
 * the session belongs. */

const { reachable, connection } = useSandbox();
// The daemon answered and refused this Google account (403): its own screen, distinct from every reason the
// daemon simply didn't answer. Read off the failure's tag rather than a separate sticky boolean.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
// A hydrated (IndexedDB-restored) tree marks the sandbox as previously visited: paint it stale-while-
// revalidate instead of the connecting gate; the SSE connect refetches everything the moment it lands.
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const gated = computed(() => sandboxRequiresGate(reachable.value, hasSnapshot.value, availability.value));
</script>

<template>
    <SandboxUnauthorized v-if="denied" />
    <!-- A first connection whose daemon is still converging has no workspace to paint yet. An established
         workspace stays mounted through the same warm-up, with its exact live actions still disabled. -->
    <SandboxWarming v-else-if="gated && availability === `warming`" />
    <!-- A gate is for a workspace that has never painted, or a cause waiting cannot repair. Once a snapshot
         exists, transient transport loss leaves the real DOM mounted indefinitely: retry velocity says nothing
         about whether the user's workspace stopped being useful. -->
    <SandboxConnecting v-else-if="gated" />
    <slot v-else />
</template>
