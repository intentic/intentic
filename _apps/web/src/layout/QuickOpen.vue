<script setup lang="ts">
import type { WorkspaceSearchMode } from "@intentic-app/api-contract";
import Dialog from "primevue/dialog";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { commands, executeCommand, type RegisteredCommand } from "../composables/commands/useCommands";
import { useQuickOpen } from "../composables/useQuickOpen";
import { useWorkspaceSearch } from "../composables/workspace/useWorkspaceSearch";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import { iconForEntry } from "@intentic-app/ui";

/* Quick Open (VSCode Ctrl/Cmd+P): a top-anchored palette that ranks /work files by name as you type — the sandbox
 * daemon's `files` search — and opens the pick as an editor tab. Mounted once in the desktop shell and opened
 * from its global keydown. Server-ranked: no local tree load, no client-side fuzzy matcher. Below the 2-char
 * search floor it offers the open tabs as jump targets so Enter always has somewhere to go. A `>` prefix flips
 * the palette to COMMAND mode (VSCode's Ctrl+Shift+P folded into the same field), filtering the command
 * registry (useCommands) instead of files. */

const { isOpen } = useQuickOpen();
const router = useRouter();
const { tabs } = useWorkspaceTabs();

const query = ref(``);
const mode = ref<WorkspaceSearchMode>(`files`);
// `>` prefix = command mode; the rest of the text filters registered commands by title or id.
const commandMode = computed(() => query.value.trimStart().startsWith(`>`));
const commandQuery = computed(() => query.value.trimStart().slice(1).trim().toLowerCase());
const commandRows = computed<readonly RegisteredCommand[]>(() =>
    commands.value.filter(
        (entry) => entry.title.toLowerCase().includes(commandQuery.value) || entry.command.toLowerCase().includes(commandQuery.value),
    ),
);
// The daemon query stays idle until the palette is open, the query clears the 2-char floor, AND we're not in
// command mode (a ">foo" query would otherwise search files for the literal text).
const searchActive = computed(() => isOpen.value && !commandMode.value);
const { groups, searching, pending, truncated, error } = useWorkspaceSearch(query, searchActive, mode);

const input = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const rowEls = new Map<string, HTMLElement>();

const openTabPaths = computed<readonly string[]>(() => tabs.value.flatMap((tab) => (tab.kind === `file` ? [tab.path] : [])));
const showingRecents = computed(() => query.value.trim().length < 2);
const rows = computed<readonly string[]>(() => (showingRecents.value ? openTabPaths.value : groups.value.map((group) => group.path)));
const rowCount = computed(() => (commandMode.value ? commandRows.value.length : rows.value.length));

// Snap the highlight back to the top whenever the result set changes under it.
watch([rows, commandRows], () => (activeIndex.value = 0));

const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);

const setRowEl = (path: string, el: unknown): void => {
    if (el) {
        rowEls.set(path, el as HTMLElement);
    } else {
        rowEls.delete(path);
    }
};

const open = (path: string): void => {
    // Navigate to the file's workspace URL; the Workspace's useWorkspaceRoute opens it (on mount or via its
    // route watcher), so this works whether we're already on /workspace or coming from another area.
    void router.push({ name: `workspace`, params: { path: path.split(`/`) } });
    isOpen.value = false;
};

const run = (entry: RegisteredCommand): void => {
    isOpen.value = false;
    // A throwing command is its owner's bug — contain it to the console, never the palette.
    void Promise.resolve(executeCommand(entry.command)).catch((caught: unknown) => console.error(`command ${entry.command} failed`, caught));
};

const move = (delta: number): void => {
    const count = rowCount.value;
    if (count === 0) {
        return;
    }
    activeIndex.value = (activeIndex.value + delta + count) % count;
    const key = commandMode.value ? commandRows.value[activeIndex.value]?.command : rows.value[activeIndex.value];
    rowEls.get(key ?? ``)?.scrollIntoView({ block: `nearest` });
};

const openActive = (): void => {
    if (commandMode.value) {
        const entry = commandRows.value[activeIndex.value];
        if (entry !== undefined) {
            run(entry);
        }
        return;
    }
    const path = rows.value[activeIndex.value];
    if (path !== undefined) {
        open(path);
    }
};

// Focus + select the field each time the palette opens (the ChatTabs @show pattern), starting at the top row.
const onShow = async (): Promise<void> => {
    await nextTick();
    input.value?.focus();
    input.value?.select();
    activeIndex.value = 0;
};
</script>

<template>
    <Dialog
        v-model:visible="isOpen"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :show-header="false"
        position="top"
        :style="{ width: '36rem' }"
        :pt="{ content: '!p-0 !overflow-hidden !rounded-lg' }"
        @show="onShow"
    >
        <div role="combobox" aria-haspopup="listbox" aria-expanded="true" aria-label="Go to file">
            <div class="relative border-b border-line">
                <Icon
                    class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle"
                    aria-hidden="true"
                    :name="searching || pending ? `spinner` : `search`"
                    :spin="searching || pending"
                />
                <input
                    ref="input"
                    v-model="query"
                    type="text"
                    placeholder="Go to file by name or path… (> for commands)"
                    class="w-full min-w-0 bg-transparent py-2.5 pl-9 pr-3 text-sm text-content placeholder:text-subtle focus:outline-none"
                    role="searchbox"
                    aria-controls="quick-open-list"
                    :aria-activedescendant="activeIndex < rowCount ? `quick-open-opt-${activeIndex}` : undefined"
                    @keydown.down.prevent="move(1)"
                    @keydown.up.prevent="move(-1)"
                    @keydown.enter.prevent="openActive"
                    @keydown.esc="isOpen = false"
                />
            </div>
            <div v-if="commandMode" id="quick-open-list" class="scrollbar-thin max-h-80 overflow-auto py-1" role="listbox" aria-label="Commands">
                <button
                    v-for="(entry, index) in commandRows"
                    :id="`quick-open-opt-${index}`"
                    :key="entry.command"
                    :ref="(el) => setRowEl(entry.command, el)"
                    type="button"
                    role="option"
                    :aria-selected="index === activeIndex"
                    class="qo-row flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    :class="{ 'qo-row-on': index === activeIndex }"
                    @click="run(entry)"
                    @mouseenter="activeIndex = index"
                >
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-muted" />
                    <span class="min-w-0 truncate text-sm text-content">{{ entry.title }}</span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ entry.command }}</span>
                </button>
                <p v-if="commandRows.length === 0 && commands.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    No commands registered — extensions contribute them.
                </p>
                <p v-else-if="commandRows.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">No commands match.</p>
            </div>
            <div v-else id="quick-open-list" class="scrollbar-thin max-h-80 overflow-auto py-1" role="listbox" aria-label="Files">
                <p v-if="showingRecents && rows.length > 0" class="px-3 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wide text-subtle">
                    Recently opened
                </p>
                <p
                    v-if="truncated"
                    class="mx-1.5 mb-1 inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-2xs text-warning"
                >
                    <Icon name="exclamation-triangle" class="text-[0.6rem]" /> Showing first matches only.
                </p>
                <button
                    v-for="(path, index) in rows"
                    :id="`quick-open-opt-${index}`"
                    :key="path"
                    :ref="(el) => setRowEl(path, el)"
                    type="button"
                    role="option"
                    :aria-selected="index === activeIndex"
                    class="qo-row flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    :class="{ 'qo-row-on': index === activeIndex }"
                    @click="open(path)"
                    @mouseenter="activeIndex = index"
                >
                    <Icon :name="iconForEntry(basename(path), 'file', false)" class="shrink-0 text-2xs text-muted" />
                    <span class="min-w-0 truncate text-sm text-content">{{ basename(path) }}</span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ parentDir(path) }}</span>
                </button>
                <p v-if="error" class="px-3 py-3 text-center text-2xs text-danger">{{ error }}</p>
                <p v-else-if="rows.length === 0 && showingRecents" class="px-3 py-3 text-center text-2xs text-subtle">
                    Type at least 2 characters to search files.
                </p>
                <p v-else-if="rows.length === 0 && (searching || pending)" class="px-3 py-3 text-center text-2xs text-subtle">
                    <Icon name="spinner" spin />
                </p>
                <p v-else-if="rows.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">No files match.</p>
            </div>
        </div>
    </Dialog>
</template>

<style scoped>
.qo-row {
    cursor: pointer;
    transition: background-color 0.1s;
}
.qo-row-on {
    background: color-mix(in srgb, var(--color-primary-500) 15%, transparent);
}
</style>
