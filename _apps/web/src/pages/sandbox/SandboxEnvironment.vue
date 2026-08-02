<script setup lang="ts">
import { cmp } from "@intentic/ui";
import { computed } from "vue";
import { useEnvironment } from "../../composables/sandbox/useEnvironment";
import BundleCard from "./BundleCard.vue";
import EnvironmentCard from "./EnvironmentCard.vue";

/* The Sandbox hub's "Environment" tab: the composed overlay Dockerfile (agent-proposed, owner-approved, applied
 * by a rebuild), and below it the bundle card that moves the whole environment to another sandbox. The two
 * belong together — a restored bundle's last step IS the rebuild the card above hands you, because the overlay
 * travels as a recipe and the image it describes does not. EnvironmentCard self-hides until there's an overlay
 * or a proposal, so this tab adds the empty-state for a sandbox that has neither yet. */

const { proposal, pending, applied } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);
</script>

<template>
    <div class="flex flex-col gap-4">
        <EnvironmentCard />
        <div v-if="empty" :class="cmp.emptyState('py-10')">
            No environment changes yet. When the agent proposes a change to the sandbox image's overlay, its diff appears here to review and rebuild.
        </div>
        <BundleCard />
    </div>
</template>
