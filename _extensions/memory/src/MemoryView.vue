<script setup lang="ts">
import type { MemoryFileEntry } from "./contract";
import { ui, formatBytes, freshness, Icon, InfoHint, Notice, noticeOf, Picker, type PickerOptions, useKeyedDraft } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { INDEX_NAME, noteTitle, projectLabel } from "./memoryNote";
import MemoryPane from "./MemoryPane.vue";
import { useMemory } from "./useMemory";

/* The memory extension: what the agent carries between sessions, the MEMORY.md index it loads at the start of
 * every one, plus a markdown note per fact, per project. Read it to know what it believes, edit a note to
 * correct it, forget one to take it back.
 *
 * WHICH NOTE IS A PICKER, NOT A SECOND RAIL. This was an index column beside the reader, and as a hub section
 * that put two navigation columns side by side: the hub's 16rem rail, then a 14rem one, then whatever was
 * left for the note. The note is the content and it was getting the smallest third of the width. A picker says
 * the same thing (every note, grouped by project, filterable once the list is long) in one control on the row
 * the section header already occupies, and hands the whole remaining width to the prose.
 *
 * It costs nothing that the rail was carrying, because the set is ALSO listed inside the view: MEMORY.md is a
 * table of contents to its siblings and its entries are real links (see linkifyNoteRefs), so "what does it
 * know?" is answered by the note that opens first rather than by chrome beside it.
 *
 * A HUB SECTION, so the page chrome is the hub's and this file draws neither a title nor a frame (see
 * extension.ts for why it left the rail). */

const { files, error, isLoading } = useMemory();

/* THE SELECTION IS ONE STRING, `project/name`: the picker's option value, the draft map's key and the
 * reader's remount key are all the same identity, so none of them can drift from the others. A project
 * directory never contains a slash (see projectLabel), so the first one splits it back apart. */
const keyOf = (project: string, name: string): string => `${project}/${name}`;
const selected = ref<string>();
const note = computed(() => {
    if (selected.value === undefined) {
        return undefined;
    }
    const cut = selected.value.indexOf(`/`);
    return { project: selected.value.slice(0, cut), name: selected.value.slice(cut + 1) };
});
const selectedEntry = computed(() => files.value.find((file) => keyOf(file.project, file.name) === selected.value));

const { draft, hasDraft } = useKeyedDraft(selected);

const noteLabel = (name: string): string => (name === INDEX_NAME ? `Index` : noteTitle(name));

/* One group per project, MEMORY.md pinned first: it is the map to everything under it, and the rest left in
 * the daemon's newest-first order, so what the agent learned most recently leads. Projects keep that order
 * too: the one being worked in is the one that just wrote a note.
 *
 * The annotation is when the note was last written, EXCEPT while an edit is open on it, where the fact worth
 * the space is that the edit exists: that is what makes an abandoned correction findable again. */
const options = computed<PickerOptions>(() => {
    const byProject = new Map<string, MemoryFileEntry[]>();
    for (const file of files.value) {
        byProject.set(file.project, [...(byProject.get(file.project) ?? []), file]);
    }
    const projects = [...byProject.entries()];
    return projects.map(([project, entries]) => ({
        // Only worth a heading when there is something to tell apart: with one project every row belongs to it,
        // and the path is a line of chrome above the content.
        label: projects.length > 1 ? projectLabel(project) : undefined,
        options: entries
            .toSorted((a, b) => Number(b.name === INDEX_NAME) - Number(a.name === INDEX_NAME))
            .map((file) => ({
                value: keyOf(file.project, file.name),
                label: noteLabel(file.name),
                icon: file.name === INDEX_NAME ? (`sparkles` as const) : (`file` as const),
                description: hasDraft(keyOf(file.project, file.name)) ? `Unsaved` : freshness(file.modifiedAt),
            })),
    }));
});

const projectCount = computed(() => new Set(files.value.map((file) => file.project)).size);
const totalBytes = computed(() => files.value.reduce((total, file) => total + file.sizeBytes, 0));

/* Open on the index instead of an empty pane: it is the one note that summarises all the others, and it is
 * what the agent itself reads first. Every width does this now: the picker sits above the reader rather than
 * in front of it, so landing in a note hides nothing the reader came for. */
watch(
    files,
    () => {
        if (selected.value !== undefined) {
            return;
        }
        const first = files.value[0];
        const opening = files.value.find((file) => file.project === first?.project && file.name === INDEX_NAME) ?? first;
        if (opening !== undefined) {
            selected.value = keyOf(opening.project, opening.name);
        }
    },
    { immediate: true },
);

// A reference inside a note names a sibling in the SAME project: memory notes never cross projects.
const openSibling = (name: string): void => {
    if (note.value !== undefined) {
        selected.value = keyOf(note.value.project, name);
    }
};
</script>

<template>
    <!-- A HUB SECTION BODY, no page header and no frame of its own: the hub draws both. -->
    <div class="flex flex-col gap-3">
        <Notice v-if="error" :of="noticeOf(error)" />

        <!-- The section's one row of chrome: what a memory note is, which one is open, and what the whole set
             amounts to. The picker rides here rather than above the reader because this row exists anyway:
             navigation that costs no vertical space of its own is the entire reason it stopped being a column. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <InfoHint label="Memory">
                <span class="block text-sm font-medium text-content">Agent memory</span>
                <span class="mt-1 block text-xs text-muted">
                    The agent keeps a persistent memory per project: <b>MEMORY.md</b>, the index it loads at the start of every session, plus one
                    markdown note per fact (who you are, feedback it was given, project context, references). Edit a note to correct it, or forget it
                    to take the fact back. References between notes are links: follow them to read the chain.
                </span>
            </InfoHint>

            <!-- A fixed width, so the control does not resize itself every time a longer note is picked. -->
            <Picker
                v-if="files.length > 0"
                v-model="selected"
                :options="options"
                class="w-64 max-w-full py-1.5 text-xs"
                aria-label="Note"
                header="Notes"
                placeholder="Pick a note…"
            />

            <span v-if="files.length > 0" class="ml-auto text-2xs text-subtle">
                {{ files.length }} {{ files.length === 1 ? `note` : `notes` }} · {{ projectCount }}
                {{ projectCount === 1 ? `project` : `projects` }} · {{ formatBytes(totalBytes) }}
            </span>
        </div>

        <!-- Bounded, so the note scrolls inside its own frame and the picker above it stays put. Unbounded, the
             hub page would scroll them together and reaching the end of a long note would take the way to the
             next one off screen with it. -->
        <div class="flex max-h-panel-lg min-h-0 flex-col">
            <p v-if="files.length === 0 && isLoading" class="text-sm text-muted">Loading…</p>

            <div v-else-if="files.length === 0" :class="ui.emptyState('flex flex-col items-center gap-2 px-6 py-12 text-sm')">
                <Icon name="sparkles" class="text-base text-subtle" />
                <p class="text-content">Nothing remembered yet.</p>
                <p class="max-w-sm text-xs text-muted">
                    Notes appear here as the agent saves what it learns while working: how you like things done, how this repo is put together, what
                    it was corrected on.
                </p>
            </div>

            <!-- Keyed by note so a switch resets its scroll and view mode, but the draft above it is keyed by
                 note too and so survives the remount. -->
            <MemoryPane
                v-else-if="note"
                :key="selected"
                v-model:draft="draft"
                :project="note.project"
                :name="note.name"
                :entry="selectedEntry"
                @open="openSibling"
                @forgotten="selected = undefined"
            />

            <section
                v-else
                class="flex min-h-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center"
            >
                <Icon name="sparkles" class="text-base text-subtle" />
                <p class="text-sm text-muted">Pick a note to read it.</p>
                <p class="max-w-xs text-xs text-subtle">Start with <b>Index</b>: it's the map the agent itself opens first.</p>
            </section>
        </div>
    </div>
</template>
