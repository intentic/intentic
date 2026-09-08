<!--
    Outline of a rendered markdown document's own headings, as a list of places to jump to — not a minimap, since prose has no visual silhouette the
    way code does. Each row's left border joins into one spine; the current section lights its own segment.
-->
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

// Past this many sections, scanning the list becomes its own search; under it, a filter box just wastes room.
const FILTER_FROM = 12;

const query = ref(``);
const filterable = computed(() => headings.length >= FILTER_FROM);
const rows = computed(() => matchHeadings(headings, filterable.value ? query.value : ``));

// Indentation is relative to the document's own shallowest heading, not h1: a fragment starting at h2/h3 reads
// as a flat list, not shoved right for no visible reason.
const shallowest = computed(() => headings.reduce((top, heading) => Math.min(top, heading.level), 6));
// Capped at three steps; words run out of room past that, and such nesting isn't read by indentation anyway.
const inset = (heading: OutlineHeading): string => `${0.75 + Math.min(heading.level - shallowest.value, 3) * 0.7}rem`;

// Keeps the current section on screen in a rail longer than the pane. `nearest` never moves an already-visible
// row, so reading doesn't come with the column twitching in the corner of the eye.
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
                class="block w-full cursor-pointer border-l py-1 pr-2 text-left text-xs leading-snug transition-[color,border-color] duration-[90ms] ease-out hover:border-line-strong hover:text-content focus-visible:border-primary-500 focus-visible:text-content focus-visible:outline-none"
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

