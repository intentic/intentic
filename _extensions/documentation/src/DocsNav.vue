<!--
    Contents index for a document set. Draws no borders or lines of its own — <NavRail> owns that rule — separating groups by spacing and weight
    instead. A repeated path prefix (e.g. `_sandbox/`) dims so the differing leaf name reads first.
-->
<script setup lang="ts">
import { type NavGroup, NavRail, Row } from "@intentic/extension-ui";
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from "vue";
import type { DocComponent, DocIndex } from "./docModel.js";

const { components, index, page } = defineProps<{
    // Map's components, in authored order: the grouping a reader thinks in.
    components: readonly DocComponent[];
    // Generated index: which pages exist and the tool's verdict on each; absent until a set is generated.
    index: DocIndex | undefined;
    // undefined ⇒ the repository overview.
    page: string | undefined;
}>();

const emit = defineEmits<{ open: [dir: string | undefined] }>();

const entries = computed(() => index?.entries ?? []);
const byDir = computed(() => new Map(entries.value.map((entry) => [entry.dir, entry])));
const staleCount = computed(() => entries.value.filter((entry) => entry.stale).length);

// Appends a synthetic tail section for packages the map does not claim, so an entry missing from it stays reachable.
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
    // Path split at the last shared segment; prefix and leaf render at different weights.
    readonly prefix: string;
    readonly leaf: string;
    readonly stale: boolean;
    // Everything a reader needs before clicking, packed into the title since it costs no layout space.
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

// Shown past about a dozen packages; a matching section name counts for all its rows, not just named packages.
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

// Enter opens the first visible row, once filtering narrows it to just the one page meant.
const openFirst = (): void => {
    const first = visible.value[0]?.items[0];
    if (first !== undefined) {
        emit(`open`, first.dir);
    }
};

// Scrolls the selected row into view, since the nav column scrolls independently of a deep-linked page.
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
        <!-- Pinned: the overview is not a package, so a filter must never hide this row. -->
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
                        <!-- Opacity, not a color token: the prefix stays a step behind the leaf across rest, hover and selected states. -->
                        <span class="opacity-70">{{ row.prefix }}</span
                        >{{ row.leaf }}
                    </span>
                </template>
                <!-- A dot, not a triangle: most rows in a live repo are stale, so triangle weight reads as constant emergency. -->
                <template v-if="row.stale" #meta>
                    <span class="size-1.5 rounded-full bg-warning/70" aria-hidden="true"></span>
                </template>
            </Row>
        </template>

        <!-- Two different emptinesses: an untyped filter reads as no pages yet, not as a mistyped search. -->
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
                <!-- Doubles as the legend for the dots up the column; same amber ties the mark to its explanation. -->
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
