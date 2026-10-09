<script setup lang="ts">
import type { WorkspaceDepEdge, WorkspaceDepUsage, WorkspacePackage } from "@intentic/sandbox-contract";
import { Row, RowGroup, StatStrip } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { areaMatrix, heightsOf, impliedEdges, isRuntime, usageOf, type Area, type Finding } from "./depModel";
import { t } from "./i18n.js";

// What the code says about the graph before anything is drawn: the counts, the findings, every area against every
// other, and how the declared dependencies are actually used.

const props = defineProps<{
    packages: readonly WorkspacePackage[];
    edges: readonly WorkspaceDepEdge[];
    areas: readonly Area[];
    areaOfPackage: ReadonlyMap<string, string>;
    findings: readonly Finding[];
}>();
const emit = defineEmits<{ openArea: [id: string]; openPackage: [name: string] }>();

const runtime = computed(() => props.edges.filter(isRuntime));
const implied = computed(() => impliedEdges(runtime.value));
const longest = computed(() => Math.max(0, ...heightsOf(props.packages, props.edges).values()));
const stats = computed(() => [
    { label: t(`dependenciesView.stats.packages`), value: String(props.packages.length) },
    {
        label: t(`dependenciesView.stats.runtime`),
        value: String(runtime.value.length),
        note: t(`dependenciesView.stats.runtimeNote`, { dev: props.edges.length - runtime.value.length }),
    },
    {
        label: t(`dependenciesView.stats.essential`),
        value: String(runtime.value.length - implied.value.size),
        note: t(`dependenciesView.stats.essentialNote`, { implied: implied.value.size }),
    },
    { label: t(`dependenciesView.stats.longest`), value: String(longest.value), note: t(`dependenciesView.stats.longestNote`) },
]);

const short = (name: string): string => name.split(`/`).at(-1) ?? name;
const labelOf = computed(() => new Map(props.areas.map((area) => [area.id, area.label])));
const findingTitle = (finding: Finding): string => {
    if (finding.kind === `mutual`) {
        const [from, to] = finding.areas ?? [``, ``];
        return t(`dependenciesView.findings.mutual.title`, { from: labelOf.value.get(from) ?? from, to: labelOf.value.get(to) ?? to });
    }
    return t(`dependenciesView.findings.${finding.kind}.title`);
};
const findingCaption = (finding: Finding): string => {
    if (finding.kind === `mutual`) {
        const [from, to] = finding.areas ?? [``, ``];
        return t(
            `dependenciesView.findings.mutual.caption`,
            { from: labelOf.value.get(from) ?? from, to: labelOf.value.get(to) ?? to, against: finding.against ?? 0, count: finding.edges.length },
            finding.edges.length,
        );
    }
    return t(`dependenciesView.findings.${finding.kind}.caption`);
};

// Row depends on column; areas run foundation first, so a cell right of the diagonal points up the order.
const cells = computed(() => areaMatrix(runtime.value, props.areaOfPackage));
const heaviest = computed(() => Math.max(1, ...[...cells.value].filter(([key]) => !isDiagonal(key)).map(([, list]) => list.length)));
const isDiagonal = (key: string): boolean => {
    const [from, to] = key.split(`>`);
    return from === to;
};
// The lighter direction of each pair of areas using each other: the cells the findings list.
const flagged = computed(() => new Set(props.findings.filter((finding) => finding.kind === `mutual`).map((finding) => finding.areas?.join(`>`))));
const fill = (key: string): string => {
    const count = cells.value.get(key)?.length ?? 0;
    if (count === 0) {
        return `color-mix(in oklab, var(--color-surface-500) 8%, transparent)`;
    }
    const share = isDiagonal(key) ? 0.35 : Math.sqrt(count / heaviest.value);
    return `color-mix(in oklab, var(--color-series-2) ${Math.round(14 + 66 * share)}%, transparent)`;
};
const openCell = ref<string | undefined>(undefined);
const cellEdges = computed(() => (openCell.value === undefined ? [] : (cells.value.get(openCell.value) ?? [])));
const cellTitle = computed(() => {
    const [from, to] = (openCell.value ?? `>`).split(`>`);
    return t(`dependenciesView.matrix.cell`, { from: labelOf.value.get(from!) ?? from, to: labelOf.value.get(to!) ?? to });
});
const toggleCell = (key: string): void => {
    openCell.value = openCell.value === key || (cells.value.get(key)?.length ?? 0) === 0 ? undefined : key;
};

// How each kind of declaration is used: the deterministic half of "is this dependency real".
const USAGES: readonly WorkspaceDepUsage[] = [`code`, `types`, `reference`, `tooling`, `none`];
const usageTable = computed(() =>
    USAGES.map((usage) => ({
        usage,
        runtime: runtime.value.filter((edge) => usageOf(edge) === usage).length,
        dev: props.edges.filter((edge) => !isRuntime(edge) && usageOf(edge) === usage).length,
    })),
);
</script>

<template>
    <div class="overflow-auto px-4 pb-6">
        <StatStrip :items="stats" />

        <section class="mt-2 flex flex-col gap-4">
            <h3 class="text-sm font-semibold text-content">{{ t(`dependenciesView.findings.heading`) }}</h3>
            <p v-if="findings.length === 0" class="text-sm text-muted">{{ t(`dependenciesView.findings.none`) }}</p>
            <RowGroup
                density="dense"
                v-for="finding in findings"
                :key="`${finding.kind}:${finding.areas?.join(`>`) ?? ``}`"
                :label="findingTitle(finding)"
                :count="finding.edges.length"
                :caption="findingCaption(finding)"
            >
                <Row
                    v-for="edge in finding.edges"
                    :key="`${edge.from}>${edge.to}:${edge.type}`"
                    as="button"
                    interactive
                    :title="`${short(edge.from)} → ${short(edge.to)}`"
                    @click="emit(`openPackage`, edge.from)"
                >
                    <template #meta>
                        <span class="font-mono text-2xs text-subtle">{{ t(`dependenciesView.usage.${usageOf(edge)}`) }} · {{ edge.type }}</span>
                    </template>
                </Row>
            </RowGroup>
        </section>

        <section class="mt-8 flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-content">{{ t(`dependenciesView.matrix.heading`) }}</h3>
            <p class="max-w-prose text-xs text-muted">{{ t(`dependenciesView.matrix.caption`) }}</p>
            <div class="overflow-x-auto">
                <table class="border-separate text-2xs tabular-nums" :style="{ borderSpacing: `2px` }">
                    <thead>
                        <tr>
                            <th></th>
                            <th v-for="area in areas" :key="area.id" class="h-28 w-8 align-bottom font-normal">
                                <button
                                    type="button"
                                    class="max-h-28 truncate text-muted hover:text-content"
                                    :style="{ writingMode: `vertical-rl`, transform: `rotate(180deg)` }"
                                    :title="t(`dependenciesView.matrix.openArea`, { area: area.label })"
                                    @click="emit(`openArea`, area.id)"
                                >
                                    {{ area.label }}
                                </button>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="row in areas" :key="row.id">
                            <th class="pr-2 text-right font-normal">
                                <button
                                    type="button"
                                    class="inline-flex max-w-48 items-center gap-1.5 text-muted hover:text-content"
                                    :title="t(`dependenciesView.matrix.openArea`, { area: row.label })"
                                    @click="emit(`openArea`, row.id)"
                                >
                                    <span class="truncate">{{ row.label }}</span>
                                    <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: row.color }"></span>
                                </button>
                            </th>
                            <td v-for="column in areas" :key="column.id" class="p-0">
                                <button
                                    type="button"
                                    class="flex h-7 w-8 items-center justify-center rounded text-content"
                                    :class="[
                                        row.id === column.id ? `border border-dashed border-line` : ``,
                                        flagged.has(`${row.id}>${column.id}`) ? `border-2 border-warning font-semibold` : ``,
                                        openCell === `${row.id}>${column.id}` ? `ring-2 ring-content` : ``,
                                    ]"
                                    :style="{ background: fill(`${row.id}>${column.id}`) }"
                                    :disabled="(cells.get(`${row.id}>${column.id}`)?.length ?? 0) === 0"
                                    :title="t(`dependenciesView.matrix.cell`, { from: row.label, to: column.label })"
                                    @click="toggleCell(`${row.id}>${column.id}`)"
                                >
                                    {{ cells.get(`${row.id}>${column.id}`)?.length || `` }}
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <RowGroup density="dense" v-if="openCell !== undefined" class="mt-2" :label="cellTitle" :count="cellEdges.length">
                <Row
                    v-for="edge in cellEdges"
                    :key="`${edge.from}>${edge.to}:${edge.type}`"
                    as="button"
                    interactive
                    :title="`${short(edge.from)} → ${short(edge.to)}`"
                    @click="emit(`openPackage`, edge.from)"
                >
                    <template #meta>
                        <span class="font-mono text-2xs text-subtle">{{ t(`dependenciesView.usage.${usageOf(edge)}`) }} · {{ edge.type }}</span>
                    </template>
                </Row>
            </RowGroup>
        </section>

        <section class="mt-8 flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-content">{{ t(`dependenciesView.usageTable.heading`) }}</h3>
            <p class="max-w-prose text-xs text-muted">{{ t(`dependenciesView.usageTable.caption`) }}</p>
            <table class="max-w-xl text-xs tabular-nums">
                <thead>
                    <tr class="text-left text-2xs text-muted">
                        <th class="py-1 pr-4 font-normal"></th>
                        <th class="w-20 py-1 pr-4 text-right font-normal">{{ t(`dependenciesView.usageTable.runtime`) }}</th>
                        <th class="w-20 py-1 text-right font-normal">{{ t(`dependenciesView.usageTable.dev`) }}</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-line-subtle">
                    <tr v-for="row in usageTable" :key="row.usage">
                        <td class="py-1.5 pr-4">
                            <span class="text-content">{{ t(`dependenciesView.usage.${row.usage}`) }}</span>
                            <span class="block text-2xs text-subtle">{{ t(`dependenciesView.usageAbout.${row.usage}`) }}</span>
                        </td>
                        <td class="py-1.5 pr-4 text-right text-content">{{ row.runtime }}</td>
                        <td class="py-1.5 text-right text-content">{{ row.dev }}</td>
                    </tr>
                </tbody>
            </table>
        </section>
    </div>
</template>
