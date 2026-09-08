<script setup lang="ts">
import { Icon, type NavGroup, NavRail, Row, SkeletonRows, useLoadingReveal } from "@intentic/extension-ui";
import { computed, nextTick, watch } from "vue";
import type { SearchHit } from "./contract";
import { iconOfType } from "./knowledgeNote";

// Search results as the pick-from list: the ranking and match reason ARE the answer, so a plain picker can't show them.
// Built from the shared NavRail/Row; one unlabelled group, since results already come pre-ranked. Kind is an icon; a
// second line appears only when the search has something to say.

const { hits, selected, isLoading } = defineProps<{
    hits: readonly SearchHit[];
    selected: string | undefined;
    // Whether a query or a filter is active; an empty result means something different either way.
    filtered: boolean;
    isLoading: boolean;
}>();

const emit = defineEmits<{ pick: [path: string] }>();

// Gated since this reruns every keystroke; an ungated outline would strobe while typing.
const outline = useLoadingReveal(
    computed(() => isLoading),
    computed(() => `note-search`),
);

// Reason text only for alias/tag hits, since their match doesn't otherwise appear on the row.
const REASON: Record<string, string> = { alias: `matched an alias`, tag: `matched a tag` };

interface NoteRow {
    readonly path: string;
    readonly title: string;
    readonly icon: ReturnType<typeof iconOfType>;
    // Set only when the search found something the title can't say: a snippet, or why an alias/tag hit.
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

// Empty array, not one empty group: the rail's #empty only shows with zero groups total.
const groups = computed<NavGroup<NoteRow>[]>(() => (rows.value.length === 0 ? [] : [{ key: `hits`, items: rows.value }]));

// Keeps the open note in view, however it was selected, since that can land on a row scrolled past.
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
                <!-- Only while the search explains itself; with no query the row is title-only, like the hub menu. -->
                <template v-if="row.detail !== undefined" #description>
                    <span class="block truncate leading-tight">{{ row.detail }}</span>
                </template>
            </Row>
        </template>

        <!-- Three different emptinesses: never typed vs. still searching vs. no notes at all. -->
        <template #empty>
            <!-- Skeleton rows instead of a "Looking…" line, so the rail doesn't jump height once results land. -->
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

        <!-- Below the scroll, not at its end: a cap only visible after scrolling past 200 is a cap nobody reads. -->
        <template v-if="rows.length >= 200" #footer>
            <p class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="info-circle" class="shrink-0" />
                Showing the first 200: narrow it with a word, a kind or a tag.
            </p>
        </template>
    </NavRail>
</template>
