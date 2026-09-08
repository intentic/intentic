<!--
    The repository-narrowing column: a pinned "All repositories" row plus grouped per-repository rows, each showing one count so scanning "all" and
    "one" is the same glance. Below <SplitView>'s fold width it becomes a <Picker> instead.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useRailMemory } from "../../composables/useRailMemory.js";
import NavRail from "./NavRail.vue";
import type { NavGroup } from "./navRail.js";
import Picker from "../forms/Picker.vue";
import type { PickerGroup, PickerOptions } from "../forms/picker.js";
import type { RepoRailAll, RepoRailGroup, RepoRailRow } from "./repoRail.js";
import Row from "../rows/Row.vue";
import { useCompact } from "./splitView.js";

const { groups, all, memory } = defineProps<{
    /** The repositories, in the runs they should be read in. Empty groups drop out. */
    groups: readonly RepoRailGroup[];
    /** The pinned row's glyph and workspace-wide total. */
    all: RepoRailAll;
    /** Key for where the reader left this rail, across visits. */
    memory: string;
}>();

// undefined = every repository. Kept undefined rather than a sentinel so the URL simply omits the parameter.
const selected = defineModel<string | undefined>();

// Remembers the last repository across visits, so the URL doesn't start empty; "All" is remembered too.
useRailMemory(memory, selected, () => groups.flatMap((group) => group.rows.map((row) => row.value)));

const shown = computed<readonly RepoRailGroup[]>(() => groups.filter((group) => group.rows.length > 0));
const navGroups = computed<NavGroup<RepoRailRow>[]>(() => shown.value.map((group) => ({ key: group.key, label: group.label, items: group.rows })));

// Asked of the split above, not the screen: the board beside this rail is only as wide as the workspace pane.
const compact = useCompact();

// The same model as options, with each row's number as the quiet right-hand annotation.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: `All repositories`, description: all.meta, icon: all.icon }] },
    ...shown.value.map((group): PickerGroup<string> => ({
        label: group.label,
        options: group.rows.map((row) => ({ value: row.value, label: row.label, description: row.meta, icon: row.icon, mono: row.mono })),
    })),
]);
// Picker models a string, and `` is its spelling of "no filter".
const picked = computed<string>({ get: () => selected.value ?? ``, set: (value) => (selected.value = value === `` ? undefined : value) });
</script>

<template>
    <Picker v-if="compact" v-model="picked" :options="options" aria-label="Repository" header="Repository" class="w-full text-xs" />

    <NavRail v-else :groups="navGroups">
        <template #pinned>
            <Row
                as="button"
                density="dense"
                :icon="all.icon"
                title="All repositories"
                :selected="selected === undefined"
                class="rounded-md"
                @click="selected = undefined"
            >
                <template #meta>
                    <span v-tooltip.bottom="all.tooltip" :class="all.tone">{{ all.meta }}</span>
                </template>
            </Row>
        </template>

        <template #row="{ item: row }">
            <Row
                :key="row.value"
                as="button"
                density="dense"
                :icon="row.icon"
                :title="row.label"
                :selected="selected === row.value"
                class="rounded-md"
                @click="selected = row.value"
            >
                <template #meta>
                    <span v-tooltip.bottom="row.tooltip" :class="row.tone">{{ row.meta }}</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
