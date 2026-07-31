<script setup lang="ts">
import type { WorkspaceSearchGroup } from "@intentic-app/api-contract";
import { computed, nextTick, ref } from "vue";
import { iconForEntry } from "@intentic-app/ui";
import { codeLangForPath } from "./fileType";
import { type SnippetPiece, snippetPieces, snippetTokens, snippetWindow } from "./searchSnippet";

/* Workspace search results for the explorer sidebar: relevance-ranked file header rows + indented hit rows (line
 * number + snippet, syntax-coloured, with the hit <mark>ed via the daemon's start/end offsets when present —
 * semantic hits carry none and render unmarked; no client-side re-matching, no v-html). Clicking a hit (or a
 * header, which stands in for its first hit) opens the file at that line. Same dense row styling and
 * roving-tabindex keyboard nav as WorkspaceTree, minus the tree logic — the list is flat.
 *
 * A snippet's colour comes from the file's own grammar — the same extension→language resolution the editor
 * uses (codeLangForPath), so a row reads the way the file it points at will. The pieces, and why they are
 * pieces rather than Shiki's HTML, are searchSnippet.ts. */

const { groups, truncated, searching, pending, error, query } = defineProps<{
    groups: readonly WorkspaceSearchGroup[];
    truncated: boolean;
    searching: boolean;
    pending: boolean;
    error?: string;
    query: string;
}>();
const emit = defineEmits<{ openMatch: [path: string, line: number] }>();

type ResultRow =
    | { key: string; kind: "file"; group: WorkspaceSearchGroup }
    | { key: string; kind: "match"; path: string; line: number; elided: boolean; pieces: readonly SnippetPiece[] };

const rows = computed<ResultRow[]>(() => {
    const list: ResultRow[] = [];
    for (const group of groups) {
        // One resolution per file, not per hit — every hit in a group is a line of the same file.
        const lang = codeLangForPath(group.path);
        list.push({ key: group.path, kind: `file`, group });
        for (const hit of group.hits) {
            const snippet = snippetWindow(hit);
            list.push({
                key: `${group.path}:${hit.line}`,
                kind: `match`,
                path: group.path,
                line: hit.line,
                elided: snippet.elided,
                pieces: snippetPieces(snippet, snippetTokens(snippet.text, lang)),
            });
        }
    }
    return list;
});

const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);

const activate = (row: ResultRow): void => {
    if (row.kind === `file`) {
        const first = row.group.hits[0];
        if (first !== undefined) {
            emit(`openMatch`, row.group.path, first.line);
        }
        return;
    }
    emit(`openMatch`, row.path, row.line);
};

// ---- focus (roving tabindex over all rows, headers included) ----
const lead = ref<string | null>(null);
const rowEls = new Map<string, HTMLElement>();
const keys = computed(() => rows.value.map((row) => row.key));
const tabbableKey = computed<string | null>(() => (lead.value !== null && keys.value.includes(lead.value) ? lead.value : (keys.value[0] ?? null)));
const setRowEl = (key: string, el: unknown): void => {
    if (el) {
        rowEls.set(key, el as HTMLElement);
    } else {
        rowEls.delete(key);
    }
};
const focusKey = async (key: string): Promise<void> => {
    lead.value = key;
    await nextTick();
    const el = rowEls.get(key);
    el?.focus();
    el?.scrollIntoView({ block: `nearest` });
};
const onKeydown = (event: KeyboardEvent): void => {
    const order = keys.value;
    if (order.length === 0) {
        return;
    }
    if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
        const at = lead.value === null ? -1 : order.indexOf(lead.value);
        const next = order[Math.min(order.length - 1, Math.max(0, at + (event.key === `ArrowDown` ? 1 : -1)))];
        if (next !== undefined) {
            void focusKey(next);
        }
        event.preventDefault();
    } else if (event.key === `Home` || event.key === `End`) {
        const next = event.key === `Home` ? order[0] : order[order.length - 1];
        if (next !== undefined) {
            void focusKey(next);
        }
        event.preventDefault();
    }
};
</script>

<template>
    <div class="min-h-full" role="listbox" aria-label="Search results" @keydown="onKeydown">
        <p
            v-if="truncated"
            class="mx-1.5 mb-1 inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-2xs text-warning"
        >
            <Icon name="exclamation-triangle" class="text-[0.6rem]" /> Showing first matches only.
        </p>
        <template v-for="row in rows" :key="row.key">
            <button
                v-if="row.kind === 'file'"
                :ref="(el) => setRowEl(row.key, el)"
                type="button"
                role="option"
                :tabindex="tabbableKey === row.key ? 0 : -1"
                class="treerow flex w-full items-center gap-1.5 px-2 py-1 text-left text-[0.8125rem]"
                @click="activate(row)"
                @focus="lead = row.key"
            >
                <Icon :name="iconForEntry(basename(row.group.path), 'file', false)" class="shrink-0 text-2xs text-muted" />
                <span class="min-w-0 truncate text-content/90">{{ basename(row.group.path) }}</span>
                <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ parentDir(row.group.path) }}</span>
                <span class="shrink-0 rounded-full bg-overlay px-1.5 text-2xs text-muted">{{ row.group.hits.length }}</span>
            </button>
            <button
                v-else
                :ref="(el) => setRowEl(row.key, el)"
                type="button"
                role="option"
                :tabindex="tabbableKey === row.key ? 0 : -1"
                class="treerow flex w-full items-center gap-2 py-0.5 pr-2 pl-6 text-left"
                @click="activate(row)"
                @focus="lead = row.key"
            >
                <span class="w-7 shrink-0 text-right font-mono text-2xs text-subtle">{{ row.line }}</span>
                <!-- One <span> per colour token, with the matched run as a <mark> — see searchSnippet.ts. The
                     leading ellipsis says the line was cut to bring a far-right match into view. -->
                <span class="ws-snippet min-w-0 flex-1 truncate font-mono text-xs text-content/90"
                    ><span v-if="row.elided" class="text-subtle">…</span
                    ><template v-for="(piece, index) in row.pieces" :key="index"
                        ><mark v-if="piece.hit" :style="piece.style">{{ piece.text }}</mark
                        ><span v-else :style="piece.style">{{ piece.text }}</span></template
                    ></span
                >
            </button>
        </template>
        <p v-if="error" class="px-3 py-3 text-center text-2xs text-danger">{{ error }}</p>
        <p v-else-if="query.trim().length < 2" class="px-3 py-3 text-center text-2xs text-subtle">
            Type at least 2 characters to search file contents.
        </p>
        <p v-else-if="rows.length === 0 && (searching || pending)" class="px-3 py-3 text-center text-2xs text-subtle">
            <Icon name="spinner" spin />
        </p>
        <p v-else-if="rows.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">No matches in file contents.</p>
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
