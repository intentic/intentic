<script setup lang="ts">
import { cmp, Icon, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
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
 * One row is one note and the whole row is the target, because these rows are aimed at with a thumb as often as
 * with a mouse. */

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

const rows = computed(() =>
    hits.map((hit) => {
        // The folder is only worth the line when it says something the badge does not. `kb new` files a note
        // under its own kind, so for most of the vault the folder IS the kind — printed here it read as the
        // word "person" twice on one row, which is how a reader learns to stop reading the second line.
        const folder = folderOf(hit.path);
        return {
            path: hit.path,
            title: hit.title,
            type: hit.type,
            snippet: hit.snippet,
            modifiedAt: hit.modifiedAt,
            folder: folder === hit.type ? undefined : folder,
            why: WHY[hit.matched] ?? hit.matched,
            variant: toneOfType(hit.type) as StatusVariant,
        };
    }),
);
</script>

<template>
    <div class="flex min-h-0 flex-col">
        <p v-if="isLoading && rows.length === 0" class="px-3 py-4 text-xs text-subtle">Looking…</p>

        <p v-else-if="rows.length === 0 && filtered" class="px-3 py-4 text-xs text-muted">
            Nothing in the vault matches. The agent's <b>kb</b> command searches the same notes — and a link to a note nobody has written yet is a
            perfectly good way to leave a gap for later.
        </p>

        <p v-else-if="rows.length === 0" class="px-3 py-4 text-xs text-muted">No notes yet.</p>

        <ul v-else class="min-h-0 flex-1 overflow-y-auto">
            <li v-for="row in rows" :key="row.path">
                <button
                    type="button"
                    class="w-full border-b border-line/60 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
                    :class="row.path === selected ? `bg-surface-hover` : undefined"
                    :aria-current="row.path === selected ? `true` : undefined"
                    @click="emit(`pick`, row.path)"
                >
                    <span class="flex items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate text-sm text-content">{{ row.title }}</span>
                        <StatusBadge v-if="row.type" :variant="row.variant" size="xs" :label="row.type" />
                    </span>
                    <!-- The evidence: the sentence a body match was found on, the fact a header match was, or
                         where the note lives when it matched by name and there is nothing to quote. -->
                    <span class="mt-0.5 flex items-center gap-1.5 text-2xs text-subtle">
                        <span v-if="row.why" class="shrink-0 uppercase tracking-wide">{{ row.why }}</span>
                        <span class="min-w-0 flex-1 truncate">{{ row.snippet ?? row.folder ?? row.path }}</span>
                        <span class="shrink-0">{{ freshness(row.modifiedAt) }}</span>
                    </span>
                </button>
            </li>
        </ul>

        <p v-if="rows.length >= 200" :class="cmp.emptyState(`flex items-center gap-1.5 px-3 py-2 text-2xs`)">
            <Icon name="info-circle" class="text-subtle" />
            Showing the first 200 — narrow it with a word, a kind or a tag.
        </p>
    </div>
</template>
