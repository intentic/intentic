<!-- The contents column: the index to a document set, and for a 50-package monorepo the only thing standing
     between a reader and a wall of paths.

     IT DRAWS NO LINES AT ALL, which is now <NavRail>'s rule rather than this column's choice. An index that
     outlines itself competes with the document it exists to reach. Everything separates by
     space, by weight and by a wash of the text colour: the column ends where the page's margin begins, the
     groups are spaced apart rather than boxed apart, and the only saturated things in it are the seven
     component accents and the amber of a page that has drifted.

     What the eye gets instead of chrome is rhythm: a sticky component heading, then rows that differ only in
     the part that is not shared: `_sandbox/` is dimmed, `sandbox-contract` is not, because the prefix is the same
     word on nine rows in a row and the leaf is what anybody is actually reading.

     The gutter, the whisper-scrollbar and the sticky headings all moved into <NavRail> when the activity rail
     and the memory index turned out to want them too; the `.docrow` class that used to live down here was a
     hand copy of `.ui-row-select` taken from a version of it that had already been replaced. -->
<script setup lang="ts">
import { type NavGroup, NavRail, Row } from "@intentic/extension-ui";
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from "vue";
import type { DocComponent, DocIndex } from "./docModel.js";

const { components, index, page } = defineProps<{
    // The map's components, in authored order: the grouping the reader thinks in.
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
 * claims it: generating one new package after the map was written leaves an entry no component lists, and
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
    // The path split where it stops being shared: `_sandbox/` is the same word on eleven rows in a row, and the leaf
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
        title: [dir, entry?.oneLiner, entry?.stale === true ? `May be out of date, ${entry.reason}` : undefined]
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

const visible = computed<NavGroup<NavRow>[]>(() =>
    sections.value.flatMap((section) => {
        const packages = matching(section);
        return packages.length === 0
            ? []
            : [{ key: section.id, label: section.name, count: packages.length, accent: section.accent, items: packages.map(rowOf) }];
    }),
);

// Enter is the shortcut for the common case: you typed enough that only the page you meant is left.
const openFirst = (): void => {
    const first = visible.value[0]?.items[0];
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
    <NavRail
        v-model="query"
        aria-label="Documents"
        :groups="visible"
        :filterable="total > 12"
        sticky-headings
        placeholder="Filter packages…"
        @keydown.enter.prevent="openFirst"
    >
        <!-- The way back to the map. Pinned because the overview is not a package, so a filter must never take
             it away, and it is the row a lost reader reaches for. -->
        <template #pinned>
            <Row
                as="button"
                density="dense"
                icon="align-left"
                title="Overview"
                :selected="page === undefined"
                class="rounded-lg"
                @click="emit(`open`, undefined)"
            />
        </template>

        <template #row="{ item: row }">
            <Row
                :key="row.dir"
                :ref="(el: Element | ComponentPublicInstance | null) => setRowEl(row.dir, el)"
                as="button"
                density="dense"
                :title="row.title"
                :selected="page === row.dir"
                class="rounded-lg"
                @click="emit(`open`, row.dir)"
            >
                <template #title>
                    <span class="min-w-0 truncate font-mono">
                        <!-- Dimmed by opacity rather than by a colour token, so the prefix stays one step behind
                             the leaf in every state the row has: muted at rest, content on hover, link when it
                             is the open page: instead of only in the one it was picked against. -->
                        <span class="opacity-70">{{ row.prefix }}</span
                        >{{ row.leaf }}
                    </span>
                </template>
                <!-- A dot, not a warning triangle. Most of a live repo's pages are behind by a commit or two at
                     any moment, so the mark is on the majority of rows: at triangle weight the column reads as
                     an emergency, and an emergency that is always on is one nobody reads. -->
                <template v-if="row.stale" #meta>
                    <span class="size-1.5 rounded-full bg-warning/70" aria-hidden="true"></span>
                </template>
            </Row>
        </template>

        <!-- TWO DIFFERENT EMPTINESSES, and answering with the wrong one accuses the reader of mistyping a filter
             they never touched. A column with nothing in it is ordinary: a run that has written the map but no
             pages yet, a repository whose overview is the whole documentation, and it should say so. -->
        <template #empty>
            <p class="px-2 py-6 text-center text-2xs text-subtle">
                {{ query.trim() === `` ? `No package pages here yet.` : `Nothing matches "${query.trim()}".` }}
            </p>
        </template>

        <template v-if="index !== undefined" #footer>
            <div class="flex flex-col gap-0.5 text-2xs text-subtle">
                <span
                    >{{ entries.length }} documented<span v-if="index.undocumented.length > 0"> · {{ index.undocumented.length }} not yet</span></span
                >
                <!-- Doubles as the legend for the dots up the column: the mark and the sentence that explains it
                     are the same amber, so nobody has to guess what a dot beside a package means. -->
                <span v-if="staleCount > 0" class="flex items-center gap-1.5">
                    <span class="size-1.5 shrink-0 rounded-full bg-warning/70" aria-hidden="true"></span>
                    {{ staleCount }} may be out of date
                </span>
                <span v-if="index.orphans.length > 0" class="text-warning">
                    {{ index.orphans.length }} document{{ index.orphans.length === 1 ? `` : `s` }} for packages that are gone
                </span>
            </div>
        </template>
    </NavRail>
</template>
