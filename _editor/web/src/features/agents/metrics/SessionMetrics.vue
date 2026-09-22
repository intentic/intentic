<script setup lang="ts">
import { formatBytes, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import { LIVE_METRICS_KEY } from "./liveMetrics";

// One conversation's line of the board's geek metrics: what its processes use. Draws nothing unless the board provides
// a reading that names this conversation, which is also why a card never starts a read of its own.

const t = useT();

const props = defineProps<{
    conversationId: string;
}>();

const metrics = inject(LIVE_METRICS_KEY, undefined);

// A string, so this leaf redraws only when what it says changes rather than on every reading the board takes.
const line = computed<string | undefined>(() => {
    const session = metrics?.value?.sessions[props.conversationId];
    if (session === undefined) {
        return undefined;
    }
    return [
        ...(session.cpuPercent === undefined ? [] : [t(`agents.liveMetrics.cpu`, { percent: formatPercent(session.cpuPercent) })]),
        formatBytes(session.rssBytes),
        t(`agents.liveMetrics.processes`, { count: session.processes }, session.processes),
    ].join(` · `);
});
</script>

<template>
    <p
        v-if="line !== undefined"
        v-tooltip.top="t(`agents.liveMetrics.sessionHint`)"
        class="flex min-w-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-subtle"
    >
        <Icon name="cpu" class="shrink-0 text-2xs" />
        <span class="truncate">{{ line }}</span>
    </p>
</template>
