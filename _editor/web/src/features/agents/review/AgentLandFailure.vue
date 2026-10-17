<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { landFailure, retryLand } from "../../../models/agent-status/agentStatus-attention";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";

// A land that broke, under the detail's header in the reader's words, with Retry only where trying again can help (a
// runner that stopped mid-land, retryLand) and the reader may ship.
const props = defineProps<{ readonly agent: FleetAgent; readonly canShip: boolean; readonly busy: boolean }>();
const emit = defineEmits<{ retry: [] }>();
const t = useT();
const line = computed(() => landFailure(props.agent));
</script>

<template>
    <div v-if="line !== undefined" class="mx-2 mt-2 flex items-center gap-2 text-xs text-danger" v-tooltip.bottom="line">
        <span class="min-w-0 flex-1">{{ t(`agents.agentStatus.couldntLand`, { reason: line }) }}</span>
        <Button v-if="canShip && retryLand(agent)" size="small" tier="boring" :disabled="busy" @click="emit('retry')">{{ t(`ui.action.retry`) }}</Button>
    </div>
</template>
