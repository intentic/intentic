<script setup lang="ts">
import { computed } from "vue";
import type { AgentOrigin } from "@intentic/sandbox-contract";
import { originMeta } from "../features/agents/fleet/agentStatus";

/* "This conversation came in from outside": the one mark that tells an agent an automation opened for a Discord mention. */

const props = defineProps<{ origin?: AgentOrigin; compact?: boolean }>();

const meta = computed(() => (props.origin !== undefined ? originMeta(props.origin) : undefined));
</script>

<template>
<!-- The hint only in `compact`, where the glyph stands alone. -->
    <span
        v-if="meta !== undefined"
        v-tooltip.top="compact === true ? meta.hint : undefined"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        :aria-label="meta.hint"
    >
        <Icon :name="meta.icon" class="shrink-0 text-2xs" />
        <template v-if="compact !== true">
            <span class="shrink-0 font-medium">{{ meta.label }}</span>
            <template v-if="meta.detail !== undefined">
                <span>·</span>
                <span class="truncate">{{ meta.detail }}</span>
            </template>
        </template>
    </span>
</template>
