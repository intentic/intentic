<script setup lang="ts">
import { Icon, type NavGroup, NavRail, Row, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed } from "vue";
import type { SearchHit } from "./contract";
import { folderOf, toneOfType } from "./knowledgeNote";
import { freshness } from "./noteTime";

/* WHICH NOTE — the search's answers, as the thing you pick from.
 *
 * A column of rows rather than a picker, which is what the memory extension's much smaller set gets. The
 * difference is that here the list IS the answer: a search returns notes ranked by why they matched, with the
 * line they matched on, and a dropdown can show none of that — it would reduce "these six notes mention the
 * outage, here is the sentence in each" back to six titles. The reason a row matched is the most useful thing
 * on it, so it is the thing under the title.
 *
 * THE COLUMN IS <NavRail> AND THE ROW IS <Row>, because this is the app's index column and it was the fourth
 * hand-rolled copy of it — after the activity sources, the memory index and the documentation contents, which
 * is the exact set those two components were extracted from. What the hand-roll had drifted on is what a reader
 * sees: its own selection tint rather than the app's, its own scroller, and a border the shared rail
 * deliberately does not draw (an index is chrome pointing AT something, and boxing it makes it compete with the
 * thing it points at).
 *
 * ONE UNLABELLED GROUP. The rail can section its rows and this list must not: hits arrive ranked by how well
 * they answer the query, and cutting them into headed groups would reorder the answer into something the
 * search did not say. */

const { hits, selected } = defineProps<{
    hits: readonly SearchHit[];
    selected: string | undefined;
    // Whether a query or a filter is in force — an empty result means different things either way.
    filtered: boolean;
    isLoading: boolean;
}>();

const emit = defineEmits<{ pick: [path: string] }>();

// Why a note matched, in the words the reader would use. `all` is the unfiltered browse case, where the answer
// is "everything" and the row needs no explanation at all.
const WHY: Record<string, string> = { title: ``, alias: `also called`, tag: `tagged`, type: `kind`, field: ``, body: ``, all: `` };

interface NoteRow {
    readonly path: string;
    readonly title: string;
    readonly type: string | undefined;
    readonly evidence: string;
    readonly modifiedAt: number;
    readonly why: string;
    readonly variant: StatusVariant;
}

const rows = computed<NoteRow[]>(() =>
    hits.map((hit) => {
        // The folder is only worth the line when it says something the badge does not. `kb new` files a note
        // under its own kind, so for most of the vault the folder IS the kind — printed here it read as the
        // word "person" twice on one row, which is how a reader learns to stop reading the second line.
        const folder = folderOf(hit.path);
        return {
            path: hit.path,
            title: hit.title,
            type: hit.type,
            evidence: hit.snippet ?? (folder === hit.type ? undefined : folder) ?? hit.path,
            modifiedAt: hit.modifiedAt,
            why: WHY[hit.matched] ?? hit.matched,
            variant: toneOfType(hit.type) as StatusVariant,
        };
    }),
);

// Empty rather than one empty group: the rail draws #empty only when it has no groups at all, and a headed
// group with nothing under it is a heading pointing at a blank.
const groups = computed<NavGroup<NoteRow>[]>(() => (rows.value.length === 0 ? [] : [{ key: `hits`, items: rows.value }]));
</script>

<template>
    <NavRail :groups="groups" aria-label="Notes">
        <template #row="{ item: row }">
            <Row :key="row.path" as="button" density="dense" class="rounded-lg" :selected="row.path === selected" @click="emit(`pick`, row.path)">
                <!-- THE KIND RIDES THE TITLE LINE AND THE TIME RIDES THE TRAILING CELL, which is a width
                     decision. In a 16rem column both marks in the trailing cluster left a name like "Soft
                     delete everything" about 100px to live in, and a Row's title WRAPS rather than truncating —
                     so a third of the list turned into two-line rows and the column stopped being scannable.
                     The kind is an attribute of the name, so it belongs beside it and truncates with it. -->
                <template #title>
                    <span class="flex min-w-0 items-center gap-1.5">
                        <span class="min-w-0 truncate">{{ row.title }}</span>
                        <StatusBadge v-if="row.type" :variant="row.variant" size="xs" :label="row.type" />
                    </span>
                </template>
                <!-- The evidence: the sentence a body match was found on, the fact a header match was, or where
                     the note lives when it matched by name and there is nothing to quote. -->
                <template #description>
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span v-if="row.why" class="shrink-0 uppercase tracking-wide">{{ row.why }}</span>
                        <span class="min-w-0 flex-1 truncate">{{ row.evidence }}</span>
                    </span>
                </template>
                <template #meta>
                    <span>{{ freshness(row.modifiedAt) }}</span>
                </template>
            </Row>
        </template>

        <!-- THREE DIFFERENT EMPTINESSES. Answering "nothing matches" to somebody who never typed anything
             accuses them of a search they did not run, and answering it while the first one is still in flight
             is wrong for a moment and then wrong-looking after. -->
        <template #empty>
            <p v-if="isLoading" class="px-2 py-4 text-xs text-subtle">Looking…</p>
            <p v-else-if="filtered" class="px-2 py-4 text-xs text-muted">
                Nothing in the vault matches. The agent's <b>kb</b> command searches the same notes — and a link to a note nobody has written yet is a
                perfectly good way to leave a gap for later.
            </p>
            <p v-else class="px-2 py-4 text-xs text-muted">No notes yet.</p>
        </template>

        <!-- Below the scroll rather than at the end of it: a row cap that only appears once you have scrolled
             past two hundred notes is a cap nobody reads. -->
        <template v-if="rows.length >= 200" #footer>
            <p class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="info-circle" class="shrink-0" />
                Showing the first 200 — narrow it with a word, a kind or a tag.
            </p>
        </template>
    </NavRail>
</template>
