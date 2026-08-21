<!-- The markdown preview's outline: a document's own headings, as a column of places to go.

     WHY A LIST OF WORDS AND NOT A MINIMAP. The code surface beside this one has a minimap and is right to: code
     has a silhouette: indentation, line-length variance, colour, so a shrunken page is still recognisable.
     Rendered prose is a uniform slab; every paragraph looks like every other paragraph, and the only landmarks
     in it are the headings. A minimap would show those as unreadable grey bars, where this shows them as their
     own words. That is the same answer GitHub, VS Code and Obsidian arrived at for the same reason.

     THE SPINE. Each row carries a left border, so the rows stack into one continuous line down the rail and the
     current section lights its own segment of it. A tinted row-fill (ui-row-select-on, what the file tree uses)
     would be wrong here: the tree is a list you act on, this is chrome beside prose, and a filled block in the
     margin competes with the paragraph it is meant to be helping you read. -->
<script setup lang="ts">
import { ui, SearchBar } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { matchHeadings, type OutlineHeading } from "./markdownOutline";

const { headings, active } = defineProps<{
    headings: readonly OutlineHeading[];
    /** Index of the section the reader is in, or -1. */
    active: number;
}>();
const emit = defineEmits<{ jump: [index: number] }>();

/* Past this many sections the list is its own navigation problem: you are scanning a column of forty names for
 * one word, which is the scrolling you came here to avoid. Under it, a filter box is a control nobody needs
 * taking the room two more headings could have used. */
const FILTER_FROM = 12;

const query = ref(``);
const filterable = computed(() => headings.length >= FILTER_FROM);
const rows = computed(() => matchHeadings(headings, filterable.value ? query.value : ``));

/* Indentation is relative to the document's OWN shallowest heading, not to h1. A README opens with a title and
 * sections under it; a fragment lifted out of one may start at h2 or h3 and never hold anything shallower.
 * Measuring from the top of what is actually there means the second kind reads as a flat list of sections
 * rather than as a column shoved three steps to the right for no reason the reader can see. */
const shallowest = computed(() => headings.reduce((top, heading) => Math.min(top, heading.level), 6));
// Capped: past three steps the words have no room left, and a document nested that deep is not navigated by
// indentation anyway.
const inset = (heading: OutlineHeading): string => `${0.75 + Math.min(heading.level - shallowest.value, 3) * 0.7}rem`;

// Keep the current section on screen in a rail longer than the pane. `nearest` is deliberately the least
// disruptive scroll there is: a row already visible does not move at all, so reading a long document does not
// come with a column twitching in the corner of the eye.
const list = ref<HTMLElement>();
watch(
    () => active,
    (index) => {
        list.value?.querySelector<HTMLElement>(`[data-outline-row="${index}"]`)?.scrollIntoView({ block: `nearest` });
    },
);
</script>

<template>
    <nav aria-label="Document outline" class="flex min-h-0 w-full flex-col gap-2">
        <div class="flex shrink-0 items-baseline justify-between gap-2 pl-3">
            <span :class="ui.sectionLabel(`text-2xs`)">Outline</span>
            <span class="text-2xs tabular-nums text-subtle">{{ headings.length }}</span>
        </div>

        <SearchBar
            v-if="filterable"
            v-model="query"
            variant="field"
            clearable
            placeholder="Filter headings…"
            aria-label="Filter headings"
            class="shrink-0"
        />

        <div ref="list" class="ui-softscroll -mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
            <button
                v-for="row in rows"
                :key="row.index"
                :data-outline-row="row.index"
                type="button"
                class="outline-row block w-full border-l py-1 pr-2 text-left text-xs leading-snug"
                :class="row.index === active ? `border-link text-content` : `border-line text-subtle`"
                :style="{ paddingLeft: inset(row.heading) }"
                :aria-current="row.index === active ? `true` : undefined"
                @click="emit(`jump`, row.index)"
            >
                {{ row.heading.text }}
            </button>
            <p v-if="rows.length === 0" class="px-3 py-1 text-2xs text-subtle">No heading matches.</p>
        </div>
    </nav>
</template>

<style scoped>
/* The row idiom of a spine: the border firms up and the words come forward together, fast enough to land inside
   a pointer sweeping down the column. */
.outline-row {
    cursor: pointer;
    transition:
        color 0.09s ease-out,
        border-color 0.09s ease-out;
}
.outline-row:hover {
    border-color: var(--color-line-strong);
    color: var(--color-content);
}
.outline-row:focus-visible {
    outline: none;
    border-color: var(--color-primary-500);
    color: var(--color-content);
}
</style>
