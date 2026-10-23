<script setup lang="ts">
import { Button, CopyButton, toneTint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { landFailure, retryLand } from "../../../../models/agent-status/agentStatus-attention";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// Keep Git's original details available when the short explanation cannot name the cause.
const props = defineProps<{ readonly agent: FleetAgent; readonly canShip: boolean; readonly busy: boolean; readonly canChat?: boolean }>();
const emit = defineEmits<{ retry: []; chat: [] }>();
const t = useT();
const line = computed(() => landFailure(props.agent));
const details = computed(() => props.agent.landFailure?.reason ?? props.agent.failure ?? ``);
</script>

<template>
    <div v-if="line !== undefined" :class="toneTint(`danger`, `soft`, `mx-2 mt-2 shrink-0 rounded-md border p-2.5 text-xs`)">
        <div class="flex flex-wrap items-center gap-2">
            <p role="status" class="min-w-0 flex-1 break-words text-danger">{{ t(`agents.agentStatus.couldntLand`, { reason: line }) }}</p>
            <Button v-if="canChat" size="small" tier="boring" @click="emit('chat')">{{ t(`agents.agentStatus.openChat`) }}</Button>
            <Button v-if="canShip && retryLand(agent)" size="small" tier="boring" :disabled="busy" @click="emit('retry')">{{ t(`ui.action.retry`) }}</Button>
        </div>
        <p v-if="agent.branch" class="mt-1 break-words text-2xs text-muted">{{ t(`agents.agentStatus.landWorkKept`, { branch: agent.branch }) }}</p>
        <details v-if="details" class="mt-2 text-2xs text-muted">
            <summary class="cursor-pointer rounded hover:text-content">{{ t(`agents.agentStatus.landDetails`) }}</summary>
            <div class="mt-1 flex justify-end"><CopyButton :text="details" :label="t(`ui.action.copy`)" /></div>
            <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas p-2 font-mono text-content">{{ details }}</pre>
        </details>
    </div>
</template>
