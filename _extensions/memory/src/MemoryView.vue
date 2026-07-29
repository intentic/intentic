<script setup lang="ts">
import type { MemoryFileEntry } from "@intentic/sandbox-contract";
import { cmp, formatBytes, Icon, InfoHint, Page, PageHeader, useDevice } from "@intentic/extension-ui";
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
 * reader takes over and offers a way back. */

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
const groups = computed(() => {
    const needle = query.value.trim().toLowerCase();
    const matches = (file: MemoryFileEntry): boolean =>
        needle === `` || file.name.toLowerCase().includes(needle) || noteTitle(file.name).toLowerCase().includes(needle);
    const byProject = new Map<string, MemoryFileEntry[]>();
    for (const file of files.value.filter(matches)) {
        byProject.set(file.project, [...(byProject.get(file.project) ?? []), file]);
    }
    return [...byProject.entries()].map(([project, entries]) => ({
        project,
        entries: entries.toSorted((a, b) => Number(b.name === INDEX_NAME) - Number(a.name === INDEX_NAME)),
    }));
});
const visibleCount = computed(() => groups.value.reduce((total, group) => total + group.entries.length, 0));

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
            const index = first?.entries.find((file) => file.name === INDEX_NAME) ?? first?.entries[0];
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

const showIndex = computed(() => !mobile.value || selected.value === undefined);
const showReader = computed(() => !mobile.value || selected.value !== undefined);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <Page width="wide" class="flex min-h-0 flex-1 flex-col">
            <PageHeader title="Memory" description="What the agent remembers across sessions — reviewable, editable, forgettable.">
                <template #info>
                    <InfoHint label="Memory">
                        <span class="block text-sm font-medium text-content">Agent memory</span>
                        <span class="mt-1 block text-xs text-muted">
                            The agent keeps a persistent memory per project: <b>MEMORY.md</b> — the index it loads at the start of every session —
                            plus one markdown note per fact (who you are, feedback it was given, project context, references). Edit a note to
                            correct it, or forget it to take the fact back. References between notes are links: follow them to read the chain.
                        </span>
                    </InfoHint>
                </template>
                <template v-if="files.length > 0" #actions>
                    <span class="text-2xs text-subtle">
                        {{ files.length }} {{ files.length === 1 ? `note` : `notes` }} · {{ projectCount }}
                        {{ projectCount === 1 ? `project` : `projects` }} · {{ formatBytes(totalBytes) }}
                    </span>
                </template>
            </PageHeader>

            <div v-if="error" :class="cmp.alertDanger('mb-4 px-4 py-3 text-sm')">{{ error }}</div>

            <p v-if="files.length === 0 && isLoading" class="text-sm text-muted">Loading…</p>

            <div
                v-else-if="files.length === 0"
                :class="cmp.emptyState('flex flex-col items-center gap-2 px-6 py-12 text-sm')"
            >
                <Icon name="sparkles" class="text-base text-subtle" />
                <p class="text-content">Nothing remembered yet.</p>
                <p class="max-w-sm text-xs text-muted">
                    Notes appear here as the agent saves what it learns while working — how you like things done, how this repo is put together,
                    what it was corrected on.
                </p>
            </div>

            <div v-else class="grid min-h-0 flex-1 gap-4 md:grid-cols-[19rem_minmax(0,1fr)]">
                <!-- The index. Scrolls on its own so reading a long note never scrolls the list away. -->
                <section v-if="showIndex" class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-card">
                    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                        <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                        <input
                            v-model="query"
                            type="search"
                            placeholder="Filter notes…"
                            aria-label="Filter notes"
                            class="min-w-0 flex-1 bg-transparent text-xs text-content placeholder:text-subtle focus:outline-none"
                        />
                        <span v-if="query.trim() !== ``" class="shrink-0 text-2xs text-subtle">{{ visibleCount }}</span>
                    </div>

                    <div class="scrollbar-thin min-h-0 flex-1 overflow-auto p-1.5">
                        <p v-if="visibleCount === 0" class="px-2 py-6 text-center text-xs text-muted">No note matches “{{ query.trim() }}”.</p>
                        <div v-for="group in groups" :key="group.project" class="mb-3 last:mb-0">
                            <!-- Only worth a heading when there is something to tell apart: with one project
                                 every row belongs to it, and the path is a line of chrome above the content. -->
                            <p v-if="groups.length > 1" class="truncate px-2 pb-1 font-mono text-2xs text-subtle/70" :title="group.project">
                                {{ projectLabel(group.project) }}
                            </p>
                            <button
                                v-for="file in group.entries"
                                :key="`${file.project}/${file.name}`"
                                type="button"
                                class="group flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors"
                                :class="isSelected(file) ? `bg-overlay` : `hover:bg-hover`"
                                @click="selected = { project: file.project, name: file.name }"
                            >
                                <Icon
                                    :name="file.name === INDEX_NAME ? `sparkles` : `file`"
                                    class="mt-0.5 shrink-0 text-2xs"
                                    :class="isSelected(file) ? `text-link` : `text-subtle`"
                                />
                                <span class="min-w-0 flex-1">
                                    <span class="flex items-center gap-1.5">
                                        <span
                                            class="min-w-0 flex-1 truncate text-xs"
                                            :class="isSelected(file) ? `font-medium text-content` : `text-muted group-hover:text-content`"
                                        >
                                            {{ rowTitle(file.name) }}
                                        </span>
                                        <span
                                            v-if="drafts.has(`${file.project}/${file.name}`)"
                                            class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                                            v-tooltip.top="'Unsaved changes'"
                                        ></span>
                                    </span>
                                    <span class="mt-0.5 flex items-center gap-1.5 text-2xs text-subtle">
                                        <span class="min-w-0 truncate font-mono">{{ file.name }}</span>
                                        <span aria-hidden="true">·</span>
                                        <span class="shrink-0" :title="new Date(file.modifiedAt).toLocaleString()">{{ freshness(file.modifiedAt) }}</span>
                                    </span>
                                </span>
                            </button>
                        </div>
                    </div>
                </section>

                <!-- The reader. Keyed by note so a switch resets its scroll and view mode, but the draft above
                     it is keyed by note too and so survives the remount. -->
                <NotePane
                    v-if="showReader && selected"
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
                    v-else-if="showReader"
                    class="flex min-h-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center"
                >
                    <Icon name="sparkles" class="text-base text-subtle" />
                    <p class="text-sm text-muted">Pick a note to read it.</p>
                    <p class="max-w-xs text-xs text-subtle">Start with <b>Index</b> — it's the map the agent itself opens first.</p>
                </section>
            </div>
        </Page>
    </div>
</template>
