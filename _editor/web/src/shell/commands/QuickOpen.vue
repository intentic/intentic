<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { commands, executeCommand, type RegisteredCommand } from "./useCommands";
import { formatChord, isApplePlatform } from "./keybindings";
import { effectiveKeybinding } from "./useKeymap";
import { useQuickOpen } from "./useQuickOpen";
import { sessionIdFrom } from "../../features/agents/fleet/sessionRef";
import { useAgents } from "../../features/agents/fleet/useAgents";
import { useFuzzyFiles } from "../../features/workspace/search/useFuzzyFiles";
import { useWorkspaceTabs } from "../../features/workspace/tabs/useWorkspaceTabs";
import { iconForEntry, type IconName, Modal } from "@intentic/ui";
import { basename, parentDir } from "@intentic/ui/path";

// Quick Open (Ctrl/Cmd+P): ranks /work files by name client-side over the cached tree (useFuzzyFiles),
// so results land in the same frame as the keystroke; the daemon's search only backs the truncated-tree
// fallback. Below the search floor it lists open tabs; a `>` prefix flips to command mode (useCommands).

const { isOpen, mode } = useQuickOpen();
const router = useRouter();
const { tabs } = useWorkspaceTabs();
const { agentById } = useAgents();
// Resolved once so command rows render their shortcut in native form (⇧⌘P vs Ctrl+Shift+P).
const isMac = isApplePlatform();
// The effective chord (override or default), read reactively so a live remap updates the hint.
const chordFor = (entry: RegisteredCommand): string | undefined => effectiveKeybinding(entry.command, entry.keybinding);

const query = ref(``);
// `>` prefix means command mode; the rest of the text filters registered commands by title or id.
const commandMode = computed(() => query.value.trimStart().startsWith(`>`));
const commandQuery = computed(() => query.value.trimStart().slice(1).trim().toLowerCase());
const commandRows = computed<readonly RegisteredCommand[]>(() =>
    commands.value.filter(
        (entry) => entry.title.toLowerCase().includes(commandQuery.value) || entry.command.toLowerCase().includes(commandQuery.value),
    ),
);
// A pasted session id takes over the palette; any of its four spellings are accepted (sessionRef).
const sessionRef = computed(() => (commandMode.value ? undefined : sessionIdFrom(query.value, (id) => agentById(id) !== undefined)));
// The known agent behind it, if any; the jump still works even if the roster hasn't caught up yet.
const sessionAgent = computed(() => (sessionRef.value === undefined ? undefined : agentById(sessionRef.value)));

// Idle in command mode or with a session reference, since neither is a filename to match.
const searchActive = computed(() => isOpen.value && !commandMode.value && sessionRef.value === undefined);
const { paths: filePaths, floor, searching, pending, truncated, error } = useFuzzyFiles(query, searchActive);

const input = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const rowEls = new Map<string, HTMLElement>();

const openTabPaths = computed<readonly string[]>(() => tabs.value.flatMap((tab) => (tab.kind === `file` ? [tab.path] : [])));
const showingRecents = computed(() => query.value.trim().length < floor.value);
const rows = computed<readonly string[]>(() => (showingRecents.value ? openTabPaths.value : filePaths.value));
const rowCount = computed(() => (commandMode.value ? commandRows.value.length : sessionRef.value !== undefined ? 1 : rows.value.length));

// Resets the highlight to the top whenever the result set changes, including the single session row.
watch([rows, commandRows, sessionRef], () => (activeIndex.value = 0));

const setRowEl = (path: string, el: unknown): void => {
    if (el) {
        rowEls.set(path, el as HTMLElement);
    } else {
        rowEls.delete(path);
    }
};

const open = (path: string): void => {
    // Navigates to the file's workspace URL; useWorkspaceRoute opens it, whichever area we're coming from.
    void router.push({ name: `workspace`, params: { path: path.split(`/`) } });
    isOpen.value = false;
};

const run = (entry: RegisteredCommand): void => {
    isOpen.value = false;
    // A throwing command is its owner's bug: contain it to the console, never the palette.
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

const openAgent = (id: string): void => {
    void router.push({ name: `agent`, params: { id } });
    isOpen.value = false;
};

const openActive = (): void => {
    if (commandMode.value) {
        const entry = commandRows.value[activeIndex.value];
        if (entry !== undefined) {
            run(entry);
        }
        return;
    }
    if (sessionRef.value !== undefined) {
        openAgent(sessionRef.value);
        return;
    }
    const path = rows.value[activeIndex.value];
    if (path !== undefined) {
        open(path);
    }
};

// Focuses the field and resets to the top row each time the palette opens. Seeds the query from the
// shortcut that opened it: `> ` for the Command Palette, empty for Go to File.
const onShow = async (): Promise<void> => {
    query.value = mode.value === `commands` ? `> ` : ``;
    await nextTick();
    input.value?.focus();
    // Caret at the end, not selected, so the next keystroke can't wipe the `> ` prefix.
    if (mode.value === `commands`) {
        const end = input.value?.value.length ?? 0;
        input.value?.setSelectionRange(end, end);
    } else {
        input.value?.select();
    }
    activeIndex.value = 0;
};
</script>

<template>
    <Modal v-model:open="isOpen" size="md" :chrome="false" :scroll="false" position="top" @show="onShow">
        <div role="combobox" aria-haspopup="listbox" aria-expanded="true" aria-label="Go to file">
            <!--
                field-bare: the search is the panel's top band, not a boxed field — the panel border and this
                divider are already its frame. A skin styling this row targets `ui-search-row`, not the input.
            -->
            <div class="ui-search-row relative border-b border-line">
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
                    placeholder="Go to file, or paste a session id… (> for commands)"
                    class="field-bare w-full min-w-0 py-2.5 pl-9 pr-3"
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
                    class="ui-row-select flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    :class="{ 'ui-row-select-on': index === activeIndex }"
                    @click="run(entry)"
                    @mouseenter="activeIndex = index"
                >
                    <Icon :name="(entry.icon ?? `chevron-right`) as IconName" class="shrink-0 text-2xs text-muted" />
                    <span class="min-w-0 truncate text-sm text-content">{{ entry.title }}</span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ entry.command }}</span>
                    <kbd v-if="chordFor(entry)" class="shrink-0 rounded border border-line bg-overlay px-1.5 py-0.5 font-mono text-2xs text-muted">{{
                        formatChord(chordFor(entry)!, isMac)
                    }}</kbd>
                </button>
                <p v-if="commandRows.length === 0 && commands.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    No commands registered: extensions contribute them.
                </p>
                <p v-else-if="commandRows.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">No commands match.</p>
            </div>
            <!-- One offer, since a session name means one thing; the id is echoed so the reader can verify the match. -->
            <div
                v-else-if="sessionRef !== undefined"
                id="quick-open-list"
                class="scrollbar-thin max-h-80 overflow-auto py-1"
                role="listbox"
                aria-label="Agent"
            >
                <button
                    id="quick-open-opt-0"
                    type="button"
                    role="option"
                    :aria-selected="true"
                    class="ui-row-select ui-row-select-on flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    @click="openAgent(sessionRef)"
                >
                    <Icon name="robot" class="shrink-0 text-2xs text-muted" />
                    <span class="min-w-0 truncate text-sm text-content">{{ sessionAgent?.title ?? `Open this agent` }}</span>
                    <span class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ sessionRef }}</span>
                </button>
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
                    class="ui-row-select flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    :class="{ 'ui-row-select-on': index === activeIndex }"
                    @click="open(path)"
                    @mouseenter="activeIndex = index"
                >
                    <Icon :name="iconForEntry(basename(path), 'file', false)" class="shrink-0 text-2xs text-muted" />
                    <span class="min-w-0 truncate text-sm text-content">{{ basename(path) }}</span>
                    <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ parentDir(path) }}</span>
                </button>
                <p v-if="error" class="px-3 py-3 text-center text-2xs text-danger">{{ error }}</p>
                <p v-else-if="rows.length === 0 && showingRecents" class="px-3 py-3 text-center text-2xs text-subtle">
                    {{ floor > 1 ? `Type at least ${floor} characters to search files.` : `Type to search files.` }}
                </p>
                <p v-else-if="rows.length === 0 && (searching || pending)" class="px-3 py-3 text-center text-2xs text-subtle">
                    <Icon name="spinner" spin />
                </p>
                <p v-else-if="rows.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">No files match.</p>
            </div>
        </div>
    </Modal>
</template>
