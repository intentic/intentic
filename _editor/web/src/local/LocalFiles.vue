<script setup lang="ts">
import { Button, ConfirmDialog, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from "vue";
import { askLocalApp, LOCAL_OPEN_EVENT, localFace } from "../app/environments/local";
import { useExtensionHost } from "../extension-host/useExtensionHost";
import WorkspaceTree from "../features/workspace/explorer/WorkspaceTree.vue";
import { useWorkspaceTree } from "../features/workspace/explorer/useWorkspaceTree";
import { useRootDrop } from "../features/workspace/explorer/transfer/useRootDrop";
import EditorPane from "../features/workspace/files/EditorPane.vue";
import { supportsRoute } from "../features/sandbox/overview/useDaemonRoutes";
import { HOISTED_CONTEXT } from "../features/workspace/files/viewerChrome";
import WorkspaceSearchResults from "../features/workspace/search/WorkspaceSearchResults.vue";
import { matchToggles } from "../features/workspace/search/useSearchOptions";
import { type SearchScope, useWorkspaceSearch } from "../features/workspace/search/useWorkspaceSearch";
import { useWorkspaceTabs } from "../features/workspace/tabs/useWorkspaceTabs";
import { isApplePlatform } from "../shell/commands/keybindings";
import QuickOpen from "../shell/commands/QuickOpen.vue";
import { useQuickOpen } from "../shell/commands/useQuickOpen";
import { openedPath } from "./appEvents";
import { useFolderSandbox } from "./folderSandbox";
import LocalBringBack from "./bring-back/LocalBringBack.vue";
import LocalEmptyFolder from "./LocalEmptyFolder.vue";
import { type LocalChord, localChord } from "./localKeys";
import { folderButtonOf } from "./machineCard";
import { useLocalProject } from "./useLocalProject";
import { useUnsavedGuard } from "./useUnsavedGuard";

// A desktop window on a folder of the user's own disk: the workspace's own explorer and editor pane, reading through the
// app's sidecar (app/environments/local.ts), and nothing that needs a sandbox. A document opened on its own shows alone
// until its folder is asked for; a folder shows its tree beside whatever is open.

const t = useT();
const face = localFace();

// The viewers (images, PDF, Office, EPUB) are extensions; this is the host that activates them for this window.
useExtensionHost();

const { listingOf, hiddenIn, keepListed, error, isLoading, busy } = useWorkspaceTree();
const tree = computed(() => listingOf(``) ?? []);
keepListed(() => ``);
const rootHidden = computed(() => hiddenIn(``));
// A folder whose listing has come back with nothing to draw. A document opened on its own is never one: its folder is
// not what the window shows.
const folderEmpty = computed(() => face?.file === undefined && listingOf(``)?.length === 0 && error.value === undefined);

const { activeId, activeTab, openFile, openAtLine, openDirectory, selectTab, keepTab } = useWorkspaceTabs();
// Every close that would lose unsaved edits asks first, the window's and a tab's alike (useUnsavedGuard.ts): the pane
// shows a closed tab's edits nowhere else, so a tab holding some closes only once the reader agrees.
const { question, asking, closeTab, closeAnyway, keepOpen } = useUnsavedGuard();
// The workspace's own words for the same question.
const questionHeader = computed(() => {
    const count = question.value?.paths.length ?? 0;
    return count === 1 ? t(`workspace.workspaceDesktop.discardUnsavedChanges`) : t(`workspace.workspaceDesktop.discardUnsavedChangesIn`, { count });
});

// The breadcrumb and the viewer's actions ride the tab row, as they do in the workspace.
provide(HOISTED_CONTEXT, true);

const selected = ref<string | undefined>(undefined);
const treeShown = ref(face?.file === undefined);

// Files from the computer's own file manager, dropped anywhere a folder row or the folder's home didn't take them, land
// in the folder itself, copied by the sidecar as the workspace's drop uploads to /work. Without this an empty folder,
// the one the app opens on first, had nowhere to drop at all. A document's own window writes only that document, and a
// read-only one nothing, so neither takes a drop.
const { rootDragging, onRootDragEnter, onRootDragOver, onRootDragLeave, onRootDrop } = useRootDrop({
    targetDir: () => ``,
    accepts: () => face !== undefined && face.file === undefined && supportsRoute(`POST /workspace/upload`),
});

// THE WAY FROM THIS FOLDER TO AN AGENT: its sandbox, opened once it has one (its own from before, or this computer's it
// went into); otherwise asked for in this window's own dialog and put into this computer's sandbox while the reader keeps
// working (LocalProject.vue), the button saying how far it is (machineCard.ts `folderButtonOf`).
const hasSandbox = useFolderSandbox();
const { machine, folder, ask: askForSandbox, fold } = useLocalProject();
const sandboxButton = computed(() => folderButtonOf({ hasSandbox: hasSandbox.value, machine: machine.value, folder: folder.value }));
const building = computed(() => sandboxButton.value.busy);
const sandboxLabel = computed(() => sandboxButton.value.label);
const toSandbox = (): void => {
    switch (sandboxButton.value.press) {
        // The folder's sandbox, started first if it is stopped (the app's project.rs `open_existing`).
        case `open`:
            askLocalApp(`sandbox`);
            return;
        // On its way in, or turned down: its card says how far, and what to do.
        case `card`:
            fold(false);
            return;
        default:
            void askForSandbox();
    }
};

// The way from a file to an agent: a conversation about it, which the app starts (the tree's menu offers the same).
const activePath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
const ask = (path: string): void => askLocalApp(`ask`, { path });
const askActive = (): void => {
    if (activePath.value !== undefined) {
        ask(activePath.value);
    }
};

// --- Finding things: a file by name (the palette), the folder's text (the search above the tree) ----------------------
const { isOpen: paletteOpen } = useQuickOpen();
const openKept = (path: string): void => openFile(path, `keep`);

// The folder's text, answered in place of the tree while a query stands; the same search the workspace's explorer runs.
const query = ref(``);
const searchShown = computed(() => query.value.trim() !== ``);
const {
    groups: searchGroups,
    total: searchTotal,
    files: searchFiles,
    partial: searchPartial,
    truncated: searchTruncated,
    searching,
    pending: searchPending,
    loadingMore: searchLoadingMore,
    loadMore: searchLoadMore,
    error: searchError,
    note: searchNote,
} = useWorkspaceSearch(query, ref<SearchScope>(`text`), searchShown);
const searchInput = ref<HTMLInputElement>();
const focusSearch = async (): Promise<void> => {
    treeShown.value = true;
    await nextTick();
    searchInput.value?.focus();
    searchInput.value?.select();
};
// Back to the tree.
const clearSearch = (): void => {
    query.value = ``;
};
// Enter in the field opens the first match, at its line.
const openFirstMatch = (): void => {
    const [group] = searchGroups.value;
    const [hit] = group?.hits ?? [];
    if (group !== undefined && hit !== undefined) {
        openAtLine(group.path, hit.line, `keep`);
    }
};

// The window's own chords (localKeys.ts); every other key goes on to whatever has focus.
const CHORD_ACTIONS = {
    "find-file": () => {
        paletteOpen.value = true;
    },
    "search-text": () => void focusSearch(),
    // Exactly what the active tab's × does, the question about its unsaved edits included.
    "close-tab": () => {
        if (activeId.value !== null) {
            closeTab(activeId.value);
        }
    },
} satisfies Readonly<Record<LocalChord, () => void>>;
const isMac = isApplePlatform();
const onKeydown = (event: KeyboardEvent): void => {
    const chord = localChord(event, isMac);
    if (chord === undefined) {
        return;
    }
    event.preventDefault();
    CHORD_ACTIONS[chord]();
};

// A file of this folder opened from outside the window (a double-click in the file manager): here, kept, and found in
// the tree.
const onOpened = (event: Event): void => {
    const path = openedPath(event);
    if (path !== undefined) {
        openFile(path, `keep`);
        selected.value = path;
    }
};

onMounted(() => {
    if (face?.file !== undefined) {
        openFile(face.file, `keep`);
    }
    window.addEventListener(`keydown`, onKeydown);
    window.addEventListener(LOCAL_OPEN_EVENT, onOpened);
});
onUnmounted(() => {
    window.removeEventListener(`keydown`, onKeydown);
    window.removeEventListener(LOCAL_OPEN_EVENT, onOpened);
});
</script>

<template>
    <!-- The shell's page: the folder's explorer beside its documents, filling what the rail leaves (LocalShell.vue). The
         whole page is the folder's drop target; a folder row or the home's tiles take their own drops first. -->
    <div
        class="flex h-full w-full overflow-hidden"
        @dragenter="onRootDragEnter"
        @dragover="onRootDragOver"
        @dragleave="onRootDragLeave"
        @drop="onRootDrop"
    >
        <aside v-if="treeShown" class="relative flex w-72 shrink-0 flex-col border-r border-line bg-card">
            <div class="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-3 pr-1">
                <Icon name="folder" class="shrink-0 text-sm text-muted" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium" v-tooltip.bottom="face?.path">{{ face?.name }}</span>
                <Icon v-if="busy || isLoading" name="spinner" class="text-sm text-muted" spin :aria-label="t(`workspace.words.working`)" />
                <!-- Another folder is the place chip's to open (LocalPlaceSwitcher.vue); this row is about this one. -->
                <button
                    type="button"
                    :class="ui.iconButton(`h-7 w-7`)"
                    v-tooltip.bottom="t(`local.localFiles.reveal`)"
                    :aria-label="t(`local.localFiles.reveal`)"
                    @click="askLocalApp(`reveal`, { path: selected })"
                >
                    <Icon name="external-link" class="text-sm" />
                </button>
            </div>
            <!-- The folder's text (Ctrl/Cmd+Shift+F): matches take the tree's place while a query stands, and Esc brings it back. -->
            <div class="relative m-1.5 shrink-0">
                <Icon
                    class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                    aria-hidden="true"
                    :name="searchShown && (searching || searchPending) ? `spinner` : `search`"
                    :spin="searchShown && (searching || searchPending)"
                />
                <input
                    ref="searchInput"
                    v-model="query"
                    type="text"
                    :placeholder="t(`workspace.words.searchInFiles`)"
                    :aria-label="t(`workspace.words.searchInFiles`)"
                    class="ui-field-box ui-field-sm w-full min-w-0 pl-7 pr-[4.75rem]"
                    @keydown.esc="clearSearch"
                    @keydown.enter.prevent="openFirstMatch"
                />
                <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                    <!-- The workspace's own three switches, in its order: they are one setting, wherever it is searched from. -->
                    <button
                        v-for="toggle in matchToggles()"
                        :key="toggle.label"
                        type="button"
                        :class="
                            ui.iconButton(
                                `h-4 w-4 rounded font-mono text-3xs leading-none text-subtle`,
                                toggle.state.value ? `bg-primary-600/20 text-link` : ``,
                            )
                        "
                        :aria-pressed="toggle.state.value"
                        v-tooltip.bottom="toggle.title"
                        :aria-label="toggle.title"
                        @mousedown.prevent
                        @click="toggle.state.value = !toggle.state.value"
                    >
                        {{ toggle.label }}
                    </button>
                    <button
                        v-if="searchShown"
                        type="button"
                        class="flex items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                        v-tooltip.bottom="t(`workspace.workspaceDesktop.clearEsc`)"
                        :aria-label="t(`ui.action.clear`)"
                        @click="clearSearch"
                    >
                        <Icon name="times" />
                    </button>
                </div>
            </div>
            <p v-if="error" class="px-3 py-2 text-2xs text-danger">{{ error }}</p>
            <div v-if="searchShown" class="min-h-0 flex-1" @keydown.esc="clearSearch">
                <WorkspaceSearchResults
                    :groups="searchGroups"
                    :total="searchTotal"
                    :files="searchFiles"
                    :partial="searchPartial"
                    :truncated="searchTruncated"
                    :searching="searching"
                    :pending="searchPending"
                    :loading-more="searchLoadingMore"
                    :error="searchError"
                    :note="searchNote"
                    :query="query"
                    @open-match="openAtLine"
                    @load-more="searchLoadMore"
                />
            </div>
            <div v-else class="min-h-0 flex-1 overflow-hidden">
                <WorkspaceTree
                    :tree="tree"
                    root-dir=""
                    :root-hidden="rootHidden"
                    :selected-path="selected ?? null"
                    @open-file="openFile"
                    @open-directory="openDirectory"
                    @pick="(entry) => (selected = entry.path)"
                    @clear="selected = undefined"
                    @ask="ask"
                />
            </div>
            <!-- What agents changed in the folder's own sandbox, brought back on request (bring-back/LocalBringBack.vue). -->
            <LocalBringBack v-if="face !== undefined && face.file === undefined && hasSandbox" />
            <!-- The way from this folder to an agent: this computer's sandbox, its copy kept in sync with it (the app's project.rs). Not for
                 a folder with nothing in it yet, which would hand an agent nothing to work on. -->
            <div v-if="face !== undefined && face.file === undefined && !folderEmpty" class="shrink-0 border-t border-line p-2">
                <Button
                    class="w-full"
                    size="small"
                    severity="secondary"
                    :label="sandboxLabel"
                    v-tooltip.top="
                        building
                            ? undefined
                            : hasSandbox
                              ? { title: t(`local.localFiles.syncedSandbox`), note: t(`local.localFiles.startsIfStopped`) }
                              : { title: t(`local.localFiles.machineSandbox`), note: t(`local.localFiles.keepsFolderSynced`) }
                    "
                    @click="toSandbox"
                />
            </div>
            <!-- The folder taking a drop, drawn over its tree as the workspace draws it; a folder row lights its own ring. -->
            <div
                v-if="rootDragging"
                class="pointer-events-none absolute inset-1 z-10 rounded-sm border-2 border-dashed border-primary-500/60 bg-primary-500/6"
            ></div>
        </aside>
        <div class="relative flex min-h-0 min-w-0 flex-1">
            <EditorPane pane="main" :empty="folderEmpty" @select="selectTab" @keep="keepTab" @close="closeTab">
                <!-- A folder with nothing in it yet (the one the app starts in, first of all): what it is for, and the ways to fill it. -->
                <template #empty>
                    <LocalEmptyFolder />
                </template>
                <template #lead>
                    <button
                        type="button"
                        :class="ui.iconButton(`mx-1 h-7 w-7 self-center`)"
                        v-tooltip.bottom="t(`local.localFiles.toggleFolder`)"
                        :aria-label="t(`local.localFiles.toggleFolder`)"
                        @click="treeShown = !treeShown"
                    >
                        <Icon name="bars" class="text-sm" />
                    </button>
                </template>
                <template #status>
                    <Button
                        v-if="activePath !== undefined"
                        class="mx-1.5 shrink-0 self-center"
                        size="small"
                        severity="secondary"
                        :label="t(`local.localFiles.askAgent`)"
                        v-tooltip.bottom="{ title: t(`local.localFiles.askAgent`), note: t(`local.localFiles.askAgentHint`) }"
                        @click="askActive"
                    >
                        <template #icon><Icon name="robot" /></template>
                    </Button>
                </template>
            </EditorPane>
            <!-- Where a drop lands, said over the documents while files are over the window. Opaque, since what it covers is
                 centred too (the empty folder's own words) and would read through it. -->
            <div
                v-if="rootDragging"
                class="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-primary-500/60 bg-canvas/95 text-primary-500"
            >
                <Icon name="upload" class="text-2xl" />
                <span class="text-xs font-medium">{{ t(`local.localFiles.dropFilesToAdd`, { name: face?.name ?? `` }) }}</span>
            </div>
        </div>
        <!-- Ctrl/Cmd+P: this folder's files alone, each opened here. -->
        <QuickOpen :open-file="openKept" />
        <!-- A close that would discard unsaved edits, the window's (held back by the app) or a tab's: it happens only on the reader's word. -->
        <ConfirmDialog
            :open="asking"
            :header="questionHeader"
            :confirm-label="t(`workspace.workspaceDesktop.closeAnyway`)"
            confirm-icon="times"
            :items="question?.paths ?? []"
            @cancel="keepOpen"
            @confirm="closeAnyway"
        >
            <template #item="{ item }">
                <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
                <span class="truncate text-content">{{ item }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">
                {{ question?.what === `tab` ? t(`local.localFiles.closingTabDiscardsUnsaved`) : t(`local.localFiles.closingDiscardsUnsaved`) }}
            </p>
        </ConfirmDialog>
    </div>
</template>
