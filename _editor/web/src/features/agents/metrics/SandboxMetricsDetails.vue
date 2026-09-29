<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { Meter, type Tip, ui } from "@intentic/ui";
import { formatBytes, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { agentDisplayTitle } from "../fleet/agentStatus";
import { useAgents } from "../fleet/useAgents";
import { openById } from "../fleet/useAgents-actions";
import { HEAVY_SESSION_SHARE } from "./liveMetrics";
import { useSandboxReadout } from "./sandboxFigures";

// The panel the board's metrics segment opens above its status bar: every figure the bar leaves out, grouped by
// what it answers. The gauges again with their capacity, then the machine's other readings, then which kinds of process
// hold the memory, one kind a row with the small ones folded (sandboxFigures.ts decides which), since a row of
// side-by-side kinds reads as a puzzle rather than a list. Last, which conversations hold it, heaviest first: where the
// memory went, in one look rather than a scan across every card, and each row opens its conversation, so the one eating
// the box is a press from being stopped. Every figure explains itself on hover, since "load" or "pressure" is a number
// only a reader who already knows it can read bare; a figure past its limit wears the warning dot there too. Its heading
// is the status bar panel's header (BoardStatusBar.vue).

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

const readout = useSandboxReadout(() => props.metrics);
const warned = (hint: Tip, warn: boolean): Tip => (warn ? { ...hint, tone: `warn` } : hint);

// The two lists' headings, each read on hover as what its bars measure.
const rolesTip = computed((): Tip => ({ title: t(`agents.liveMetrics.rolesLabel`), note: t(`agents.liveMetrics.rolesNote`) }));
const sessionsTip = computed(
    (): Tip => ({
        title: t(`agents.liveMetrics.sessionsLabel`),
        rows: [
            { label: t(`agents.liveMetrics.cpuLabel`), value: t(`agents.liveMetrics.cpuPerCore`) },
            { label: t(`agents.liveMetrics.tinted`), value: t(`agents.liveMetrics.tintAt`, { percent: formatPercent(HEAVY_SESSION_SHARE * 100) }) },
        ],
        note: t(`agents.liveMetrics.pressToOpen`),
    }),
);

// Folded until asked for, and for as long as the panel stays open.
const smallOpen = ref(false);
const shownRoles = computed(() => (smallOpen.value ? [...readout.value.roles, ...readout.value.smallRoles] : readout.value.roles));
const moreSessionsOpen = ref(false);
const shownSessions = computed(() =>
    moreSessionsOpen.value ? [...readout.value.sessions, ...readout.value.smallSessions] : readout.value.sessions,
);

// A conversation as its card names it; one the board carries no card for (archived, another reader's) by its id.
const { agentById } = useAgents();
const titleOf = (id: string): string => {
    const agent = agentById(id);
    return agent === undefined ? id : agentDisplayTitle(agent);
};
const open = (id: string): void => {
    const agent = agentById(id);
    openById(id, agent === undefined ? undefined : agentDisplayTitle(agent));
};
</script>

<template>
    <div class="flex flex-wrap items-start gap-x-8 gap-y-3 pt-1">
        <!-- The figures that run out, each a meter: its fill says how close, its track the rest of the room. -->
        <div role="group" data-section="gauges" class="flex w-44 shrink-0 flex-col gap-2.5">
            <div v-for="gauge in readout.gauges" :key="gauge.key" v-tooltip.left="warned(gauge.hint, gauge.warn)" data-figure class="flex cursor-help flex-col gap-1">
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
                <dt v-tooltip.left="warned(figure.hint, figure.warn)" class="cursor-help text-muted">{{ figure.label }}</dt>
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
            <h4 v-tooltip.left="rolesTip" :class="ui.sectionLabelSm(`cursor-help self-start`)">
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

        <!-- One conversation a row, its memory against the heaviest's and its CPU beside it; tinted when it holds a
             quarter of the box. Its title opens it; its whole reading is on hover. -->
        <div v-if="readout.sessions.length > 0" role="group" data-section="sessions" class="flex w-80 shrink-0 flex-col gap-1.5">
            <h4 v-tooltip.left="sessionsTip" :class="ui.sectionLabelSm(`cursor-help self-start`)">
                {{ t(`agents.liveMetrics.sessionsLabel`) }}
            </h4>
            <div
                v-for="session in shownSessions"
                :key="session.key"
                data-figure
                class="grid grid-cols-[minmax(0,1fr)_minmax(1.5rem,3rem)_4.5rem_3rem] items-center gap-2 text-2xs"
            >
                <!-- The text's own height, not the recipe's tap target, so these rows keep the kinds' pitch beside them. -->
                <button
                    type="button"
                    :class="ui.textAction(`my-0 min-h-0 min-w-0 max-w-full text-2xs`)"
                    v-tooltip.top="session.tip"
                    @click="open(session.key)"
                >
                    <span class="truncate">{{ titleOf(session.key) }}</span>
                </button>
                <Meter :value="session.share" :tone="session.heavy ? `warning` : `accent`" />
                <span class="text-right whitespace-nowrap tabular-nums" :class="session.heavy ? `text-warning` : `text-content`">{{
                    session.value
                }}</span>
                <span class="text-right whitespace-nowrap tabular-nums text-muted">{{ session.cpu ?? `–` }}</span>
            </div>
            <button
                v-if="readout.smallSessions.length > 0"
                type="button"
                data-small-sessions
                :class="ui.textAction(`flex items-center gap-1 self-start text-2xs text-subtle`)"
                :aria-expanded="moreSessionsOpen"
                @click="moreSessionsOpen = !moreSessionsOpen"
            >
                <Icon :name="moreSessionsOpen ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs" />
                {{
                    moreSessionsOpen
                        ? t(`agents.liveMetrics.smallSessionsHide`)
                        : t(
                              `agents.liveMetrics.smallSessions`,
                              { count: readout.smallSessions.length, size: formatBytes(readout.smallSessionsBytes) },
                              readout.smallSessions.length,
                          )
                }}
            </button>
        </div>
    </div>
</template>
