<script setup lang="ts">
import { formatTimestamp, freshness, Icon, type NavGroup, NavRail, Row, SkeletonRows, useLoadingReveal } from "@intentic/extension-ui";
import { computed, nextTick, watch } from "vue";
import type { SearchHit } from "./contract";
import { dotOfType } from "./knowledgeNote";

/* WHICH NOTE: the search's answers, as the thing you pick from.
 *
 * A column of rows rather than a picker, which is what the memory extension's much smaller set gets. The
 * difference is that here the list IS the answer: a search returns notes ranked by why they matched, with the
 * line they matched on, and a dropdown can show none of that: it would reduce "these six notes mention the
 * outage, here is the sentence in each" back to six titles. The reason a row matched is the most useful thing
 * on it, so it is the thing under the title.
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
 * ── THE ROW IS TWO LINES AND THE NAME OWNS THE FIRST ONE ──────────────────────────────────────────────────
 *
 * It used to be a name sharing its line with a kind pill, over a second line repeating the note's folder, with
 * a full calendar date pinned to the right. Measured on a real knowledge base that is 52px of row height to
 * carry 65px of NAME: the pill took ~55px and the date ~80px off a 256px column, and a <Row>'s title WRAPS
 * rather than truncating, so what was left turned "Soft delete everything" into "Soft dele…". The one thing a
 * reader picks by was the smallest thing on the row, and the selection tint — a wash over the full width — read
 * as a slab with its content huddled in one corner of it.
 *
 * So the three passengers each moved to where they cost nothing:
 *
 *  · THE KIND IS A DOT (see dotOfType), the same colour its badge paints in the pane, and the word rides the
 *    second line. Recognition is what a kind is for in a list; reading it is what the pane is for.
 *  · THE DATE LEFT THE ROW'S RIGHT EDGE for that same second line. A trailing cluster is `shrink-0`, so it was
 *    setting the width of every row in the column to serve a fact nobody searches by.
 *  · THE FOLDER IS GONE. `kb new` files a note under its own kind, so it said "decision" a second time under a
 *    badge already reading `decision` — and when it was suppressed for saying so, the line fell back to the
 *    whole PATH, which begins with the same folder. The path is on the note's own header, once, where it is
 *    a fact about the file rather than a row's only description.
 *
 * WHAT IS ON THE SECOND LINE IS WHAT THE FIRST ONE CANNOT SAY. Evidence when the search found words the row is
 * not otherwise showing (a header fact, a line of prose); the note's own quiet facts when it did not. Never
 * both: they answer the same question, and a row that prints the answer twice is how the line stops being
 * read. */

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
 * the reader is already looking at (the name, and the kind on the line below it), and `field` and `body` bring
 * the matching words themselves as a snippet, which says it better than any label could. An alias and a tag
 * are the pair whose matching text appears NOWHERE on the row, and they are exactly the hits that otherwise
 * read as the search having returned something at random.
 *
 * A SENTENCE RATHER THAN A LABEL, and it takes the whole line. Written as a `TAG` chip in front of the note's
 * facts it came out as "TAG person · 43m ago", where the eye pairs the label with the word after it and reads
 * the tag as being "person" — which is the one thing it is not. The line answers one question at a time. */
const REASON: Record<string, string> = { alias: `matched an alias`, tag: `matched a tag` };

interface NoteRow {
    readonly path: string;
    readonly title: string;
    readonly type: string | undefined;
    // The evidence, the reason, or the note's own quiet facts — whichever the first line cannot say. Never two
    // of them; see the header note.
    readonly detail: string;
    // Present only while `detail` IS the freshness: the exact moment behind the rounded words, as a tooltip.
    readonly at: string | undefined;
    readonly dot: string;
}

const rows = computed<NoteRow[]>(() =>
    hits.map((hit) => {
        const reason = hit.snippet ?? REASON[hit.matched];
        // A kind and a freshness, joined only when there is a kind: an untyped note would otherwise open its
        // line on a separator with nothing in front of it.
        const facts = [hit.type, freshness(hit.modifiedAt)].filter((part) => part !== undefined && part !== ``).join(` · `);
        return {
            path: hit.path,
            title: hit.title,
            type: hit.type,
            detail: reason ?? facts,
            at: reason === undefined ? formatTimestamp(hit.modifiedAt) : undefined,
            dot: dotOfType(hit.type),
        };
    }),
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
                class="rounded-md"
                :selected="row.path === selected"
                @click="emit(`pick`, row.path)"
            >
                <!-- WHAT KIND OF THING THIS IS, at 6px. Drawn even for a note with no kind (neutral), because
                     the alternative is every untyped row starting its title 16px left of its neighbours', and a
                     ragged left edge costs a scanning column more than a grey dot does.

                     IT CARRIES THE WORD FOR ANYONE NOT READING THE COLOUR. The pill it replaced was text, so a
                     screen reader heard the kind on every row; a coloured dot that is only decorative would
                     have taken that away — and on an alias or a tag hit, where the line below is explaining the
                     match instead, there is nothing else on the row that says it. The neutral dot on an untyped
                     note has no word to give and stays decoration. -->
                <template #lead>
                    <span
                        class="size-1.5 shrink-0 rounded-full"
                        :class="row.dot"
                        :role="row.type === undefined ? undefined : `img`"
                        :aria-label="row.type"
                        :aria-hidden="row.type === undefined ? `true` : undefined"
                        :title="row.type"
                    ></span>
                </template>
                <!-- The whole line, so a name is the thing that fits rather than the thing that is left over. -->
                <template #title>
                    <span class="block truncate">{{ row.title }}</span>
                </template>
                <!-- One thing: the sentence a body match was found on, the header fact a field match was, why
                     an alias or a tag hit is here at all, or — when the search explains itself — what kind of
                     thing this is and how fresh. -->
                <template #description>
                    <span class="block truncate leading-tight" :title="row.at">{{ row.detail }}</span>
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
                <SkeletonRows v-if="outline" :rows="5" density="dense" description />
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
