<script setup lang="ts">
import { Card, Notice, noticeOf, SegmentedControl, SkeletonSnapshot, useLoadingReveal, vSkeletonSource } from "@intentic/extension-ui";
import { computed, ref, toRef, watch } from "vue";
import DepsGraph from "./DepsGraph.vue";
import DepsOverview from "./DepsOverview.vue";
import PackageInside from "./PackageInside.vue";
import { areaIdOf, areasOf, findingsOf, hubsOf, type Grouping } from "./depModel";
import { useWorkspaceGraph } from "./useWorkspaceGraph";
import { t } from "./i18n.js";

// A monorepo's architecture as its files state it, in three views of one graph. Overview opens on what the code says:
// counts, the findings the declared edges and their usage add up to, and every area against every other. Graph draws
// the packages, without the edges a longer path implies and with the packages nearly everything uses as chips rather
// than lines. Inside opens one package: its directories stacked in its declared layers, or in the tiers its imports
// imply.

const props = defineProps<{ repo: string }>();
const { packages, edges, components, error, isLoading } = useWorkspaceGraph(toRef(props, `repo`));
// Drawn only once the wait has earned it, and keyed on the repo so switching starts a fresh wait.
const outline = useLoadingReveal(isLoading, toRef(props, `repo`));

type Tab = `overview` | `graph` | `inside`;
const tab = ref<Tab>(`overview`);
const selected = ref<string | undefined>(undefined);
const focusArea = ref<string | undefined>(undefined);
const inside = ref<string | undefined>(undefined);
watch(
    () => props.repo,
    () => {
        tab.value = `overview`;
        selected.value = undefined;
        focusArea.value = undefined;
        inside.value = undefined;
    },
);

// By the repository map's components when it has one, which is how its own docs carve it; by top-level folder otherwise.
const hasMap = computed(() => components.value.length > 0);
const picked = ref<Grouping | undefined>(undefined);
const grouping = computed<Grouping>({
    get: () => picked.value ?? (hasMap.value ? `component` : `folder`),
    set: (value) => {
        picked.value = value;
        focusArea.value = undefined;
    },
});
const areas = computed(() => areasOf(packages.value, edges.value, grouping.value, components.value));
const areaOfPackage = computed(() => new Map(packages.value.map((pkg) => [pkg.name, areaIdOf(pkg, grouping.value)])));
const findings = computed(() => findingsOf(edges.value, areaOfPackage.value));
const hubs = computed(() => hubsOf(packages.value, edges.value));

const tabs = computed(() => [
    {
        label: t(`dependenciesView.tabs.overview`),
        value: `overview` as const,
        badge: findings.value.reduce((sum, finding) => sum + finding.edges.length, 0),
    },
    { label: t(`dependenciesView.tabs.graph`), value: `graph` as const },
    ...(inside.value !== undefined ? [{ label: t(`dependenciesView.tabs.inside`, { name: inside.value }), value: `inside` as const }] : []),
]);
const groupings = computed(() => [
    { label: t(`dependenciesView.grouping.component`), value: `component` as const },
    { label: t(`dependenciesView.grouping.folder`), value: `folder` as const },
]);

const openArea = (id: string): void => {
    focusArea.value = id;
    selected.value = undefined;
    tab.value = `graph`;
};
const openPackage = (name: string): void => {
    selected.value = name;
    focusArea.value = undefined;
    tab.value = `graph`;
};
const lookInside = (name: string): void => {
    inside.value = name;
    tab.value = `inside`;
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-2">
            <SegmentedControl v-model="tab" :options="tabs" variant="underline" />
            <label v-if="hasMap && tab !== `inside`" class="flex items-center gap-2 pb-1.5 text-2xs text-muted">
                {{ t(`dependenciesView.grouping.label`) }}
                <SegmentedControl v-model="grouping" :options="groupings" size="xs" />
            </label>
        </div>
        <Notice v-if="error" class="mx-4 mt-3" :of="noticeOf(error)" />
        <!-- The view as it was last drawn here; until then, cards of the real node dimensions. -->
        <SkeletonSnapshot v-if="isLoading && outline" of="repo-apps.dependencies" :label="t(`dependenciesView.readingWorkspaceGraph`)">
            <div class="min-h-0 flex-1 p-4" role="status" aria-busy="true">
                <span class="sr-only">{{ t(`dependenciesView.readingWorkspaceGraph`) }}</span>
                <div class="flex flex-wrap gap-3" aria-hidden="true">
                    <span v-for="card in 6" :key="card" class="skeleton block h-12" :class="[`w-44`, `w-52`, `w-40`][card % 3]" />
                </div>
            </div>
        </SkeletonSnapshot>
        <div v-else-if="packages.length === 0 && !isLoading" v-skeleton-source="`repo-apps.dependencies`" class="p-4">
            <Card dashed class="text-center text-sm text-muted">{{ t(`dependenciesView.noWorkspacePackagesFound`) }}</Card>
        </div>
        <DepsOverview
            v-else-if="tab === `overview`"
            v-skeleton-source="`repo-apps.dependencies`"
            class="min-h-0 flex-1"
            :packages="packages"
            :edges="edges"
            :areas="areas"
            :area-of-package="areaOfPackage"
            :findings="findings"
            @open-area="openArea"
            @open-package="openPackage"
        />
        <DepsGraph
            v-else-if="tab === `graph`"
            v-model:selected="selected"
            v-model:focus-area="focusArea"
            class="min-h-0 flex-1"
            :packages="packages"
            :edges="edges"
            :areas="areas"
            :area-of-package="areaOfPackage"
            :hubs="hubs"
            @look-inside="lookInside"
        />
        <PackageInside v-else-if="inside !== undefined" class="min-h-0 flex-1" :repo="repo" :name="inside" :packages="packages" />
    </div>
</template>
