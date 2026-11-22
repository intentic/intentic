<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId } from "vue";
import AccessMapNode from "./AccessMapNode.vue";
import { type AccountGraph, type GraphLighting, type GraphMachine, type GraphSandbox, type Standing, YOU_ID } from "./accountGraph";
import { drawLines, type Line } from "./accessMapDrawing";
import { useAccessLayout } from "./useAccessLayout";

// THE ACCESS MAP'S STAGE: the account on the left, the sandboxes it is in (and the ones met only through a link) in the
// middle, and the computers, phones, browsers, servers and cloud they reach on the right, with the lines between them
// drawn from where the cards landed (useAccessLayout, accessMapDrawing.ts). It only draws: what is in focus is the
// parent's, told back through `point` (undefined as the pointer leaves) and `press` (keep it lit). Below the width
// three columns need, the parent shows the same thing in words instead.

const t = useT();

const { graph, lighting, focus, pinned, now, picture } = defineProps<{
    graph: AccountGraph;
    lighting: GraphLighting | undefined;
    focus: string | undefined;
    pinned: string | undefined;
    now: number;
    picture?: string | null | undefined;
}>();
const emit = defineEmits<{ point: [id: string | undefined]; press: [id: string]; clear: [] }>();

// Wider gutters from here, for the lines to bend in; the columns stop growing at the third and the drawing centres.
const ROOMY_FROM = 900;
const WIDE_FROM = 1200;

const stage = ref<HTMLElement>();
const { width, layout } = useAccessLayout(stage, () => graph);
const ready = computed(() => layout.value.width > 0);
const columns = computed(() => {
    if (width.value >= WIDE_FROM) {
        return `grid-cols-[minmax(11rem,14rem)_minmax(15rem,20rem)_minmax(13rem,18rem)] justify-center gap-x-24`;
    }
    return width.value >= ROOMY_FROM
        ? `grid-cols-[minmax(10rem,13rem)_minmax(13rem,1fr)_minmax(12rem,16rem)] gap-x-16`
        : `grid-cols-[minmax(8.5rem,11rem)_minmax(11rem,1fr)_minmax(10rem,13rem)] gap-x-12`;
});

const STANDINGS: readonly { readonly standing: Standing; readonly label: () => string }[] = [
    { standing: `yours`, label: () => t(`settings.accessMap.yours`) },
    { standing: `shared`, label: () => t(`settings.accessMap.shared`) },
    { standing: `beyond`, label: () => t(`settings.accessMap.beyond`) },
];
const sandboxGroups = computed(() =>
    STANDINGS.map((group) => ({ ...group, sandboxes: graph.sandboxes.filter((sandbox: GraphSandbox) => sandbox.standing === group.standing) })).filter(
        (group) => group.sandboxes.length > 0,
    ),
);

const MACHINE_GROUPS: readonly { readonly key: string; readonly kinds: readonly GraphMachine[`kind`][]; readonly label: () => string }[] = [
    { key: `devices`, kinds: [`computer`, `phone`, `browser`], label: () => t(`settings.accessMap.devicesGroup`) },
    // The cloud is where hosted sandboxes run: a server of intentic's, drawn among the account's own.
    { key: `servers`, kinds: [`server`, `cloud`], label: () => t(`settings.accessMap.serversGroup`) },
];
const machineGroups = computed(() =>
    MACHINE_GROUPS.map((group) => ({ ...group, machines: graph.machines.filter((machine) => group.kinds.includes(machine.kind)) })).filter(
        (group) => group.machines.length > 0,
    ),
);

const lines = computed(() => drawLines(layout.value, graph, lighting));
const litOf = (id: string): `self` | `on` | `off` | undefined =>
    lighting === undefined ? undefined : id === focus ? `self` : lighting.nodes.has(id) ? `on` : `off`;

// The lit line wears the focus's stroke, the resting one the theme's rule; a tie between sandboxes keeps a tint of the
// link ink at rest, since it is the one kind of line that runs inside a column. All mixed in AccessMap.vue.
const strokeOf = (line: Line): string => {
    if (line.state === `on`) {
        return `var(--map-stroke)`;
    }
    return line.kind === `link` ? `var(--access-link)` : `var(--map-line)`;
};
const dashOf = (line: Line): string | undefined => (line.kind === `runs` ? `1 4` : line.faint ? `5 4` : undefined);
const opacityOf = (line: Line): number => (line.state === `off` ? 0.12 : line.faint && line.state === `rest` ? 0.6 : 1);

const arrowId = `access-arrow-${useId()}`;
const markerOf = (line: Line): string | undefined => (line.arrow ? `url(#${arrowId}-${line.state === `on` ? `on` : `rest`})` : undefined);

const orgWord = (org: AccountGraph[`you`][`orgs`][number]): string =>
    org.role === `admin` ? t(`settings.accessMap.orgAdmin`, { org: org.name }) : t(`settings.accessMap.orgMember`, { org: org.name });
</script>

<template>
    <div ref="stage" class="relative transition-opacity" :class="ready ? `opacity-100` : `invisible opacity-0`" @click.self="emit(`clear`)">
        <!-- Under the cards: a line runs behind every card it passes, never over a name. -->
        <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" :width="layout.width" :height="layout.height" aria-hidden="true">
            <defs>
                <marker
                    v-for="state in [`rest`, `on`]"
                    :id="`${arrowId}-${state}`"
                    :key="state"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                >
                    <path d="M0 0.5 L7.5 4 L0 7.5 z" :fill="state === `on` ? `var(--map-stroke)` : `var(--access-link)`" />
                </marker>
            </defs>
            <path
                v-for="line in lines"
                :key="line.key"
                :d="line.d"
                fill="none"
                stroke-linecap="round"
                :stroke="strokeOf(line)"
                :stroke-width="line.state === `on` ? 1.6 : 1.15"
                :stroke-dasharray="dashOf(line)"
                :opacity="opacityOf(line)"
                :marker-end="markerOf(line)"
                class="transition-[stroke,opacity,stroke-width]"
            />
        </svg>

        <div class="relative grid items-start gap-y-3" :class="columns" @click.self="emit(`clear`)">
            <h2 class="px-1 text-xs font-medium text-muted">{{ t(`settings.accessMap.you`) }}</h2>
            <h2 class="px-1 text-xs font-medium text-muted">{{ t(`settings.accessMap.columnSandboxes`) }}</h2>
            <h2 class="px-1 text-xs font-medium text-muted">{{ t(`settings.accessMap.columnReaches`) }}</h2>

            <section class="flex min-w-0 flex-col gap-2" :aria-label="t(`settings.accessMap.you`)">
                <AccessMapNode
                    :graph
                    :id="YOU_ID"
                    :lit="litOf(YOU_ID)"
                    :pinned="pinned === YOU_ID"
                    :now
                    :picture
                    @point="(on) => emit(`point`, on ? YOU_ID : undefined)"
                    @press="emit(`press`, YOU_ID)"
                />
                <ul v-if="graph.you.orgs.length > 0" class="flex flex-col gap-0.5 px-1">
                    <li v-for="org in graph.you.orgs" :key="org.id" class="truncate text-xs text-subtle">{{ orgWord(org) }}</li>
                </ul>
            </section>

            <section class="flex min-w-0 flex-col gap-4" :aria-label="t(`settings.accessMap.columnSandboxes`)">
                <div v-for="group in sandboxGroups" :key="group.standing" class="flex flex-col gap-1.5">
                    <h3 class="px-1 text-2xs text-subtle">{{ group.label() }}</h3>
                    <AccessMapNode
                        v-for="sandbox in group.sandboxes"
                        :key="sandbox.id"
                        :graph
                        :id="sandbox.id"
                        :lit="litOf(sandbox.id)"
                        :pinned="pinned === sandbox.id"
                        :now
                        @point="(on) => emit(`point`, on ? sandbox.id : undefined)"
                        @press="emit(`press`, sandbox.id)"
                    />
                </div>
            </section>

            <section class="flex min-w-0 flex-col gap-4" :aria-label="t(`settings.accessMap.columnReaches`)">
                <div v-for="group in machineGroups" :key="group.key" class="flex flex-col gap-1.5">
                    <h3 class="px-1 text-2xs text-subtle">{{ group.label() }}</h3>
                    <AccessMapNode
                        v-for="machine in group.machines"
                        :key="machine.id"
                        :graph
                        :id="machine.id"
                        :lit="litOf(machine.id)"
                        :pinned="pinned === machine.id"
                        :now
                        @point="(on) => emit(`point`, on ? machine.id : undefined)"
                        @press="emit(`press`, machine.id)"
                    />
                </div>
            </section>
        </div>
    </div>
</template>
