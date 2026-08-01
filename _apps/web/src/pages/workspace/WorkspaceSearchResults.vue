<script setup lang="ts">
import type { WorkspaceSearchGroup, WorkspaceSearchHit } from "@intentic-app/api-contract";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { iconForEntry } from "@intentic-app/ui";
import { codeLangForPath } from "./fileType";
import { type SnippetPiece, snippetPieces, snippetTokens, snippetWindow } from "./searchSnippet";

/* Workspace search results for the explorer sidebar: a count line, then file header rows + indented hit rows
 * (line number + snippet, syntax-coloured, with every matched span <mark>ed from the daemon's char offsets —
 * semantic hits report none and render unmarked; no client-side re-matching, no v-html). Clicking a hit (or a
 * header, which stands in for its first hit) opens the file at that line. Same dense row styling and
 * roving-tabindex keyboard nav as WorkspaceTree, minus the tree logic — the list is flat.
 *
 * VIRTUALIZED, and that is load-bearing rather than an optimisation. A one-word query in a monorepo answers
 * with a couple of thousand rows; building them all meant asking the highlighter to tokenize a couple of
 * thousand distinct lines, which overflowed its LRU, which meant the batch that invalidated the list left some
 * of those rows uncoloured, which re-rendered the list, which re-scheduled exactly the overflow — a loop that
 * never converged and never yielded, so the tab took no input again. Measured on `test` here: 1331 lines
 * scheduled, then 731 rescheduled per round, forever. A window of what is on screen is what makes the row count
 * stop mattering; the LRU is now comfortably larger than a screenful, so nothing evicts under it.
 *
 * A snippet's colour comes from the file's own grammar — the same extension→language resolution the editor
 * uses (codeLangForPath), so a row reads the way the file it points at will. The pieces, and why they are
 * pieces rather than Shiki's HTML, are searchSnippet.ts. */

const { groups, total, files, partial, truncated, searching, pending, loadingMore, error, note, query } = defineProps<{
    groups: readonly WorkspaceSearchGroup[];
    // Across the WHOLE match set, not just the page below: the panel says how much there is, then shows what fits.
    total: number;
    files: number;
    // Whether `total` is a floor — some file had more matches than the engine keeps per file.
    partial: boolean;
    truncated: boolean;
    searching: boolean;
    pending: boolean;
    loadingMore: boolean;
    error?: string;
    // What the engine did that the query didn't ask for (an unparseable regex rerun as literal text, …).
    note?: string;
    query: string;
}>();
const emit = defineEmits<{ openMatch: [path: string, line: number]; loadMore: [] }>();

/* One row height for both kinds, as the editor this is modelled on uses — it is what lets the window be index
 * arithmetic instead of a measurement pass, and a search list is scanned rather than read, so uniform rows are
 * also the right look. Overscan covers the rows a scroll reveals before the next frame runs. */
const ROW_H = 22;
const OVERSCAN = 8;
// How far the Load-more control extends the scroll surface past the last row.
const FOOTER_H = 32;

type ResultRow =
    | { key: string; index: number; kind: "file"; group: WorkspaceSearchGroup }
    | { key: string; index: number; kind: "match"; path: string; lang: string | undefined; hit: WorkspaceSearchHit };

// Every row the result set has, as descriptors only — cheap enough to rebuild per result set at any length.
// Nothing here touches the highlighter; that happens for the window below.
const rows = computed<ResultRow[]>(() => {
    const list: ResultRow[] = [];
    for (const group of groups) {
        // One resolution per file, not per hit — every hit in a group is a line of the same file.
        const lang = codeLangForPath(group.path);
        list.push({ key: group.path, index: list.length, kind: `file`, group });
        for (const hit of group.hits) {
            list.push({ key: `${group.path}:${hit.line}`, index: list.length, kind: `match`, path: group.path, lang, hit });
        }
    }
    return list;
});

/* Roving tabindex over all rows, headers included — declared here because the window below has to keep the
 * keyboard's row rendered whether or not it is on screen. */
const lead = ref<string | null>(null);
const rowEls = new Map<string, HTMLElement>();
const keys = computed(() => rows.value.map((row) => row.key));
const leadIndex = computed(() => (lead.value === null ? -1 : keys.value.indexOf(lead.value)));
const tabbableKey = computed<string | null>(() => (leadIndex.value !== -1 ? lead.value : (keys.value[0] ?? null)));

// ---- the window ----
const scroller = ref<HTMLElement>();
const scrollTop = ref(0);
const viewport = ref(0);
const firstIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN));
const lastIndex = computed(() => Math.min(rows.value.length, Math.ceil((scrollTop.value + viewport.value) / ROW_H) + OVERSCAN));

interface PaintedRow {
    readonly row: ResultRow;
    readonly elided: boolean;
    readonly pieces: readonly SnippetPiece[];
}

const paint = (row: ResultRow): PaintedRow => {
    if (row.kind === `file`) {
        return { row, elided: false, pieces: [] };
    }
    const snippet = snippetWindow(row.hit);
    return { row, elided: snippet.elided, pieces: snippetPieces(snippet, snippetTokens(snippet.text, row.lang)) };
};

/* What is actually rendered — and the only rows whose colour is ever requested. The keyboard's row is kept in
 * even when scrolled out of the window, so tabbing back into the list has somewhere to land. */
const visible = computed<PaintedRow[]>(() => {
    const painted = rows.value.slice(firstIndex.value, lastIndex.value).map(paint);
    const focused = leadIndex.value;
    if (focused !== -1 && (focused < firstIndex.value || focused >= lastIndex.value)) {
        painted.push(paint(rows.value[focused]!));
    }
    return painted;
});

const onScroll = (): void => {
    scrollTop.value = scroller.value?.scrollTop ?? 0;
};
let observer: ResizeObserver | undefined;
onMounted(() => {
    observer = new ResizeObserver(() => {
        viewport.value = scroller.value?.clientHeight ?? 0;
    });
    if (scroller.value !== undefined) {
        observer.observe(scroller.value);
        viewport.value = scroller.value.clientHeight;
    }
});
onBeforeUnmount(() => observer?.disconnect());

// A new query is a new list: keep the scroll position for an appended page, drop it for a different search.
watch(
    () => query,
    () => {
        if (scroller.value !== undefined) {
            scroller.value.scrollTop = 0;
        }
        scrollTop.value = 0;
    },
);

const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);

/* "Matches", not "results": a row here is a matching LINE with all of its occurrences marked, which is also
 * what the engine counts — so the number is the number of rows the search found, and saying "results" would
 * promise the editor's per-occurrence count. The "+" is the per-file cap admitting itself: some file had more
 * matches than the engine keeps, so this is a floor. */
const shown = computed(() => groups.reduce((sum, group) => sum + group.hits.length, 0));
const summary = computed(() => {
    // The "+" belongs to the NUMBER, not the noun: it says the count is a floor, and "4,211 matches+" reads as
    // a typo where "4,211+ matches" reads as the fact.
    const matches = `${total.toLocaleString()}${partial ? `+` : ``} ${total === 1 && !partial ? `match` : `matches`}`;
    const scope = `${matches} in ${files.toLocaleString()} ${files === 1 ? `file` : `files`}`;
    return truncated ? `${scope} · showing ${shown.value.toLocaleString()}` : scope;
});

const activate = (row: ResultRow): void => {
    if (row.kind === `file`) {
        const first = row.group.hits[0];
        if (first !== undefined) {
            emit(`openMatch`, row.group.path, first.line);
        }
        return;
    }
    emit(`openMatch`, row.path, row.hit.line);
};

// ---- focus ----
const setRowEl = (key: string, el: unknown): void => {
    if (el) {
        rowEls.set(key, el as HTMLElement);
    } else {
        rowEls.delete(key);
    }
};
// Scroll first, then focus: with a window, the row a key press moves to may not be mounted yet, and .focus() on
// an element that doesn't exist silently does nothing.
const focusIndex = async (index: number): Promise<void> => {
    const row = rows.value[index];
    if (row === undefined) {
        return;
    }
    lead.value = row.key;
    const top = index * ROW_H;
    const el = scroller.value;
    if (el !== undefined) {
        const next = Math.min(top, Math.max(el.scrollTop, top - el.clientHeight + ROW_H));
        el.scrollTop = next;
        scrollTop.value = next;
    }
    await nextTick();
    rowEls.get(row.key)?.focus();
};
const onKeydown = (event: KeyboardEvent): void => {
    const count = rows.value.length;
    if (count === 0) {
        return;
    }
    if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
        const at = leadIndex.value;
        void focusIndex(Math.min(count - 1, Math.max(0, at + (event.key === `ArrowDown` ? 1 : -1))));
        event.preventDefault();
    } else if (event.key === `Home` || event.key === `End`) {
        void focusIndex(event.key === `Home` ? 0 : count - 1);
        event.preventDefault();
    }
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- Pinned above the list: the count is the answer to "did that find anything", and scrolling it away
             costs the reader the one number they came for. -->
        <p v-if="rows.length > 0" class="shrink-0 px-2 pt-1 pb-1 text-2xs text-subtle">{{ summary }}</p>
        <p
            v-if="note"
            class="mx-1.5 mb-1 flex shrink-0 items-start gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-2xs text-warning"
        >
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-[0.6rem]" /><span class="min-w-0">{{ note }}</span>
        </p>
        <div
            ref="scroller"
            class="scrollbar-thin min-h-0 flex-1 overflow-auto"
            role="listbox"
            aria-label="Search results"
            @scroll.passive="onScroll"
            @keydown="onKeydown"
        >
            <!-- The full list's height, so the scrollbar tells the truth about how much there is; the rows
                 inside are only the ones on screen, each placed at its own index. -->
            <div class="relative" :style="{ height: `${rows.length * ROW_H + (truncated ? FOOTER_H : 0)}px` }">
                <template v-for="painted in visible" :key="painted.row.key">
                    <button
                        v-if="painted.row.kind === 'file'"
                        :ref="(el) => setRowEl(painted.row.key, el)"
                        type="button"
                        role="option"
                        :tabindex="tabbableKey === painted.row.key ? 0 : -1"
                        class="treerow absolute inset-x-0 flex items-center gap-1.5 px-2 text-left text-[0.8125rem]"
                        :style="{ top: `${painted.row.index * ROW_H}px`, height: `${ROW_H}px` }"
                        @click="activate(painted.row)"
                        @focus="lead = painted.row.key"
                    >
                        <Icon :name="iconForEntry(basename(painted.row.group.path), 'file', false)" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 truncate text-content/90">{{ basename(painted.row.group.path) }}</span>
                        <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ parentDir(painted.row.group.path) }}</span>
                        <!-- "+" where the engine stopped counting this file's matches, for the same reason the
                             summary carries one. -->
                        <span class="shrink-0 rounded-full bg-overlay px-1.5 text-2xs text-muted"
                            >{{ painted.row.group.hits.length }}{{ painted.row.group.capped ? `+` : `` }}</span
                        >
                    </button>
                    <button
                        v-else
                        :ref="(el) => setRowEl(painted.row.key, el)"
                        type="button"
                        role="option"
                        :tabindex="tabbableKey === painted.row.key ? 0 : -1"
                        class="treerow absolute inset-x-0 flex items-center gap-2 pr-2 pl-6 text-left"
                        :style="{ top: `${painted.row.index * ROW_H}px`, height: `${ROW_H}px` }"
                        @click="activate(painted.row)"
                        @focus="lead = painted.row.key"
                    >
                        <span class="w-7 shrink-0 text-right font-mono text-2xs text-subtle">{{ painted.row.hit.line }}</span>
                        <!-- One <span> per colour token, with the matched run as a <mark> — see searchSnippet.ts. The
                             leading ellipsis says the line was cut to bring a far-right match into view. -->
                        <span class="ws-snippet min-w-0 flex-1 truncate font-mono text-xs text-content/90"
                            ><span v-if="painted.elided" class="text-subtle">…</span
                            ><template v-for="(piece, index) in painted.pieces" :key="index"
                                ><mark v-if="piece.hit" :style="piece.style">{{ piece.text }}</mark
                                ><span v-else :style="piece.style">{{ piece.text }}</span></template
                            ></span
                        >
                    </button>
                </template>
                <!-- The rest of the match set is one request away, and asking for it is the reader's call: each
                     page is a fresh search of the workspace, not a slice of something already held. -->
                <button
                    v-if="truncated"
                    type="button"
                    class="treerow absolute inset-x-0 flex items-center justify-center gap-1.5 text-2xs text-link"
                    :style="{ top: `${rows.length * ROW_H}px`, height: `${FOOTER_H}px` }"
                    :disabled="loadingMore"
                    @click="emit('loadMore')"
                >
                    <Icon :name="loadingMore ? `spinner` : `chevron-down`" :spin="loadingMore" class="text-[0.6rem]" />
                    {{ loadingMore ? `Loading…` : `Show more matches` }}
                </button>
            </div>
        </div>
        <p v-if="error" class="shrink-0 px-3 py-3 text-center text-2xs text-danger">{{ error }}</p>
        <p v-else-if="query.trim().length < 2" class="shrink-0 px-3 py-3 text-center text-2xs text-subtle">
            Type at least 2 characters to search file contents.
        </p>
        <p v-else-if="rows.length === 0 && (searching || pending)" class="shrink-0 px-3 py-3 text-center text-2xs text-subtle">
            <Icon name="spinner" spin />
        </p>
        <p v-else-if="rows.length === 0" class="shrink-0 px-3 py-3 text-center text-2xs text-subtle">No matches in file contents.</p>
    </div>
</template>

<style scoped>
.treerow {
    cursor: pointer;
    transition: background-color 0.1s;
}
.treerow:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
}
.treerow:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
/* Shiki hands each token an inline light colour plus a `--shiki-dark` custom property, so dark mode is a pure
 * CSS flip keyed off the app's [data-mode] — no re-tokenizing on theme toggle. !important because the light
 * colour it overrides is an inline style. Identical to how the app's code blocks do it (ui styles/code.css);
 * on an uncoloured piece the var is unset, which leaves `color` inheriting the row's own. */
[data-mode="dark"] .ws-snippet span,
[data-mode="dark"] .ws-snippet mark {
    color: var(--shiki-dark) !important;
}
/* The match keeps its syntax colour and takes a tinted plate behind it — recolouring the text would cost the
 * one signal the colour just bought. The negative margin pays for the padding, so marking a run doesn't shift
 * the characters after it. */
mark {
    background: color-mix(in srgb, var(--color-primary-500) 28%, transparent);
    color: inherit;
    border-radius: 2px;
    padding-inline: 1px;
    margin-inline: -1px;
}
</style>
