<script setup lang="ts">
import type { PackageUnit, PackageUnitEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { Card, Notice, noticeOf, RowGroup, Row, StatStrip, ui } from "@intentic/extension-ui";
import { computed, ref, toRef, watch } from "vue";
import { isUpward, stackOf, unitLinks } from "./layerModel";
import { usePackageModules } from "./useWorkspaceGraph";
import { t } from "./i18n.js";

// One package's insides: its directories stacked in the layers its layers.json declares, or, without one, in the tiers
// its own imports imply. Selecting a unit lists what it imports and what imports it; an import that reaches up a
// layer, and a cycle inside one, are listed first, since those are what the package's boundary check refuses.

const props = defineProps<{ repo: string; name: string; packages: readonly WorkspacePackage[] }>();
const { modules, error, isLoading } = usePackageModules(toRef(props, `repo`), toRef(props, `name`));
const stack = computed(() => (modules.value === undefined ? undefined : stackOf(modules.value)));
const units = computed(() => new Map((modules.value?.units ?? []).map((unit) => [unit.id, unit])));
const picked = ref<string | undefined>(undefined);
watch(
    () => props.name,
    () => (picked.value = undefined),
);

const stats = computed(() => {
    if (modules.value === undefined || stack.value === undefined) {
        return [];
    }
    const total = modules.value.units.reduce((sum, unit) => sum + unit.modules, 0);
    return [
        { label: t(`dependenciesView.inside.stats.modules`), value: String(total) },
        { label: t(`dependenciesView.inside.stats.units`), value: String(modules.value.units.length) },
        { label: t(`dependenciesView.inside.stats.imports`), value: String(modules.value.edges.reduce((sum, edge) => sum + edge.imports, 0)) },
        stack.value.declared
            ? { label: t(`dependenciesView.inside.stats.upward`), value: String(stack.value.upward.length) }
            : { label: t(`dependenciesView.inside.stats.cycles`), value: String(stack.value.cycles.length) },
    ];
});

// A unit's bar width follows its module count, against the largest.
const largest = computed(() => Math.max(1, ...(modules.value?.units ?? []).map((unit) => unit.modules)));
const inCycle = computed(() => new Set(stack.value?.cycles.flatMap((cycle) => cycle.units) ?? []));
const upwardFrom = computed(() => new Set(stack.value?.upward.map((edge) => edge.from) ?? []));
const links = computed(() => (picked.value === undefined || modules.value === undefined ? undefined : unitLinks(modules.value, picked.value)));
const linked = computed(() => {
    if (links.value === undefined) {
        return undefined;
    }
    return new Map<string, `out` | `in`>([
        ...links.value.in.map((edge) => [edge.from, `in`] as const),
        ...links.value.out.map((edge) => [edge.to, `out`] as const),
    ]);
});
const unitTone = (unit: PackageUnit): string => {
    if (picked.value === unit.id) {
        return `ring-2 ring-content`;
    }
    const side = linked.value?.get(unit.id);
    return side === `out` ? `ring-1 ring-warning` : side === `in` ? `ring-1 ring-info` : ``;
};
const edgeTone = (edge: PackageUnitEdge): string => (isUpward(units.value.get(edge.from), units.value.get(edge.to)) ? `text-danger` : `text-subtle`);
const pick = (id: string): void => {
    picked.value = picked.value === id ? undefined : id;
};
const pkg = computed(() => props.packages.find((entry) => entry.name === props.name));
</script>

<template>
    <div class="overflow-auto px-4 pb-6 pt-3">
        <div class="mb-1 flex flex-wrap items-baseline gap-x-3">
            <h3 class="text-sm font-semibold text-content">{{ name }}</h3>
            <span class="font-mono text-2xs text-subtle">{{ modules?.root ?? pkg?.dir }}</span>
        </div>
        <p v-if="stack" class="mb-2 max-w-prose text-xs text-muted">
            {{ stack?.declared ? t(`dependenciesView.inside.declared`) : t(`dependenciesView.inside.inferred`) }}
        </p>
        <Notice v-if="error" class="mb-3" :of="noticeOf(error)" />
        <Notice v-if="modules?.invalid" class="mb-3" :of="noticeOf(modules.invalid, { tone: `warning` })" />
        <div v-if="isLoading" class="flex flex-col gap-2" role="status" aria-busy="true">
            <span class="sr-only">{{ t(`dependenciesView.inside.reading`) }}</span>
            <span v-for="row in 4" :key="row" class="skeleton block h-10 w-full" aria-hidden="true" />
        </div>
        <Card v-else-if="modules && modules.units.length === 0" dashed class="text-center text-sm text-muted">{{
            t(`dependenciesView.inside.empty`)
        }}</Card>
        <template v-else-if="stack && modules">
            <StatStrip :items="stats" />
            <div class="mt-2 flex flex-col gap-1.5">
                <div v-for="row in stack.rows" :key="row.key" class="flex items-start gap-3 rounded-md border border-line-subtle p-2">
                    <div class="w-32 min-w-0 shrink-0 pt-1">
                        <div class="truncate text-xs font-medium text-content">{{ row.name }}</div>
                        <div v-if="row.about" class="line-clamp-2 text-2xs text-subtle" :title="row.about">{{ row.about }}</div>
                    </div>
                    <div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
                        <span v-if="row.units.length === 0" class="pt-1 text-2xs text-subtle">{{ t(`dependenciesView.inside.emptyLayer`) }}</span>
                        <button
                            v-for="unit in row.units"
                            :key="unit.id"
                            type="button"
                            class="relative flex min-w-24 flex-col items-start overflow-hidden rounded border border-line-subtle bg-card px-2 py-1 text-left hover:bg-overlay"
                            :class="unitTone(unit)"
                            :title="t(`dependenciesView.inside.unitTitle`, { unit: unit.id, count: unit.modules }, unit.modules)"
                            @click="pick(unit.id)"
                        >
                            <span class="flex max-w-56 items-center gap-1 truncate font-mono text-2xs text-content">
                                <span
                                    v-if="inCycle.has(unit.id)"
                                    class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                    :title="t(`dependenciesView.inside.inCycle`)"
                                ></span>
                                <span
                                    v-if="upwardFrom.has(unit.id)"
                                    class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                                    :title="t(`dependenciesView.inside.reachesUp`)"
                                ></span>
                                {{ unit.id }}
                            </span>
                            <span class="text-2xs text-subtle">{{ unit.modules }}</span>
                            <span
                                class="absolute inset-x-0 bottom-0 h-0.5"
                                :style="{ width: `${Math.max(6, Math.round((100 * unit.modules) / largest))}%`, background: `var(--color-series-2)` }"
                            ></span>
                        </button>
                    </div>
                </div>
            </div>

            <div v-if="links && picked" class="mt-4 flex flex-wrap gap-3">
                <RowGroup
                    density="dense"
                    class="min-w-72 flex-1"
                    :label="t(`dependenciesView.inside.imports`, { unit: picked })"
                    :count="links.out.length"
                >
                    <Row
                        v-for="edge in links.out"
                        :key="edge.to"
                        as="button"
                        interactive
                        :title="edge.to"
                        :description="edge.sites.join(`  `)"
                        @click="pick(edge.to)"
                    >
                        <template #meta>
                            <span class="font-mono text-2xs" :class="edgeTone(edge)">{{ edge.imports }}</span>
                        </template>
                    </Row>
                </RowGroup>
                <RowGroup
                    density="dense"
                    class="min-w-72 flex-1"
                    :label="t(`dependenciesView.inside.importedBy`, { unit: picked })"
                    :count="links.in.length"
                >
                    <Row
                        v-for="edge in links.in"
                        :key="edge.from"
                        as="button"
                        interactive
                        :title="edge.from"
                        :description="edge.sites.join(`  `)"
                        @click="pick(edge.from)"
                    >
                        <template #meta>
                            <span class="font-mono text-2xs" :class="edgeTone(edge)">{{ edge.imports }}</span>
                        </template>
                    </Row>
                </RowGroup>
            </div>

            <section class="mt-6 flex flex-col gap-4">
                <RowGroup
                    density="dense"
                    v-if="stack.upward.length > 0"
                    :label="t(`dependenciesView.inside.upward`)"
                    :count="stack.upward.length"
                    :caption="t(`dependenciesView.inside.upwardCaption`)"
                >
                    <Row
                        v-for="edge in stack.upward"
                        :key="`${edge.from}>${edge.to}`"
                        as="button"
                        interactive
                        :title="`${edge.from} → ${edge.to}`"
                        :description="edge.sites.join(`  `)"
                        @click="pick(edge.from)"
                    >
                        <template #meta>
                            <span class="font-mono text-2xs text-danger">{{ edge.imports }}</span>
                        </template>
                    </Row>
                </RowGroup>
                <RowGroup
                    density="dense"
                    v-for="(cycle, at) in stack.cycles"
                    :key="cycle.units.join(`,`)"
                    :label="t(`dependenciesView.inside.cycle`, { n: at + 1 })"
                    :count="cycle.units.length"
                    :caption="cycle.units.join(` · `)"
                >
                    <Row
                        v-for="edge in cycle.edges"
                        :key="`${edge.from}>${edge.to}`"
                        as="button"
                        interactive
                        :title="`${edge.from} → ${edge.to}`"
                        :description="edge.sites.join(`  `)"
                        @click="pick(edge.from)"
                    >
                        <template #meta>
                            <span class="font-mono text-2xs text-subtle">{{ edge.imports }}</span>
                        </template>
                    </Row>
                </RowGroup>
                <p v-if="stack.unplaced.length > 0" class="text-xs text-muted">
                    {{ t(`dependenciesView.inside.unplaced`, { units: stack.unplaced.join(`, `) }) }}
                </p>
                <p v-if="!stack.declared" :class="ui.emptyState()" class="text-xs">{{ t(`dependenciesView.inside.declareHint`) }}</p>
            </section>
        </template>
    </div>
</template>
