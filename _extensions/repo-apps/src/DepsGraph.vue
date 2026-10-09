<script setup lang="ts">
import type { WorkspaceDepEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { DagGraph, Icon, ToggleSwitch, ui, useNarrow, type DagEdge, type DagNode } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import DepsInspector from "./DepsInspector.vue";
import { closureOf, dependentCounts, edgeKey, impliedEdges, isRuntime, monogramsOf, usageOf, type Area } from "./depModel";
import { t } from "./i18n.js";

// The packages as a graph that can be read: an edge a longer path already implies is left out, the packages nearly
// everything uses are chips on the cards rather than lines across the picture, and a package with no line left sits in
// a list under the graph rather than a column of its own. Each simplification has its own toggle back.

const props = defineProps<{
    packages: readonly WorkspacePackage[];
    edges: readonly WorkspaceDepEdge[];
    areas: readonly Area[];
    areaOfPackage: ReadonlyMap<string, string>;
    hubs: readonly string[];
}>();
const emit = defineEmits<{ lookInside: [name: string] }>();
const selected = defineModel<string | undefined>(`selected`);
const focusArea = defineModel<string | undefined>(`focusArea`);

const showAll = ref(false);
const showDev = ref(false);
const showHubs = ref(false);

// Below 45rem the inspector goes under the graph rather than beside it.
const root = ref<HTMLElement>();
const narrow = useNarrow(root, 45);

const byName = computed(() => new Map(props.packages.map((pkg) => [pkg.name, pkg])));
const areaById = computed(() => new Map(props.areas.map((area) => [area.id, area])));
const colorOf = (name: string): string => areaById.value.get(props.areaOfPackage.get(name) ?? ``)?.color ?? `var(--color-series-other)`;
const hubSet = computed(() => new Set(showHubs.value ? [] : props.hubs));
const marks = computed(() => monogramsOf(props.hubs));
const counts = computed(() => dependentCounts(props.edges));
const short = (name: string): string => name.split(`/`).at(-1) ?? name;

// What the toggles admit, before any simplification: the walk a selection lights up runs over all of it.
const base = computed(() => props.edges.filter((edge) => showDev.value || isRuntime(edge)));
const implied = computed(() => impliedEdges(base.value));
const touchesHub = (edge: WorkspaceDepEdge): boolean => hubSet.value.has(edge.to) || hubSet.value.has(edge.from);
const drawnAll = computed(() => base.value.filter((edge) => (showAll.value || !implied.value.has(edgeKey(edge))) && !touchesHub(edge)));
const inFocus = (name: string): boolean => focusArea.value === undefined || props.areaOfPackage.get(name) === focusArea.value;
const drawn = computed(() => drawnAll.value.filter((edge) => inFocus(edge.from) || inFocus(edge.to)));

// Every package with a line left is a card; with an area in focus, its packages and the ones they touch directly.
const onGraph = computed(() => {
    const names = new Set<string>();
    for (const edge of drawn.value) {
        names.add(edge.from).add(edge.to);
    }
    return names;
});
const incident = computed(() => {
    const names = new Set<string>();
    for (const edge of base.value) {
        names.add(edge.from).add(edge.to);
    }
    return names;
});
const scoped = computed(() => props.packages.filter((pkg) => inFocus(pkg.name)));
// No card: one that neither uses nor is used by a sibling, and one whose every line runs to a hub.
const standalone = computed(() => scoped.value.filter((pkg) => !incident.value.has(pkg.name) && !hubSet.value.has(pkg.name)));
const hubOnly = computed(() =>
    scoped.value.filter((pkg) => incident.value.has(pkg.name) && !onGraph.value.has(pkg.name) && !hubSet.value.has(pkg.name)),
);

const closure = computed(() => (selected.value === undefined ? undefined : closureOf(selected.value, base.value)));
const lit = computed(() => (closure.value === undefined ? undefined : new Set([selected.value!, ...closure.value.uses, ...closure.value.usedBy])));

// The hubs each package declares directly, drawn as marks on its card.
const hubsUsed = computed(() => {
    const used = new Map<string, string[]>();
    for (const edge of base.value) {
        if (hubSet.value.has(edge.to)) {
            (used.get(edge.from) ?? used.set(edge.from, []).get(edge.from)!).push(edge.to);
        }
    }
    return used;
});

interface Card {
    readonly pkg: WorkspacePackage;
    readonly color: string;
    readonly hubs: readonly string[];
    readonly outside: boolean;
}
const dagNodes = computed<DagNode<Card>[]>(() =>
    props.packages
        .filter((pkg) => onGraph.value.has(pkg.name))
        .map((pkg) => ({
            id: pkg.name,
            data: { pkg, color: colorOf(pkg.name), hubs: [...new Set(hubsUsed.value.get(pkg.name) ?? [])], outside: !inFocus(pkg.name) },
            tooltip: `${pkg.name} · ${pkg.dir}`,
            dimmed: lit.value !== undefined ? !lit.value.has(pkg.name) : !inFocus(pkg.name),
        })),
);

// A finding drawn on its edge: a runtime dependency nothing uses, or only tests and tooling do.
const isFinding = (edge: WorkspaceDepEdge): boolean => isRuntime(edge) && (usageOf(edge) === `none` || usageOf(edge) === `tooling`);
// Edge direction is flipped from the API's `from depends on to`, so dependencies sit left and what's built on them right.
const dagEdges = computed<DagEdge[]>(() =>
    drawn.value.map((edge) => {
        const key = edgeKey(edge);
        const accent =
            closure.value !== undefined
                ? closure.value.usesEdges.has(key)
                    ? `text-warning`
                    : closure.value.usedByEdges.has(key)
                      ? `text-info`
                      : undefined
                : isFinding(edge)
                  ? `text-danger`
                  : undefined;
        return {
            from: edge.to,
            to: edge.from,
            kind: edge.type,
            dashed: edge.type === `dev` || usageOf(edge) !== `code`,
            accent,
            dimmed: closure.value !== undefined && accent === undefined,
        };
    }),
);

const legend = computed(() => {
    const shown = new Set([...onGraph.value].map((name) => props.areaOfPackage.get(name)));
    return props.areas.filter((area) => shown.has(area.id));
});
const focusLabel = computed(() => (focusArea.value === undefined ? undefined : (areaById.value.get(focusArea.value)?.label ?? focusArea.value)));
const pick = (name: string): void => {
    selected.value = selected.value === name ? undefined : name;
};
const selectedPackage = computed(() => (selected.value === undefined ? undefined : byName.value.get(selected.value)));
</script>

<template>
    <div ref="root" class="flex min-h-0 flex-col gap-2 overflow-auto px-4 pb-3 pt-3">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                <span v-if="focusLabel" :class="ui.chip({ on: true })" class="gap-1">
                    {{ t(`dependenciesView.graph.focus`, { area: focusLabel }) }}
                    <button
                        type="button"
                        class="text-muted hover:text-content"
                        :aria-label="t(`dependenciesView.graph.clearFocus`)"
                        @click="focusArea = undefined"
                    >
                        <Icon name="times" />
                    </button>
                </span>
                <span v-for="area in legend" :key="area.id" class="flex items-center gap-1.5">
                    <span class="h-2 w-2 rounded-full" :style="{ background: area.color }"></span>{{ area.label }}
                </span>
                <span class="flex items-center gap-1.5">
                    <svg class="h-px w-5 overflow-visible text-subtle" aria-hidden="true">
                        <line x1="0" y1="0.5" x2="20" y2="0.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" />
                    </svg>
                    {{ t(`dependenciesView.graph.dashed`) }}
                </span>
                <span class="flex items-center gap-1.5">
                    <svg class="h-px w-5 overflow-visible text-danger" aria-hidden="true">
                        <line x1="0" y1="0.5" x2="20" y2="0.5" stroke="currentColor" stroke-width="1.5" />
                    </svg>
                    {{ t(`dependenciesView.graph.findingEdge`) }}
                </span>
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <label class="flex cursor-pointer items-center gap-2">
                    <ToggleSwitch v-model="showAll" class="scale-75" />
                    {{ t(`dependenciesView.graph.allEdges`, { count: implied.size }) }}
                </label>
                <label v-if="hubs.length > 0" class="flex cursor-pointer items-center gap-2">
                    <ToggleSwitch v-model="showHubs" class="scale-75" />
                    {{ t(`dependenciesView.graph.hubsAsCards`) }}
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                    <ToggleSwitch v-model="showDev" class="scale-75" />
                    {{ t(`dependenciesView.devDependencies`) }}
                </label>
            </div>
        </div>

        <div v-if="hubs.length > 0 && !showHubs" class="flex flex-wrap items-center gap-1.5 text-2xs">
            <span class="mr-1 text-muted">{{ t(`dependenciesView.graph.hubs`) }}</span>
            <button
                v-for="hub in hubs"
                :key="hub"
                type="button"
                :class="ui.chip({ on: selected === hub })"
                class="gap-1.5"
                :title="t(`dependenciesView.graph.hubTitle`, { name: hub, count: counts.get(hub) ?? 0 })"
                @click="pick(hub)"
            >
                <span class="rounded bg-overlay px-1 font-mono text-muted">{{ marks.get(hub) }}</span>
                {{ short(hub) }}
                <span class="text-subtle">{{ counts.get(hub) }}</span>
            </button>
        </div>

        <div class="flex gap-3" :class="narrow ? `shrink-0 flex-col` : `min-h-80 flex-1`">
            <div class="relative overflow-hidden rounded-lg border border-line" :class="narrow ? `h-96 shrink-0` : `min-w-0 flex-1`">
                <DagGraph
                    v-if="dagNodes.length > 0"
                    :model-value="selected"
                    :nodes="dagNodes"
                    :edges="dagEdges"
                    :node-height="56"
                    :magnify="false"
                    :readable-zoom="0.75"
                    :min-zoom="0.15"
                    fit-align="start"
                    touch-pan
                    @update:model-value="selected = $event"
                >
                    <template #node="{ node }">
                        <span class="pointer-events-none absolute inset-y-0 left-0 w-1" :style="{ background: node.data.color }"></span>
                        <span class="flex h-full min-w-0 flex-col justify-center gap-0.5 pl-3 pr-2">
                            <span class="truncate text-sm font-medium leading-tight text-content">{{ short(node.data.pkg.name) }}</span>
                            <span class="flex min-w-0 items-center gap-1">
                                <span class="min-w-0 flex-1 truncate font-mono text-2xs leading-tight text-subtle">{{ node.data.pkg.dir }}</span>
                                <span
                                    v-for="hub in node.data.hubs"
                                    :key="hub"
                                    class="shrink-0 rounded bg-overlay px-1 font-mono text-2xs leading-tight text-muted"
                                    :title="hub"
                                    >{{ marks.get(hub) }}</span
                                >
                            </span>
                        </span>
                    </template>
                </DagGraph>
                <p v-else class="p-6 text-center text-sm text-muted">{{ t(`dependenciesView.graph.empty`) }}</p>
            </div>
            <DepsInspector
                v-if="selectedPackage"
                :class="narrow ? `max-h-96` : `w-80 shrink-0`"
                :pkg="selectedPackage"
                :edges="edges"
                :closure="closure"
                :area="areaById.get(areaOfPackage.get(selectedPackage.name) ?? ``)"
                @pick="pick"
                @close="selected = undefined"
                @look-inside="emit(`lookInside`, $event)"
            />
        </div>

        <div v-if="standalone.length + hubOnly.length > 0" class="flex flex-col gap-1.5 text-2xs">
            <div v-if="hubOnly.length > 0" class="flex flex-wrap items-center gap-1.5">
                <span class="mr-1 text-muted">{{ t(`dependenciesView.graph.hubOnly`, { count: hubOnly.length }) }}</span>
                <button
                    v-for="pkg in hubOnly"
                    :key="pkg.name"
                    type="button"
                    :class="ui.chip({ on: selected === pkg.name })"
                    class="gap-1.5"
                    :title="pkg.dir"
                    @click="pick(pkg.name)"
                >
                    <span class="h-1.5 w-1.5 rounded-full" :style="{ background: colorOf(pkg.name) }"></span>{{ short(pkg.name) }}
                </button>
            </div>
            <div v-if="standalone.length > 0" class="flex flex-wrap items-center gap-1.5">
                <span class="mr-1 text-muted">{{
                    showDev
                        ? t(`dependenciesView.graph.standalone`, { count: standalone.length })
                        : t(`dependenciesView.graph.noRuntime`, { count: standalone.length })
                }}</span>
                <button
                    v-for="pkg in standalone"
                    :key="pkg.name"
                    type="button"
                    :class="ui.chip({ on: selected === pkg.name })"
                    class="gap-1.5"
                    :title="pkg.dir"
                    @click="pick(pkg.name)"
                >
                    <span class="h-1.5 w-1.5 rounded-full" :style="{ background: colorOf(pkg.name) }"></span>{{ short(pkg.name) }}
                </button>
            </div>
        </div>
    </div>
</template>
