<!-- WHICH REPOSITORY — the narrowing column two workspace-wide boards had each built, and the reason their
     bodies can stay a list.

     IT NARROWS, IT DOES NOT SELECT. "All repositories" is where these pages open and where they return to,
     because the first question a cross-repo board answers is "is anything wrong anywhere" — a menu you have to
     walk repository by repository to answer that is not a monitoring surface, it is a filing cabinet. That is
     why the pinned row belongs to no group and cannot be grouped or filtered out of reach: a row you cannot get
     back to is a filter you cannot clear.

     WHY A COLUMN AND NOT A DROPDOWN, given it narrows: it shows a per-repository number while you scan, which is
     what makes "all" and "one" the same glance. A closed dropdown shows one name and no numbers. Below the width
     <SplitView> folds at, there is no column to scan and it swaps itself for a <Picker> carrying the same
     numbers as each row's quiet annotation.

     ONE NUMBER PER ROW, and any second fact is its COLOUR rather than a second number: two numbers in a 16rem
     column read as "1 5" with nothing saying which is which, and the reader who needs the distinction is
     scanning, not hovering. The tooltip is where the whole state is spelled out. What the number COUNTS is the
     caller's — branches failing, chores due — and so is the colour rule; this owns the shape they are said in.

     Bounded by how many repositories a workspace holds, never by how much they are owed. That is the whole
     answer to what these pages grow into. -->
<script setup lang="ts">
import { computed } from "vue";
import { useRailMemory } from "../composables/useRailMemory.js";
import NavRail from "./NavRail.vue";
import type { NavGroup } from "./navRail.js";
import Picker from "./Picker.vue";
import type { PickerGroup, PickerOptions } from "./picker.js";
import type { RepoRailAll, RepoRailGroup, RepoRailRow } from "./repoRail.js";
import Row from "./Row.vue";
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

/* Which repository you were last reading about, kept across visits — a rail is where these pages are steered
 * from, and re-picking the same row on arrival was the cost of a URL that starts empty every time. "All" is
 * remembered as readily as one of them: somebody who deliberately widened the scope should find it wide. */
useRailMemory(memory, selected, () => groups.flatMap((group) => group.rows.map((row) => row.value)));

const shown = computed<readonly RepoRailGroup[]>(() => groups.filter((group) => group.rows.length > 0));
const navGroups = computed<NavGroup<RepoRailRow>[]>(() => shown.value.map((group) => ({ key: group.key, label: group.label, items: group.rows })));

// Asked of the split above, not of the screen: the board beside this rail is only as wide as the workspace pane.
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
