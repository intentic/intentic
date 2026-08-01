<!-- The contents column — the index to a document set, and for a 50-package monorepo the only thing standing
     between a reader and a wall of paths.

     It is a QUIET SURFACE, deliberately: no cards, no per-group borders, one hairline against the page. An index
     that draws boxes around itself competes with the document it exists to reach, and boxing each component also
     clipped every row's hover inside its own little card. What the eye gets instead is rhythm — a sticky
     component heading carrying that component's authored accent, then rows that differ only in the one part that
     is not shared: `_libs/` is dimmed, `sandbox-contract` is not, because the prefix is the same on nine rows in
     a row and the leaf is what anybody is actually reading.

     THE SCROLLBAR HAS ITS OWN GUTTER (`pr-2` inside the scroller). Without it the thumb lands on top of the
     rightmost few pixels of every row — which is exactly where the staleness marks sit. -->
<script setup lang="ts">
import { cmp, Icon, seriesColor } from "@intentic/extension-ui";
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from "vue";
import type { DocComponent, DocIndex } from "./docModel.js";

const { components, index, page } = defineProps<{
    // The map's components, in authored order — the grouping the reader thinks in.
    components: readonly DocComponent[];
    // The generated index: which pages exist, and the tool's verdict on each. Absent until a set is generated.
    index: DocIndex | undefined;
    // undefined ⇒ the repository overview.
    page: string | undefined;
}>();

const emit = defineEmits<{ open: [dir: string | undefined] }>();

const entries = computed(() => index?.entries ?? []);
const byDir = computed(() => new Map(entries.value.map((entry) => [entry.dir, entry])));
const staleCount = computed(() => entries.value.filter((entry) => entry.stale).length);

/* A SECTION IS A COMPONENT, including the tail one this builds. A document exists whether or not the map
 * claims it — generating one new package after the map was written leaves an entry no component lists — and
 * grouping strictly by the map would make that page unreachable from the only index there is. */
const sections = computed<DocComponent[]>(() => {
    const claimed = new Set(components.flatMap((component) => component.packages));
    const unmapped = entries.value.map((entry) => entry.dir).filter((dir) => !claimed.has(dir));
    if (unmapped.length === 0) {
        return [...components];
    }
    return [
        ...components,
        { id: `unmapped`, name: `Not on the map`, oneLiner: `Documented after the map was drawn`, accent: `neutral`, packages: unmapped },
    ];
});

const total = computed(() => sections.value.reduce((count, section) => count + section.packages.length, 0));

interface NavRow {
    readonly dir: string;
    // The path split where it stops being shared: `_libs/` is the same word on nine rows in a row, and the leaf
    // is what anybody is actually reading, so the two halves are drawn at different weights.
    readonly prefix: string;
    readonly leaf: string;
    readonly stale: boolean;
    // Everything a reader would ask of a row before spending a click, in the one place that costs no space.
    readonly title: string;
}

const rowOf = (dir: string): NavRow => {
    const entry = byDir.value.get(dir);
    const cut = dir.lastIndexOf(`/`);
    return {
        dir,
        prefix: dir.slice(0, cut + 1),
        leaf: dir.slice(cut + 1),
        stale: entry?.stale === true,
        title: [dir, entry?.oneLiner, entry?.stale === true ? `May be out of date — ${entry.reason}` : undefined]
            .filter((line) => line !== undefined)
            .join(`\n`),
    };
};

/* Filtering earns its place at around a dozen packages, and the whole point of it is that you do not have to
 * know which component a package was filed under. A section NAME matching counts for all its rows (the
 * PickerPanel rule): "sandbox" is a thing people search for, and it is a component here, not a package. */
const query = ref(``);
const matching = (section: DocComponent): readonly string[] => {
    const needle = query.value.trim().toLowerCase();
    if (needle === `` || section.name.toLowerCase().includes(needle)) {
        return section.packages;
    }
    return section.packages.filter((dir) => `${dir} ${byDir.value.get(dir)?.oneLiner ?? ``}`.toLowerCase().includes(needle));
};

const visible = computed(() =>
    sections.value.flatMap((section) => {
        const packages = matching(section);
        return packages.length === 0 ? [] : [{ section, rows: packages.map(rowOf) }];
    }),
);

// Enter is the shortcut for the common case: you typed enough that only the page you meant is left.
const openFirst = (): void => {
    const first = visible.value[0]?.rows[0];
    if (first !== undefined) {
        emit(`open`, first.dir);
    }
};

/* A deep link (?doc=…) lands on a page whose row is 40 rows down an independently scrolled column. Without
 * this the sidebar opens at the top showing no selection at all, which reads as "this page is not in the list". */
const rowEls = new Map<string, Element>();
const setRowEl = (dir: string, el: Element | ComponentPublicInstance | null): void => {
    if (el instanceof Element) {
        rowEls.set(dir, el);
        return;
    }
    rowEls.delete(dir);
};
watch(
    () => page,
    (dir) => {
        if (dir !== undefined) {
            void nextTick(() => rowEls.get(dir)?.scrollIntoView({ block: `nearest` }));
        }
    },
    { immediate: true },
);
</script>

<template>
    <nav aria-label="Documents" class="flex w-64 shrink-0 flex-col border-r border-line pr-3">
        <!-- Pinned: the search and the way back to the map. Neither is something a reader should have to scroll
             to find, and the overview is not a package, so a filter never takes it away. -->
        <div class="flex shrink-0 flex-col gap-1.5 pb-2">
            <div v-if="total > 12" class="relative">
                <Icon name="search" aria-hidden="true" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-subtle" />
                <input
                    v-model="query"
                    type="text"
                    role="searchbox"
                    aria-label="Filter packages"
                    placeholder="Filter packages…"
                    :class="cmp.input(`w-full bg-card py-1.5 pl-7 text-xs`, query === `` ? `pr-2.5` : `pr-7`)"
                    @keydown.enter.prevent="openFirst"
                    @keydown.esc="query = ``"
                />
                <button
                    v-if="query !== ``"
                    type="button"
                    aria-label="Clear filter"
                    class="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-xs text-muted hover:text-content"
                    @click="query = ``"
                >
                    <Icon name="times" />
                </button>
            </div>

            <button
                type="button"
                class="docrow flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                :class="{ 'docrow-on': page === undefined }"
                :aria-current="page === undefined ? `page` : undefined"
                @click="emit(`open`, undefined)"
            >
                <Icon name="align-left" class="shrink-0 text-2xs" />
                <span class="truncate">Overview</span>
            </button>
        </div>

        <!-- The scrolling index. Component headings stick so the answer to "what am I looking at" survives the
             scroll — with 55 rows the grouping is otherwise only visible at the moment you pass it. -->
        <div class="min-h-0 flex-1 overflow-y-auto pr-2 scrollbar-thin">
            <section v-for="{ section, rows } in visible" :key="section.id">
                <!-- The breathing room belongs to the heading, not to the section: padding above it travels with
                     it when it sticks, so a stuck heading keeps the same shape it had while scrolling past. -->
                <h3 :title="section.oneLiner" class="sticky top-0 z-10 flex items-center gap-2 bg-canvas pb-1 pl-2 pr-1 pt-3">
                    <span class="size-1.5 shrink-0 rounded-full" :style="{ background: seriesColor(section.accent) }" aria-hidden="true"></span>
                    <span :class="cmp.sectionLabel(`min-w-0 truncate text-2xs`)">{{ section.name }}</span>
                    <span class="ml-auto shrink-0 text-2xs tabular-nums text-subtle">{{ rows.length }}</span>
                </h3>

                <button
                    v-for="row in rows"
                    :key="row.dir"
                    :ref="(el) => setRowEl(row.dir, el)"
                    type="button"
                    :title="row.title"
                    :aria-current="page === row.dir ? `page` : undefined"
                    class="docrow flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-1.5 text-left"
                    :class="{ 'docrow-on': page === row.dir }"
                    @click="emit(`open`, row.dir)"
                >
                    <span class="min-w-0 flex-1 truncate font-mono text-xs">
                        <!-- Dimmed by opacity rather than by a colour token, so the prefix stays one step behind
                             the leaf in every state the row has — muted at rest, content on hover, link when it
                             is the open page — instead of only in the one it was picked against. -->
                        <span class="opacity-70">{{ row.prefix }}</span
                        >{{ row.leaf }}
                    </span>
                    <!-- A dot, not a warning triangle. Most of a live repo's pages are behind by a commit or two
                         at any moment, so the mark is on the majority of rows: at triangle weight the column
                         reads as an emergency, and an emergency that is always on is one nobody reads. -->
                    <span v-if="row.stale" class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true"></span>
                </button>
            </section>

            <p v-if="visible.length === 0" class="px-2 py-6 text-center text-2xs text-subtle">Nothing matches “{{ query.trim() }}”.</p>
        </div>

        <!-- Coverage is a footnote, so it sits below the scroll rather than at the end of it: a number about the
             whole set that only appears once you have scrolled past every row is a number nobody sees. -->
        <div v-if="index !== undefined" class="flex shrink-0 flex-col gap-0.5 border-t border-line pl-2 pt-2 text-2xs text-subtle">
            <span
                >{{ entries.length }} documented<span v-if="index.undocumented.length > 0"> · {{ index.undocumented.length }} not yet</span></span
            >
            <!-- Doubles as the legend for the dots up the column: the mark and the sentence that explains it are
                 the same amber, so nobody has to guess what a dot beside a package means. -->
            <span v-if="staleCount > 0" class="flex items-center gap-1.5">
                <span class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true"></span>
                {{ staleCount }} may be out of date
            </span>
            <span v-if="index.orphans.length > 0" class="text-warning">
                {{ index.orphans.length }} document{{ index.orphans.length === 1 ? `` : `s` }} for packages that are gone
            </span>
        </div>
    </nav>
</template>

<style scoped>
/* The app's list-row idiom (WorkspaceTree's .treerow): a hover that tints rather than recolors, and a selection
   that reads as selected while the pointer is somewhere else entirely — which the old `bg-canvas` could not do,
   being both the hover colour AND darker than the surface it sat on in dark mode. */
.docrow {
    color: var(--color-muted);
    cursor: pointer;
    transition:
        background-color 0.1s,
        color 0.1s;
}
.docrow:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
    color: var(--color-content);
}
.docrow-on,
.docrow-on:hover {
    background: color-mix(in srgb, var(--color-primary-500) 15%, transparent);
    color: var(--color-link);
    font-weight: 500;
}
.docrow:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
</style>
