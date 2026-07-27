<script setup lang="ts">
import { cmp } from "@intentic-app/ui";
import { computed } from "vue";
import { useEnvironment } from "../../composables/sandbox/useEnvironment";
import EnvironmentCard from "./EnvironmentCard.vue";

/* The Sandbox hub's "Environment" tab: the composed overlay Dockerfile (agent-proposed, owner-approved, applied
 * by a rebuild). EnvironmentCard self-hides until there's an overlay or a proposal, so this tab adds the
 * empty-state for a sandbox that has neither yet. */

const { proposal, pending, applied } = useEnvironment();
const empty = computed(() => !proposal.value && !pending.value && !applied.value);
</script>

<template>
    <EnvironmentCard />
    <div v-if="empty" :class="cmp.emptyState('py-10')">
        No environment changes yet. When the agent proposes a change to the sandbox image's overlay, its diff appears here to review and rebuild.
    </div>
</template>
