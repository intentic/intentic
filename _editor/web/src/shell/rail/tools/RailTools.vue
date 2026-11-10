<!-- THE FOLDED RAIL'S TOOLS, over the account (ShellDesktop.vue): what the sandbox is running, where the status bar used to
     say it (runtimeChips.ts). The terminal and Browsers sit last and always, so they never move; a standing state (a port
     open to the internet, a tunnel up, the sandbox near a limit) is a tile above them only while it holds, and the foot
     grows upward from them, so nothing else on the rail moves either. Each belongs to this one sandbox, so when the rail
     unrolls onto every sandbox they fly into the bookmark with its sections (`data-rail-into`, railMorph.ts) and back out
     when it folds. -->
<script setup lang="ts">
import { computed, inject } from "vue";
import { here } from "../../../lib/routes/links";
import { LIVE_METRICS_KEY } from "../../../models/sandbox/liveMetrics";
import MetricsAlertTile from "./MetricsAlertTile.vue";
import type { RuntimeChip } from "./runtimeChips";
import ToolTile from "./ToolTile.vue";
import { useRuntimeChips } from "./useRuntimeChips";

const { chips, toggleTerminal, reachable } = useRuntimeChips();
// The shell's one reading of the geek metrics (ShellDesktop.vue), undefined while they are off.
const metrics = inject(LIVE_METRICS_KEY, undefined);
const FIXED = new Set([`terminal`, `browsers`]);
// The standing states first, the fixed pair last: the column is bottom-anchored, so what comes and goes is on top.
const ordered = computed(() => [...chips.value.filter((chip) => !FIXED.has(chip.id)), ...chips.value.filter((chip) => FIXED.has(chip.id))]);

// A count is a grey dot, a standing state its own tone; the number itself is the hover card's.
const dotOf = (chip: RuntimeChip): `live` | `warning` | `success` | undefined => chip.tone ?? (chip.count === undefined ? undefined : `live`);
</script>

<template>
    <MetricsAlertTile v-if="metrics !== undefined" :metrics="metrics" />
    <ToolTile
        v-for="chip in ordered"
        :key="chip.id"
        :section="chip.id"
        :aria="chip.aria"
        :tip="chip.tip ?? chip.label"
        :to="chip.to === undefined ? undefined : here(chip.to)"
        :active="chip.active"
        :dot="dotOf(chip)"
        :inert="chip.to === undefined && !reachable"
        :rail-key="`tool:${chip.id}`"
        rail-into="sections"
        @press="toggleTerminal"
    />
</template>
