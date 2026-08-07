<script setup lang="ts">
import type { MemoryFileEntry } from "@intentic/sandbox-contract";
import { cmp, formatBytes, formatTimestamp, Icon, InfoHint, type NavGroup, NavRail, Row, useDevice } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { INDEX_NAME, noteTitle, projectLabel } from "./memoryNote";
import { freshness } from "./noteTime";
import NotePane from "./NotePane.vue";
import { useMemory } from "./useMemory";

/* The memory extension: what the agent carries between sessions — the MEMORY.md index it loads at the start of
 * every one, plus a markdown note per fact, per project. Read it to know what it believes, edit a note to
 * correct it, forget one to take it back.
 *
 * Laid out as index-and-reader rather than a list you scroll past. The two questions asked here are "what does
 * it know?" and "is THIS right?", and they alternate — so the index stays on screen while a note is read, and
 * picking the next one never costs a scroll back up. On a phone there is only room for one at a time, so the
 * reader takes over and offers a way back.
 *
 * A HUB SECTION, so the page chrome is the hub's and this file draws neither a title nor a frame (see
 * extension.ts for why it left the rail). The index-and-reader split is kept and hand-rolled here rather than
 * taken from <SplitView>, which is a PAGE: it brings a header, a width cap and a 16rem column, and the hub has
 * already spent all three. The notes index is deliberately narrower than the hub's own so the two read as
 * different levels of the same tree rather than as two rails arguing. */

const { mobile } = useDevice();
const { files, error, isLoading } = useMemory();

const selected = ref<{ project: string; name: string }>();
const query = ref(``);

/* Unsaved edits, keyed by note. Held here, above the reader, because the reader is REUSED as the selection
 * moves — without this, reading another note to check a fact would silently drop the correction being written.
 * A note with a draft says so in the list, so an edit left open can be found again. */
const keyOf = (project: string, name: string): string => `${project}/${name}`;
const drafts = ref(new Map<string, string>());
const draft = computed<string | undefined>({
    get: () => (selected.value === undefined ? undefined : drafts.value.get(keyOf(selected.value.project, selected.value.name))),
    set: (value) => {
        if (selected.value === undefined) {
            return;
        }
        const key = keyOf(selected.value.project, selected.value.name);
        if (value === undefined) {
            drafts.value.delete(key);
        } else {
            drafts.value.set(key, value);
        }
    },
});

/* One section per project, MEMORY.md pinned first — it is the map to everything under it — and the rest left
 * in the daemon's newest-first order, so what the agent learned most recently leads. Projects keep that order
 * too: the one being worked in is the one that just wrote a note. */
const groups = computed<NavGroup<MemoryFileEntry>[]>(() => {
    const needle = query.value.trim().toLowerCase();
    const matches = (file: MemoryFileEntry): boolean =>
        needle === `` || file.name.toLowerCase().includes(needle) || noteTitle(file.name).toLowerCase().includes(needle);
    const byProject = new Map<string, MemoryFileEntry[]>();
    for (const file of files.value.filter(matches)) {
        byProject.set(file.project, [...(byProject.get(file.project) ?? []), file]);
    }
    const projects = [...byProject.entries()];
    return projects.map(([project, entries]) => ({
        key: project,
        // Only worth a heading when there is something to tell apart: with one project every row belongs to it,
        // and the path is a line of chrome above the content.
        label: projects.length > 1 ? projectLabel(project) : undefined,
        items: entries.toSorted((a, b) => Number(b.name === INDEX_NAME) - Number(a.name === INDEX_NAME)),
    }));
});
const visibleCount = computed(() => groups.value.reduce((total, group) => total + group.items.length, 0));

const projectCount = computed(() => new Set(files.value.map((file) => file.project)).size);
const totalBytes = computed(() => files.value.reduce((total, file) => total + file.sizeBytes, 0));

const isSelected = (file: MemoryFileEntry): boolean => selected.value?.project === file.project && selected.value.name === file.name;
const rowTitle = (name: string): string => (name === INDEX_NAME ? `Index` : noteTitle(name));
const selectedEntry = computed(() => files.value.find((file) => isSelected(file)));

/* Open on the index instead of an empty half-screen: it is the one note that summarises all the others, and it
 * is what the agent itself reads first. Only where both panes fit — on a phone the reader covers the list, and
 * landing inside a note the user didn't pick would hide the very thing they came to see. */
watch(
    [files, mobile],
    () => {
        if (selected.value === undefined && !mobile.value) {
            const first = groups.value[0];
            const index = first?.items.find((file) => file.name === INDEX_NAME) ?? first?.items[0];
            if (index !== undefined) {
                selected.value = { project: index.project, name: index.name };
            }
        }
    },
    { immediate: true },
);

// A reference inside a note names a sibling in the SAME project — memory notes never cross projects.
const openSibling = (name: string): void => {
    if (selected.value !== undefined) {
        selected.value = { project: selected.value.project, name };
    }
};

/* WHICH PANE A PHONE SHOWS. The index SELECTS a document, so going into one is the point and there is no room to
 * do it beside the list: the phone shows the list, then the note, with a way back (NotePane's own header carries
 * it, which is why `standalone` is the same condition). Desktop shows both. */
const showIndex = computed(() => !mobile.value || selected.value === undefined);
const showNote = computed(() => !mobile.value || selected.value !== undefined);
</script>

<template>
    <!-- A HUB SECTION BODY — no page header and no frame of its own: the hub draws both. -->
    <div class="flex flex-col gap-3">
        <div v-if="error" :class="cmp.alertDanger('px-4 py-3 text-sm')">{{ error }}</div>

        <!-- What the whole set amounts to, and what the set IS. Both rode the page header until this became a
             section and the page header stopped being this view's; they belong together anyway — the sentence
             explaining what a memory note is, and the count of how many there are. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <InfoHint label="Memory">
                <span class="block text-sm font-medium text-content">Agent memory</span>
                <span class="mt-1 block text-xs text-muted">
                    The agent keeps a persistent memory per project: <b>MEMORY.md</b> — the index it loads at the start of every session — plus one
                    markdown note per fact (who you are, feedback it was given, project context, references). Edit a note to correct it, or forget it
                    to take the fact back. References between notes are links: follow them to read the chain.
                </span>
            </InfoHint>
            <span v-if="files.length > 0" class="text-2xs text-subtle">
                {{ files.length }} {{ files.length === 1 ? `note` : `notes` }} · {{ projectCount }}
                {{ projectCount === 1 ? `project` : `projects` }} · {{ formatBytes(totalBytes) }}
            </span>
        </div>

        <!-- Bounded, so the index and the note each keep their own scroll and their own place. Unbounded, the
             hub page would scroll them together and reaching note 50 would scroll the note itself off screen —
             which is the exact failure <SplitView> exists to prevent on the pages that still use it. -->
        <div class="flex max-h-[68dvh] min-h-0 gap-4" :class="mobile ? `flex-col` : `flex-row`">
            <!-- Narrower than the hub's own 16rem index, so the two columns read as different levels rather than
                 as a pair. Full width on a phone, where it is the only thing on screen. -->
            <div v-if="showIndex" class="flex min-h-0 flex-col" :class="mobile ? `` : `w-56 shrink-0`">
                <NavRail v-model="query" :groups="groups" :count="visibleCount" filterable placeholder="Filter notes…">
                    <template #row="{ item: file }">
                        <Row
                            :key="`${file.project}/${file.name}`"
                            as="button"
                            density="dense"
                            :icon="file.name === INDEX_NAME ? `sparkles` : `file`"
                            :title="rowTitle(file.name)"
                            :selected="isSelected(file)"
                            class="rounded-md"
                            @click="selected = { project: file.project, name: file.name }"
                        >
                            <template #title>
                                <span class="flex items-center gap-1.5">
                                    <span class="min-w-0 truncate">{{ rowTitle(file.name) }}</span>
                                    <span
                                        v-if="drafts.has(`${file.project}/${file.name}`)"
                                        class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                        v-tooltip.top="'Unsaved changes'"
                                    ></span>
                                </span>
                            </template>
                            <template #description>
                                <span class="flex items-center gap-1.5">
                                    <span class="min-w-0 truncate font-mono">{{ file.name }}</span>
                                    <span aria-hidden="true">·</span>
                                    <span class="shrink-0" :title="formatTimestamp(file.modifiedAt)">{{ freshness(file.modifiedAt) }}</span>
                                </span>
                            </template>
                        </Row>
                    </template>
                    <template #empty>
                        <p class="px-2 py-6 text-center text-xs text-muted">No note matches “{{ query.trim() }}”.</p>
                    </template>
                </NavRail>
            </div>

            <div v-if="showNote" class="flex min-h-0 min-w-0 flex-1 flex-col">
                <p v-if="files.length === 0 && isLoading" class="text-sm text-muted">Loading…</p>

                <div v-else-if="files.length === 0" :class="cmp.emptyState('flex flex-col items-center gap-2 px-6 py-12 text-sm')">
                    <Icon name="sparkles" class="text-base text-subtle" />
                    <p class="text-content">Nothing remembered yet.</p>
                    <p class="max-w-sm text-xs text-muted">
                        Notes appear here as the agent saves what it learns while working — how you like things done, how this repo is put together,
                        what it was corrected on.
                    </p>
                </div>

                <!-- Keyed by note so a switch resets its scroll and view mode, but the draft above it is keyed by
                     note too and so survives the remount. -->
                <NotePane
                    v-else-if="selected"
                    :key="`${selected.project}/${selected.name}`"
                    v-model:draft="draft"
                    :project="selected.project"
                    :name="selected.name"
                    :entry="selectedEntry"
                    :standalone="mobile"
                    @open="openSibling"
                    @forgotten="selected = undefined"
                    @back="selected = undefined"
                />

                <section
                    v-else
                    class="flex min-h-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center"
                >
                    <Icon name="sparkles" class="text-base text-subtle" />
                    <p class="text-sm text-muted">Pick a note to read it.</p>
                    <p class="max-w-xs text-xs text-subtle">Start with <b>Index</b> — it's the map the agent itself opens first.</p>
                </section>
            </div>
        </div>
    </div>
</template>
