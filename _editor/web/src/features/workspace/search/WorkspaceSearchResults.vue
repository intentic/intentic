<script setup lang="ts">
import type { WorkspaceSearchGroup, WorkspaceSearchHit } from "@intentic/api-contract";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { iconForEntry } from "@intentic/ui";
import { codeLangForPath } from "@intentic/code-read";
import { type SnippetPiece, snippetPieces, snippetTokens, snippetWindow } from "./searchSnippet";
import type { OpenMode } from "../tabs/workspaceTabs";
import { basename, parentDir } from "@intentic/ui/path";

// Workspace search results for the explorer sidebar: file header rows plus indented match rows, styled and
// keyboard-navigable like WorkspaceTree but flat. Virtualization is load-bearing: colouring every row overflows the
// highlighter's LRU and the re-render loop never converges, so only the visible window is painted. A row's colour
// comes from the file's own grammar (codeLangForPath); marked spans are pieces from searchSnippet.ts, not v-html.

const { groups, total, files, partial, truncated, searching, pending, loadingMore, error, note, query } = defineProps<{
    groups: readonly WorkspaceSearchGroup[];
    // Total across the whole match set, not just what's rendered below.
    total: number;
    files: number;
    // Whether `total` is a floor: some file had more matches than the engine keeps per file.
    partial: boolean;
    truncated: boolean;
    searching: boolean;
    pending: boolean;
    loadingMore: boolean;
    error?: string;
    // What the engine did that the query didn't ask for, such as rerunning an unparseable regex as literal text.
    note?: string;
    query: string;
}>();
// Mode follows the gesture: click previews, double-click keeps the tab.
const emit = defineEmits<{ openMatch: [path: string, line: number, mode: OpenMode]; loadMore: [] }>();

// Uniform row height enables index arithmetic; overscan covers rows revealed before the next paint.
const ROW_H = 22;
const OVERSCAN = 8;
// How far the Load-more control extends the scroll surface past the last row.
const FOOTER_H = 32;

type ResultRow =
    | { key: string; index: number; kind: "file"; group: WorkspaceSearchGroup }
    | { key: string; index: number; kind: "match"; path: string; lang: string | undefined; hit: WorkspaceSearchHit };

// Row descriptors only, cheap to rebuild at any result-set size; nothing here touches the highlighter.
const rows = computed<ResultRow[]>(() => {
    const list: ResultRow[] = [];
    for (const group of groups) {
        // One resolution per file, not per hit: every hit in a group is a line of the same file.
        const lang = codeLangForPath(group.path);
        list.push({ key: group.path, index: list.length, kind: `file`, group });
        for (const hit of group.hits) {
            list.push({ key: `${group.path}:${hit.line}`, index: list.length, kind: `match`, path: group.path, lang, hit });
        }
    }
    return list;
});

// Roving tabindex over all rows, headers included; the window keeps the focused row rendered even off-screen.
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

// Rows actually rendered, and the only ones ever coloured; the focused row stays in even when off-screen.
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

// `total` and `files` count matching lines, not occurrences, the engine's own unit; the trailing `+` flags a floor,
// either the per-file cap or the scan's row ceiling on broad queries.
const shown = computed(() => groups.reduce((sum, group) => sum + group.hits.length, 0));
const summary = computed(() => {
    // The `+` sits on the number, not the noun (`4,211+ matches`, not `4,211 matches+`).
    const floor = partial ? `+` : ``;
    const matches = `${total.toLocaleString()}${floor} ${total === 1 && !partial ? `match` : `matches`}`;
    const scope = `${matches} in ${files.toLocaleString()}${floor} ${files === 1 && !partial ? `file` : `files`}`;
    return truncated ? `${scope} · showing ${shown.value.toLocaleString()}` : scope;
});

const activate = (row: ResultRow, mode: OpenMode): void => {
    if (row.kind === `file`) {
        const first = row.group.hits[0];
        if (first !== undefined) {
            emit(`openMatch`, row.group.path, first.line, mode);
        }
        return;
    }
    emit(`openMatch`, row.path, row.hit.line, mode);
};

// ---- focus ----
const setRowEl = (key: string, el: unknown): void => {
    if (el) {
        rowEls.set(key, el as HTMLElement);
    } else {
        rowEls.delete(key);
    }
};
// Scrolls before focusing: the target row may not be mounted in a virtualized list yet, so focus() would no-op.
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
        <!-- Pinned above the list: the match count is the one number a searcher comes back to check. -->
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
            <!-- Full-list height keeps the scrollbar honest; only on-screen rows render, each at its own index. -->
            <div class="relative" :style="{ height: `${rows.length * ROW_H + (truncated ? FOOTER_H : 0)}px` }">
                <template v-for="painted in visible" :key="painted.row.key">
                    <button
                        v-if="painted.row.kind === 'file'"
                        :ref="(el) => setRowEl(painted.row.key, el)"
                        type="button"
                        role="option"
                        :tabindex="tabbableKey === painted.row.key ? 0 : -1"
                        class="ui-row-select absolute inset-x-0 flex items-center gap-1.5 px-2 text-left text-[0.8125rem]"
                        :style="{ top: `${painted.row.index * ROW_H}px`, height: `${ROW_H}px` }"
                        @click="activate(painted.row, 'preview')"
                        @dblclick="activate(painted.row, 'keep')"
                        @focus="lead = painted.row.key"
                    >
                        <Icon :name="iconForEntry(basename(painted.row.group.path), 'file', false)" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 truncate text-content/90">{{ basename(painted.row.group.path) }}</span>
                        <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ parentDir(painted.row.group.path) }}</span>
                        <!-- `+` marks a file where the engine stopped counting its matches, same as the summary's `+`. -->
                        <span class="ui-status-pill shrink-0 bg-overlay text-2xs text-muted"
                            >{{ painted.row.group.hits.length }}{{ painted.row.group.capped ? `+` : `` }}</span
                        >
                    </button>
                    <button
                        v-else
                        :ref="(el) => setRowEl(painted.row.key, el)"
                        type="button"
                        role="option"
                        :tabindex="tabbableKey === painted.row.key ? 0 : -1"
                        class="ui-row-select absolute inset-x-0 flex items-center gap-2 pr-2 pl-6 text-left"
                        :style="{ top: `${painted.row.index * ROW_H}px`, height: `${ROW_H}px` }"
                        @click="activate(painted.row, 'preview')"
                        @dblclick="activate(painted.row, 'keep')"
                        @focus="lead = painted.row.key"
                    >
                        <span class="w-7 shrink-0 text-right font-mono text-2xs text-subtle">{{ painted.row.hit.line }}</span>
                        <!--
                            One span per colour token; the matched run is a `<mark>` (see searchSnippet.ts). A leading ellipsis marks a line
                            cut to bring a far-right match into view.
                        -->
                        <span class="ws-snippet min-w-0 flex-1 truncate font-mono text-xs text-content/90"
                            ><span v-if="painted.elided" class="text-subtle">…</span
                            ><template v-for="(piece, index) in painted.pieces" :key="index"
                                ><mark v-if="piece.hit" :style="piece.style">{{ piece.text }}</mark
                                ><span v-else :style="piece.style">{{ piece.text }}</span></template
                            ></span
                        >
                    </button>
                </template>
                <!-- Each page is a fresh workspace search, not a slice already held in memory. -->
                <button
                    v-if="truncated"
                    type="button"
                    class="ui-row-select absolute inset-x-0 flex items-center justify-center gap-1.5 text-2xs text-link"
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
/*
 * Shiki sets an inline light colour plus a `--shiki-dark` custom property; dark mode is a pure CSS override, no
 * re-tokenizing. `!important` beats the inline light colour; an uncoloured piece leaves `color` inherited from the row.
 */
[data-mode="dark"] .ws-snippet span,
[data-mode="dark"] .ws-snippet mark {
    color: var(--shiki-dark) !important;
}
/*
 * Match keeps its syntax colour; only a tinted background is added, since recolouring would lose that signal.
 * Negative margin offsets the padding so marking a run doesn't shift later characters.
 */
mark {
    background: color-mix(in srgb, var(--color-primary-500) 28%, transparent);
    color: inherit;
    border-radius: 2px;
    padding-inline: 1px;
    margin-inline: -1px;
}
</style>
