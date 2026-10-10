<script setup lang="ts">
import { formatBinaryBytes, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import { LIVE_METRICS_KEY, sessionHeavy } from "./liveMetrics";
import type { Tip } from "@intentic/ui";
import { sessionTip } from "./sandboxFigures";

// One conversation's share of the board's geek metrics, as one figure in its card's stats row beside its diff and cost:
// its memory and its CPU, the whole reading (processes too) on hover, tinted when it holds a quarter of the sandbox. A
// row of its own on every working card was the loudest line on the board; where the memory went across all of them is
// the metrics panel's list (SandboxMetricsDetails.vue). Draws nothing unless the board provides a reading that names
// this conversation, which is also why a card never starts a read of its own.

const t = useT();

const props = defineProps<{
    conversationId: string;
}>();

const metrics = inject(LIVE_METRICS_KEY, undefined);

// Strings and a flag, so this leaf redraws only when what it says changes rather than on every reading the board takes.
const figure = computed<{ readonly short: string; readonly hint: Tip; readonly heavy: boolean } | undefined>(() => {
    const reading = metrics?.value;
    const session = reading?.sessions[props.conversationId];
    if (reading === undefined || session === undefined) {
        return undefined;
    }
    return {
        short: [formatBinaryBytes(session.rssBytes), ...(session.cpuPercent === undefined ? [] : [formatPercent(session.cpuPercent)])].join(` · `),
        hint: sessionTip(t, session),
        heavy: sessionHeavy(session.rssBytes, reading.sandbox),
    };
});
</script>

<template>
    <span
        v-if="figure !== undefined"
        v-tooltip.top="figure.hint"
        data-session-metrics
        class="inline-flex min-w-0 items-center gap-1 font-mono tabular-nums"
        :class="figure.heavy ? `text-warning` : ``"
    >
        <Icon name="cpu" class="shrink-0 text-2xs" />
        <span class="truncate">{{ figure.short }}</span>
    </span>
</template>
