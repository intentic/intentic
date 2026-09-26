<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { Meter, ui } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useSandboxReadout } from "./sandboxFigures";

// The panel the board's metrics segment opens above its status bar: every figure the bar leaves out, grouped by
// what it answers. The gauges again with their capacity, then the machine's other readings, then which kinds of process
// hold the memory, one kind a row with the small ones folded (sandboxFigures.ts decides which), since a row of
// side-by-side kinds reads as a puzzle rather than a list. Every figure explains itself on hover, since "load" or
// "pressure" is a number only a reader who already knows it can read bare. Its heading is the status bar panel's header
// (BoardStatusBar.vue).

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);

// Folded until asked for, and for as long as the panel stays open.
const smallOpen = ref(false);
const shownRoles = computed(() => (smallOpen.value ? [...readout.value.roles, ...readout.value.smallRoles] : readout.value.roles));
</script>

<template>
    <div class="flex flex-wrap items-start gap-x-8 gap-y-3 pt-1">
        <!-- The figures that run out, each a meter: its fill says how close, its track the rest of the room. -->
        <div role="group" data-section="gauges" class="flex w-44 shrink-0 flex-col gap-2.5">
            <div v-for="gauge in readout.gauges" :key="gauge.key" v-tooltip.left="gauge.hint" data-figure class="flex cursor-help flex-col gap-1">
                <div class="flex items-baseline gap-2 text-2xs">
                    <span class="shrink-0 text-muted">{{ gauge.label }}</span>
                    <span class="ml-auto truncate tabular-nums" :class="gauge.warn ? `text-warning` : `text-content`">{{ gauge.detail }}</span>
                </div>
                <Meter :value="gauge.fraction" :tone="gauge.warn ? `warning` : `accent`" :label="gauge.label" :valuetext="gauge.detail" />
            </div>
        </div>

        <dl
            role="group"
            data-section="figures"
            class="grid w-72 shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-2xs"
        >
            <template v-for="figure in readout.figures" :key="figure.key">
                <dt v-tooltip.left="figure.hint" class="cursor-help text-muted">{{ figure.label }}</dt>
                <dd
                    class="truncate text-right tabular-nums"
                    :class="figure.warn ? `text-warning` : `text-content`"
                    v-tooltip.bottom.overflow="figure.value"
                >
                    {{ figure.value }}
                </dd>
            </template>
        </dl>

        <!-- One kind a row, so the eye runs down names and sizes alike; the small kinds fold behind a line that sums them. -->
        <div v-if="readout.roles.length > 0" role="group" data-section="roles" class="flex w-72 shrink-0 flex-col gap-1.5">
            <h4 v-tooltip.left="t(`agents.liveMetrics.rolesHint`)" :class="ui.sectionLabelSm(`cursor-help self-start`)">
                {{ t(`agents.liveMetrics.rolesLabel`) }}
            </h4>
            <div
                v-for="role in shownRoles"
                :key="role.key"
                data-figure
                class="grid grid-cols-[minmax(0,8rem)_minmax(1.5rem,1fr)_4.5rem] items-center gap-2 text-2xs"
            >
                <span class="truncate text-muted">{{ role.label }}</span>
                <Meter :value="role.share" />
                <span class="text-right whitespace-nowrap tabular-nums text-content">{{ role.value }}</span>
            </div>
            <button
                v-if="readout.smallRoles.length > 0"
                type="button"
                data-small-roles
                :class="ui.textAction(`flex items-center gap-1 self-start text-2xs text-subtle`)"
                :aria-expanded="smallOpen"
                @click="smallOpen = !smallOpen"
            >
                <Icon :name="smallOpen ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs" />
                {{
                    smallOpen
                        ? t(`agents.liveMetrics.smallRolesHide`)
                        : t(
                              `agents.liveMetrics.smallRoles`,
                              { count: readout.smallRoles.length, size: formatBytes(readout.smallRolesBytes) },
                              readout.smallRoles.length,
                          )
                }}
            </button>
        </div>
    </div>
</template>
