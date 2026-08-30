<script setup lang="ts">
import { Icon, type NavGroup, NavRail, Row, SkeletonRows, useLoadingReveal } from "@intentic/extension-ui";
import { computed, nextTick, watch } from "vue";
import type { SearchHit } from "./contract";
import { iconOfType } from "./knowledgeNote";

/* WHICH NOTE: the search's answers, as the thing you pick from.
 *
 * A column of rows rather than a picker, which is what the memory extension's much smaller set gets. The
 * difference is that here the list IS the answer: a search returns notes ranked by why they matched, with the
 * line they matched on, and a dropdown can show none of that: it would reduce "these six notes mention the
 * outage, here is the sentence in each" back to six titles. The reason a row matched is the most useful thing
 * on it, so it is the thing under the title — but only while a search is explaining itself.
 *
 * THE COLUMN IS <NavRail> AND THE ROW IS <Row>, because this is the app's index column and it was the fourth
 * hand-rolled copy of it: after the activity sources, the memory index and the documentation contents, which
 * is the exact set those two components were extracted from. What the hand-roll had drifted on is what a reader
 * sees: its own selection tint rather than the app's, its own scroller, and a border the shared rail
 * deliberately does not draw (an index is chrome pointing AT something, and boxing it makes it compete with the
 * thing it points at).
 *
 * ONE UNLABELLED GROUP. The rail can section its rows and this list must not: hits arrive ranked by how well
 * they answer the query, and cutting them into headed groups would reorder the answer into something the
 * search did not say.
 *
 * ── THE ROW IS ONE LINE UNLESS THE SEARCH HAS SOMETHING TO SAY ───────────────────────────────────────────
 *
 * It used to carry a second line of quiet facts — kind and freshness — under every title, the way an earlier
 * hand-roll had. Measured on a real knowledge base that turned 52px of row height into a column of slabs where
 * the name was the smallest thing on each row, and the kind was already said twice (a dot and the word
 * "decision"). The hub section menu beside this pane is title-only rows at the same density; this index now
 * matches it, and the note's own header carries kind, path and date when somebody opens one.
 *
 * THE KIND IS AN ICON (see iconOfType), the same vocabulary the hub menu uses for its rows: a shape you can
 * scan for, not a second line of text. Custom kinds the vocabulary has not named yet fall back to `file`. */

const { hits, selected, isLoading } = defineProps<{
    hits: readonly SearchHit[];
    selected: string | undefined;
    // Whether a query or a filter is in force: an empty result means different things either way.
    filtered: boolean;
    isLoading: boolean;
}>();

const emit = defineEmits<{ pick: [path: string] }>();

/* WHETHER THE WAIT IS WORTH DRAWING. This list re-runs on every keystroke, so it is the one place in the
 * section where an ungated outline would strobe: a local note search answers in a few milliseconds, and a
 * placeholder that appears and vanishes under the typing hand is a fault the reader cannot even locate. One
 * subject, because there is one search: consecutive queries join the outline already on screen rather than
 * re-arming its delay, which is exactly the behaviour a search field wants. */
const outline = useLoadingReveal(
    computed(() => isLoading),
    computed(() => `note-search`),
);

/* WHY A NOTE IS IN THE ANSWER, for the two hits that cannot show it. `title` and `type` matched on something
 * the reader is already looking at (the name), and `field` and `body` bring the
 * matching words themselves as a snippet, which says it better than any label could. An alias and a tag are
 * the pair whose matching text appears NOWHERE on the row, and they are exactly the hits that otherwise read
 * as the search having returned something at random.
 *
 * A SENTENCE RATHER THAN A LABEL, and it takes the whole line. Written as a `TAG` chip in front of the note's
 * facts it came out as "TAG person · 43m ago", where the eye pairs the label with the word after it and reads
 * the tag as being "person" — which is the one thing it is not. The line answers one question at a time. */
const REASON: Record<string, string> = { alias: `matched an alias`, tag: `matched a tag` };

interface NoteRow {
    readonly path: string;
    readonly title: string;
    readonly icon: ReturnType<typeof iconOfType>;
    // Present only when the search found something the title cannot say: a snippet, or why an alias/tag hit.
    readonly detail: string | undefined;
}

const rows = computed<NoteRow[]>(() =>
    hits.map((hit) => ({
        path: hit.path,
        title: hit.title,
        icon: iconOfType(hit.type),
        detail: hit.snippet ?? REASON[hit.matched],
    })),
);

// Empty rather than one empty group: the rail draws #empty only when it has no groups at all, and a headed
// group with nothing under it is a heading pointing at a blank.
const groups = computed<NavGroup<NoteRow>[]>(() => (rows.value.length === 0 ? [] : [{ key: `hits`, items: rows.value }]));

/* THE OPEN NOTE STAYS ON SCREEN, whoever moved it. Three things pick a note here and only one of them is a
 * click on a row: the arrow keys in the search field above, and following a link inside the note itself, both
 * land on rows this column may be scrolled past. Without this the list silently disagrees with the pane, which
 * is worse than a list that is merely wrong, because the reader has no reason to doubt it.
 *
 * `nearest` so a row already in view is never yanked to an edge, and after a tick because the selection
 * regularly arrives WITH the rows it points into (a fresh search opens its first hit). */
const rowEls = new Map<string, HTMLElement>();
const keepRow = (path: string, instance: unknown): void => {
    const el = (instance as { $el?: unknown } | null)?.$el;
    if (el instanceof HTMLElement) {
        rowEls.set(path, el);
    } else {
        rowEls.delete(path);
    }
};
watch(
    () => selected,
    async (path) => {
        if (path === undefined) {
            return;
        }
        await nextTick();
        rowEls.get(path)?.scrollIntoView({ block: `nearest` });
    },
);
</script>

<template>
    <NavRail :groups="groups" aria-label="Notes">
        <template #row="{ item: row }">
            <Row
                :key="row.path"
                :ref="(instance: unknown) => keepRow(row.path, instance)"
                as="button"
                density="dense"
                class="rounded-lg"
                :icon="row.icon"
                :selected="row.path === selected"
                @click="emit(`pick`, row.path)"
            >
                <template #title>
                    <span class="block truncate">{{ row.title }}</span>
                </template>
                <!-- Only while the search is explaining why this note is here: a sentence from the body, or why
                     an alias or tag hit landed. With no query in play the row is title-only, like the hub menu. -->
                <template v-if="row.detail !== undefined" #description>
                    <span class="block truncate leading-tight">{{ row.detail }}</span>
                </template>
            </Row>
        </template>

        <!-- THREE DIFFERENT EMPTINESSES. Answering "nothing matches" to somebody who never typed anything
             accuses them of a search they did not run, and answering it while the first one is still in flight
             is wrong for a moment and then wrong-looking after. -->
        <template #empty>
            <!-- "Looking…" was a WORD where a list goes: it says the right thing and shows none of it, so the
                 rail stays a third of its height and the notes shove the page down as they land. The rows the
                 search is about to return stand in instead, at the density this rail draws them. -->
            <div v-if="isLoading" role="status" aria-busy="true">
                <span class="sr-only">Looking through your notes…</span>
                <SkeletonRows v-if="outline" :rows="5" density="dense" />
            </div>
            <p v-else-if="filtered" class="px-2 py-4 text-xs text-muted">
                Nothing here matches. The agent's <b>kb</b> command searches the same notes, and a link to a note nobody has written yet is a
                perfectly good way to leave a gap for later.
            </p>
            <p v-else class="px-2 py-4 text-xs text-muted">No notes yet.</p>
        </template>

        <!-- Below the scroll rather than at the end of it: a row cap that only appears once you have scrolled
             past two hundred notes is a cap nobody reads. -->
        <template v-if="rows.length >= 200" #footer>
            <p class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="info-circle" class="shrink-0" />
                Showing the first 200: narrow it with a word, a kind or a tag.
            </p>
        </template>
    </NavRail>
</template>
