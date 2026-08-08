<script setup lang="ts">
import type { DeployServer } from "./contract";
import { Icon, StatusBadge } from "@intentic/extension-ui";
import { computed } from "vue";
import { gaugeTone, SERVER_TONE } from "./stateVisual";

/* What one host says about itself: its state, its three gauges, and the way through to Komodo's own page for
 * it. One component because it appears twice — above the rows of a host that carries something, and as the
 * whole row of a host that carries nothing — and a host has to read identically in both.
 *
 * The gauges ride ListServers' own `info.stats`, so they cost nothing extra, and they are here rather than
 * hidden behind a click because a full disk explains a large share of deployment failures and is invisible
 * from the container's own status line. */

const { server } = defineProps<{ server: DeployServer }>();

const tone = computed(() => SERVER_TONE[server.state]);
const gauges = computed(() =>
    [
        { label: `cpu`, value: server.cpuPercent },
        { label: `mem`, value: server.memPercent },
        { label: `disk`, value: server.diskPercent },
    ].flatMap((gauge) => (gauge.value === undefined ? [] : [{ label: gauge.label, value: gauge.value }])),
);
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusBadge :variant="tone.variant" :label="tone.label" size="xs" dot />
        <span v-for="gauge in gauges" :key="gauge.label" class="flex items-center gap-1.5">
            <span class="text-2xs text-subtle">{{ gauge.label }}</span>
            <span class="h-1.5 w-12 overflow-hidden rounded-full bg-line">
                <span class="block h-full rounded-full" :class="gaugeTone(gauge.value)" :style="{ width: `${gauge.value}%` }"></span>
            </span>
            <span class="text-2xs text-subtle">{{ gauge.value }}%</span>
        </span>
        <a :href="server.url" target="_blank" rel="noopener" class="flex items-center gap-1 text-2xs text-subtle hover:text-link">
            Komodo
            <Icon name="arrow-up-right" />
        </a>
    </div>
</template>
