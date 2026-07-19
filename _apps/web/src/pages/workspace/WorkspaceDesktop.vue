<script setup lang="ts">
import { type IconName, Segmented } from "@intentic-app/ui";
import Button from "primevue/button";
import ContextMenu from "primevue/contextmenu";
import Dialog from "primevue/dialog";
import type { MenuItem } from "primevue/menuitem";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { usePanels } from "../../composables/extensions/usePanels";
import { detectActivations } from "../../core-views/registry";
import { useEditBuffers } from "../../composables/workspace/useEditBuffers";
import { useMonaco } from "../../composables/workspace/useMonaco";
import { useChat } from "../../composables/chat/useChat";
import { type SidebarPanel, useLayout } from "../../composables/useLayout";
import { reportOpenPath } from "../../composables/usePresence";
import { useChanges } from "../../composables/workspace/useChanges";
import { useRepos } from "../../composables/workspace/useRepos";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { useWorkspaceRoute } from "../../composables/workspace/useWorkspaceRoute";
import { useWorkspaceSearch } from "../../composables/workspace/useWorkspaceSearch";
import { useWorkspaceTabs } from "../../composables/workspace/useWorkspaceTabs";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { filesToEntries } from "./dropEntries";
import DiffView from "./viewers/DiffView.vue";
import DirectoryOperator from "./DirectoryOperator.vue";
import DirectoryUiHost from "./DirectoryUiHost.vue";
import FileBreadcrumb from "./FileBreadcrumb.vue";
import FileTabs from "./FileTabs.vue";
import FileViewer from "./viewers/FileViewer.vue";
import GitGraph from "./GitGraph.vue";
import HistoryPanel from "./HistoryPanel.vue";
import MarkdownViewer from "./viewers/MarkdownViewer.vue";
import ReviewPanel from "./ReviewPanel.vue";
import UploadProgress from "./UploadProgress.vue";
import WorkspaceEmptyState from "./WorkspaceEmptyState.vue";
import WorkspaceSearchResults from "./WorkspaceSearchResults.vue";
import WorkspaceTree from "./WorkspaceTree.vue";
import { closeTabs } from "./workspaceTabs";

/* The Workspace area: a VSCode-like, full-height explorer + viewer of the /work filesystem the agent sees
 * ("what the LLM sees"), read DIRECTLY from the sandbox daemon (no platform state, see CLAUDE.md). A resizable
 * file tree on the left, open-file tabs + a syntax-highlighted / image / PDF / markdown viewer on the right, and
 * a collapsible terminal panel along the bottom. Read-only — editing happens via the agent in chat. */

const layout = useLayout();
const { tree, truncated, error, isLoading, refetch, entry, expanded, collapseAll, moveIntoMany, run, busy, actionError } = useWorkspaceTree();
const { files: uploadFiles, scanning: uploadScanning, skippedNotice: uploadSkipped, enqueue, enqueueFromDataTransfer } = useUploadQueue();
const { forget, dirtyPaths } = useEditBuffers();
const changes = useChanges();
// Every git repo under /work (root + nested). Marks the tree rows that get a git-history affordance, and feeds
// the graph's repo switcher — the multi-repo axis of the workspace ("root is a repo; it may contain repos").
const { repoDirs } = useRepos();
const router = useRouter();

// The active nudge: once a turn leaves uncommitted changes, show a banner until the user opens Changes or
// dismisses it. Each finished agent turn (streaming falls) re-arms it, so every round of work surfaces once.
const bannerDismissed = ref(false);
const { streaming } = useChat();
watch(streaming, (now, was) => {
    if (was && !now) {
        bannerDismissed.value = false;
    }
});
const showReviewBanner = computed(() => changes.hasChanges.value && layout.sidebarPanel.value !== `changes` && !bannerDismissed.value);
const openReview = (): void => layout.setSidebarPanel(`changes`);

// The sidebar's mode switch lives ON the sidebar (proximity — the control sits with what it changes). The
// Changes tab carries the uncommitted count so pending work is visible from any mode.
const sidebarMode = computed<SidebarPanel>({ get: () => layout.sidebarPanel.value, set: (value) => layout.setSidebarPanel(value) });
const sidebarModeOptions = computed(() => [
    { label: `Files`, value: `files` as const, title: `Browse the workspace files` },
    { label: `Changes`, value: `changes` as const, title: `Review uncommitted changes`, badge: changes.count.value },
    { label: `Checkpoints`, value: `history` as const, title: `Workspace checkpoints — restore files to any earlier point` },
]);

const filter = ref(``);
// One input, two scopes: `name` filters the loaded tree instantly (client-side), `content` searches file
// contents on the daemon (debounced, via useWorkspaceSearch) and swaps the tree for a match list. The
// includeIgnored toggle widens BOTH the tree and search to node_modules/.gitignore'd paths (secrets stay hidden).
const searchScope = ref<"name" | "content">(`name`);
const contentMode = computed(() => searchScope.value === `content`);
const {
    groups: searchGroups,
    truncated: searchTruncated,
    searching,
    pending: searchPending,
    error: searchError,
} = useWorkspaceSearch(filter, contentMode);
// The open tabs live in the useWorkspaceTabs singleton (the chat pushes plan previews in from the shell, and
// tabs survive navigation); this component owns closing — the dirty-confirm dialog and edit-buffer forget.
const { tabs, activeId, activeTab, openLine, openFile, openAtLine, openDiff, openDirectory, openGraph, selectTab } = useWorkspaceTabs();
// Mirror the active file into the URL (`/workspace/<path>`) so a reload / shared link reopens it.
useWorkspaceRoute();

// Repository directories that a directory-surface extension serves (Apps, UI, preview) — selecting one in the
// tree opens its management surface as a tab. Rail-surface repos (intent/desired-state) are absent by design.
const { panels } = usePanels();
const { capabilities } = useCapabilities();
const manageableDirs = computed(
    () =>
        new Set(
            detectActivations(panels.value, capabilities.value).flatMap(({ extension, activation }) =>
                extension.surface === `directory` && activation.repo !== undefined ? [activation.repo] : [],
            ),
        ),
);
const activeFile = computed(() => (activeTab.value?.kind === `file` ? activeTab.value : undefined));
const openPath = computed(() => activeFile.value?.path);
const openMeta = computed(() => entry(openPath.value));
// Presence: announce which file this tab has open. Component-scoped is right here — the open file genuinely
// ceases to exist when the Workspace area unmounts, and the unmount below clears it.
watch(openPath, (path) => reportOpenPath(path), { immediate: true });
onBeforeUnmount(() => reportOpenPath(undefined));
// A directory declares its own UI via `<dir>/.intentic/ui/index.html`; opening that file renders the directory's
// interaction surface (sandboxed iframe + action bridge) instead of the raw HTML source. undefined = a normal
// file, shown in the viewer. `directoryUiDir` is the owning dir, root-relative ("" = /work root).
const UI_INDEX = `.intentic/ui/index.html`;
const directoryUiDir = computed<string | undefined>(() => {
    const path = openPath.value;
    if (path === undefined) {
        return undefined;
    }
    if (path === UI_INDEX) {
        return ``;
    }
    return path.endsWith(`/${UI_INDEX}`) ? path.slice(0, -(UI_INDEX.length + 1)) : undefined;
});

const fileInput = ref<HTMLInputElement>();
// Root drop zone highlight, tracked with an enter/leave depth so bubbling over child rows doesn't flicker it off.
const rootDragging = ref(false);
// True while the drag carries OS files (vs an internal tree-row move) — gates the viewer's "drop to add" overlay.
const externalDrag = ref(false);
let dragDepth = 0;

const resizing = ref(false);
const sidebar = ref<HTMLElement>();
// The sidebar's left viewport offset, captured at drag start — its width is the pointer's distance from it (the
// sidebar is not flush to the viewport edge; the shell's rail sits to its left).
let sidebarLeft = 0;

const clearFilter = (): void => {
    filter.value = ``;
    searchScope.value = `name`;
};

// Right-click tab menu (VSCode-style). It acts on the right-clicked tab (`menuTabId`), which "Close Others"/"Close to
// the Right" keep. `pendingClose` holds the set awaiting the unsaved-changes confirm; its dirty paths feed the dialog.
const tabMenu = ref<{ show: (event: Event) => void }>();
const menuTabId = ref<string>();
const pendingClose = ref<ReadonlySet<string>>();

const applyClose = (ids: ReadonlySet<string>): void => {
    const { nextTabs, nextActiveId, forgetPaths } = closeTabs(tabs.value, activeId.value, ids);
    tabs.value = nextTabs;
    forgetPaths.forEach(forget); // drop unsaved edit buffers for the closed files
    activeId.value = nextActiveId;
};
// The single × (and the menu's "Close") stay silent — the dirty dot is right there on the tab. Bulk closes confirm
// first when any of the tabs going away has unsaved edits (a background tab's dirt is easy to miss).
const closeTab = (id: string): void => applyClose(new Set([id]));
const requestClose = (ids: ReadonlySet<string>): void => {
    const hasDirty = tabs.value.some((tab) => ids.has(tab.id) && tab.kind === `file` && dirtyPaths.value.has(tab.path));
    if (!hasDirty) {
        applyClose(ids);
        return;
    }
    pendingClose.value = ids;
};
const confirmClose = (): void => {
    if (pendingClose.value !== undefined) {
        applyClose(pendingClose.value);
    }
    pendingClose.value = undefined;
};
const pendingCloseDirty = computed(() =>
    pendingClose.value === undefined
        ? []
        : tabs.value.flatMap((tab) => (pendingClose.value?.has(tab.id) && tab.kind === `file` && dirtyPaths.value.has(tab.path) ? [tab.path] : [])),
);
const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined) {
        return [];
    }
    const index = tabs.value.findIndex((tab) => tab.id === id);
    const menuTab = tabs.value[index];
    if (menuTab === undefined) {
        return [];
    }
    const others = new Set(tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id));
    const toRight = new Set(tabs.value.slice(index + 1).map((tab) => tab.id));
    const all = new Set(tabs.value.map((tab) => tab.id));
    return [
        { label: `Close`, icon: `times`, command: () => closeTab(id) },
        { label: `Close Others`, disabled: others.size === 0, command: () => requestClose(others) },
        { label: `Close to the Right`, disabled: toRight.size === 0, command: () => requestClose(toRight) },
        { separator: true },
        { label: `Close All`, command: () => requestClose(all) },
        // Only file/diff tabs have a filesystem path to copy (a plan preview and a directory panel don't).
        // Clipboard may be unavailable (insecure context) — swallow, matching CopyButton.
        ...(menuTab.kind === `file` || menuTab.kind === `diff`
            ? [
                  { separator: true },
                  { label: `Copy Path`, icon: `copy`, command: () => void navigator.clipboard.writeText(menuTab.path).catch(() => undefined) },
              ]
            : []),
    ];
});
const openTabMenu = (id: string, event: Event): void => {
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Root-level upload: files dropped on the explorer background (a folder row handles its own drop) or picked via
// the empty state's browse button land at the /work root. Directories recurse through collectDroppedFiles.
const resetRootDrag = (): void => {
    dragDepth = 0;
    rootDragging.value = false;
    externalDrag.value = false;
};
const onRootDragEnter = (event: DragEvent): void => {
    dragDepth += 1;
    rootDragging.value = true;
    // OS-file drags expose the "Files" type; an internal tree-row move exposes our custom path key instead.
    externalDrag.value = event.dataTransfer?.types.includes(`Files`) ?? false;
};
const onRootDragLeave = (): void => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
        resetRootDrag();
    }
};
const onRootDrop = (event: DragEvent): void => {
    resetRootDrag();
    if (event.dataTransfer === null) {
        return;
    }
    const dataTransfer = event.dataTransfer;
    // Tree rows dragged in from within the explorer (one or a multi-selection, newline-joined) → move to root;
    // otherwise OS files → upload to root.
    const internal = dataTransfer.getData(`application/x-intentic-path`);
    if (internal !== ``) {
        void run(() => moveIntoMany(internal.split(`\n`), ``));
        return;
    }
    // enqueueFromDataTransfer runs the capture synchronously (webkitGetAsEntry must fire while the drop's items are
    // alive) and shows the "scanning" panel instantly, before the walk finishes.
    enqueueFromDataTransfer(``, dataTransfer);
};
// A folder-targeted drop calls stopPropagation (so it doesn't also upload to root), so the aside never sees that
// drop to clear its hint. Reset from the window in the CAPTURE phase — it runs before any stopPropagation — so
// the drop hint can never stick on. (Ctrl+` and the terminal panel itself live in the shell — sandbox-global.)
onMounted(() => {
    window.addEventListener(`drop`, resetRootDrag, true);
    window.addEventListener(`dragend`, resetRootDrag, true);
    // Load Monaco (+ Shiki bridge) while the user browses the tree, so the first file open isn't cold.
    void useMonaco().ensureMonaco();
});
onBeforeUnmount(() => {
    window.removeEventListener(`drop`, resetRootDrag, true);
    window.removeEventListener(`dragend`, resetRootDrag, true);
});
const onPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.files !== null && input.files.length > 0) {
        void enqueue(``, filesToEntries(input.files));
    }
    input.value = ``;
};

const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    sidebarLeft = sidebar.value?.getBoundingClientRect().left ?? 0;
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};

const onResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    layout.setSidebarWidth(event.clientX - sidebarLeft);
};

const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};
</script>

<template>
    <!-- Swallow drops that miss the explorer so the browser doesn't navigate to the file (which would wipe
         unsaved editor buffers). The explorer/rows still handle their own drops before this bubbles up. -->
    <div
        class="ws flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-content"
        :class="{ 'is-resizing': resizing }"
        @dragover.prevent
        @drop.prevent
    >
        <!-- Active nudge: uncommitted work is waiting for review. Dismiss keeps it quiet until the next turn. -->
        <div
            v-if="showReviewBanner"
            class="flex shrink-0 items-center gap-3 border-b border-primary-600/30 bg-primary-600/10 px-4 py-2 text-xs text-link"
        >
            <Icon name="check-square" />
            <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left hover:underline" @click="openReview">
                <span class="min-w-0 flex-1">
                    <span class="font-medium">{{ changes.count.value }}</span> uncommitted {{ changes.count.value === 1 ? "change" : "changes" }} —
                    review before you continue.
                </span>
                <span class="shrink-0 font-medium underline underline-offset-2">Review →</span>
            </button>
            <button
                type="button"
                class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content"
                aria-label="Dismiss"
                @click="bannerDismissed = true"
            >
                <Icon name="times" />
            </button>
        </div>

        <!-- Body: sidebar + viewer; only the leaf panes scroll. The whole body is the root drop target (sidebar
             background, viewer, and empty state all upload to /work root); a folder row captures its own drop
             (stopPropagation) so hovering a folder targets that folder instead. -->
        <div
            class="relative flex min-h-0 flex-1"
            @dragenter="onRootDragEnter"
            @dragover.prevent
            @dragleave="onRootDragLeave"
            @drop.prevent="onRootDrop"
        >
            <aside
                v-if="!layout.sidebarCollapsed.value"
                ref="sidebar"
                class="relative flex min-h-0 shrink-0 flex-col border-r border-line bg-card"
                :style="{ width: `${layout.sidebarWidth.value}px` }"
            >
                <!-- The sidebar's three modes (VSCode SCM pattern): the file explorer, the agent-changes review, or
                     the snapshot timeline. One column, one resize handle — review/history never steal width from
                     the diff view in the main area. The mode switch sits ON the sidebar it switches. -->
                <div class="flex h-8 shrink-0 items-center border-b border-line px-1.5">
                    <Segmented v-model="sidebarMode" size="xs" :options="sidebarModeOptions" />
                </div>
                <ReviewPanel v-if="layout.sidebarPanel.value === 'changes'" @open-diff="openDiff" @open-graph="openGraph" />
                <HistoryPanel v-else-if="layout.sidebarPanel.value === 'history'" @open-diff="openDiff" />
                <!-- Search header: input hero on row 1; mode switch + ignored-scope toggle on row 2. One `filter`
                     ref, two scopes (name = instant client-side tree filter, content = debounced daemon search). The
                     leading icon doubles as the content-search spinner; the ✕ (and Esc) clear text AND snap scope back
                     to name. -->
                <div v-if="layout.sidebarPanel.value === 'files'" class="flex shrink-0 flex-col gap-1 p-1.5">
                    <div class="relative">
                        <Icon
                            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                            aria-hidden="true"
                            :name="contentMode && (searching || searchPending) ? `spinner` : `search`"
                            :spin="contentMode && (searching || searchPending)"
                        />
                        <input
                            v-model="filter"
                            type="text"
                            :placeholder="contentMode ? `Search in files…` : `Filter files…`"
                            class="w-full min-w-0 rounded-md border border-line bg-canvas py-1 pl-7 pr-7 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                            @keydown.esc="clearFilter"
                        />
                        <button
                            v-if="filter"
                            type="button"
                            class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                            title="Clear (Esc)"
                            aria-label="Clear filter"
                            @click="clearFilter"
                        >
                            <Icon name="times" />
                        </button>
                    </div>
                    <div class="flex items-center gap-1">
                        <Segmented
                            v-model="searchScope"
                            size="xs"
                            :options="[
                                { label: `Name`, value: `name`, title: `Filter by file name` },
                                { label: `Content`, value: `content`, title: `Search inside file contents` },
                            ]"
                        />
                        <span class="flex-1"></span>
                        <button
                            v-if="contentMode"
                            type="button"
                            class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': layout.includeIgnored.value }"
                            :aria-pressed="layout.includeIgnored.value"
                            :title="
                                layout.includeIgnored.value
                                    ? 'Searching ignored files too (node_modules, gitignored paths). Click to skip them.'
                                    : 'Search skips ignored files (node_modules, gitignored paths). Click to include them.'
                            "
                            @click="layout.toggleIncludeIgnored()"
                        >
                            <Icon class="text-2xs" :name="layout.includeIgnored.value ? `eye` : `eye-slash`" />
                            Ignored
                        </button>
                        <!-- Collapse every open folder. Tree scope only (content search shows a flat match list);
                             inert while a name filter is active (a filter force-expands matches) or nothing is open. -->
                        <button
                            v-if="!contentMode"
                            type="button"
                            class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-muted transition-colors hover:text-content disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted"
                            :disabled="filter.trim() !== '' || expanded.size === 0"
                            v-tooltip.bottom="'Collapse all folders'"
                            aria-label="Collapse all folders"
                            @click="collapseAll"
                        >
                            <Icon name="collapse-all" class="text-xs" />
                        </button>
                    </div>
                </div>
                <div v-if="layout.sidebarPanel.value === 'files'" class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
                    <WorkspaceSearchResults
                        v-if="contentMode"
                        :groups="searchGroups"
                        :truncated="searchTruncated"
                        :searching="searching"
                        :pending="searchPending"
                        :error="searchError"
                        :query="filter"
                        @open-match="openAtLine"
                    />
                    <WorkspaceTree
                        v-else
                        :tree="tree"
                        :root-truncated="truncated"
                        :filter="filter"
                        :selected-path="openPath"
                        :manageable-dirs="manageableDirs"
                        :repo-dirs="repoDirs"
                        @open-file="openFile"
                        @open-directory="openDirectory"
                        @open-graph="openGraph"
                    />
                </div>
                <div
                    class="ws-resize"
                    @pointerdown="startResize"
                    @pointermove="onResize"
                    @pointerup="endResize"
                    @dblclick="layout.resetSidebarWidth()"
                    title="Drag to resize · double-click to reset"
                ></div>
                <!-- Root drop hint over the whole panel (files mode only — review/history aren't drop targets);
                     pointer-events-none so drops still reach the rows/aside. -->
                <div v-if="rootDragging && layout.sidebarPanel.value === 'files'" class="ws-dropzone pointer-events-none absolute inset-1 z-10"></div>
            </aside>

            <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
                <!-- Tab row: explorer toggle + open tabs + the workspace status/actions the old top bar held.
                     Always rendered so the controls survive zero open tabs. -->
                <div class="flex h-8 shrink-0 items-stretch border-b border-line bg-card">
                    <button
                        type="button"
                        class="mx-1 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="layout.toggleSidebar()"
                        v-tooltip.bottom="layout.sidebarCollapsed.value ? 'Show explorer' : 'Hide explorer'"
                        aria-label="Toggle explorer"
                    >
                        <Icon name="bars" class="text-sm" />
                    </button>
                    <FileTabs :tabs="tabs" :active="activeId" @select="selectTab" @close="closeTab" @contextmenu="openTabMenu" />
                    <div class="flex shrink-0 items-center gap-2 px-2">
                        <span v-if="actionError" class="max-w-64 truncate text-2xs text-danger" v-tooltip.bottom="actionError">{{
                            actionError
                        }}</span>
                        <Icon name="spinner" v-if="busy" v-tooltip.bottom="'Working…'" class="text-sm text-muted" spin />
                        <span v-if="error" class="max-w-64 truncate text-2xs text-danger" v-tooltip.bottom="error">{{ error }}</span>
                        <button
                            type="button"
                            class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': layout.terminalOpen.value }"
                            @click="layout.toggleTerminalVisibility()"
                            v-tooltip.bottom="'Toggle terminal (Ctrl+`)'"
                            aria-label="Toggle terminal"
                        >
                            <Icon name="code" class="text-sm" />
                        </button>
                        <button
                            type="button"
                            class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                            @click="router.push({ name: 'sandbox', params: { tab: 'sync' }, query: { enable: 'desktop-sync' } })"
                            v-tooltip.bottom="'Edit locally — sync these files to your computer'"
                            aria-label="Edit locally with desktop sync"
                        >
                            <Icon name="desktop" class="text-sm" />
                        </button>
                        <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                        <button
                            type="button"
                            class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                            @click="refetch()"
                            v-tooltip.bottom="'Refresh'"
                            aria-label="Refresh"
                        >
                            <Icon name="refresh" class="text-sm" :spin="isLoading" />
                        </button>
                    </div>
                </div>
                <template v-if="activeFile">
                    <!-- FileViewer renders its own breadcrumb (with edit actions); the directory UI gets a bare one. -->
                    <FileBreadcrumb v-if="directoryUiDir !== undefined" :path="activeFile.path" :meta="openMeta" />
                    <div class="min-h-0 flex-1">
                        <DirectoryUiHost v-if="directoryUiDir !== undefined" :dir="directoryUiDir" />
                        <FileViewer v-else :path="activeFile.path" :meta="openMeta" :line="openLine" @gone="closeTab" />
                    </div>
                </template>
                <div v-else-if="activeTab?.kind === 'diff'" class="min-h-0 flex-1">
                    <p v-if="activeTab.binary" class="p-4 text-xs text-subtle">Binary file — no text diff to show.</p>
                    <p v-else-if="activeTab.truncated" class="p-4 text-xs text-subtle">File too large to diff in the browser.</p>
                    <DiffView v-else :key="activeTab.id" :before="activeTab.before" :after="activeTab.after" :path="activeTab.path" />
                </div>
                <div v-else-if="activeTab?.kind === 'plan'" class="min-h-0 flex-1">
                    <MarkdownViewer :source="activeTab.text" />
                </div>
                <div v-else-if="activeTab?.kind === 'directory'" class="min-h-0 flex-1">
                    <DirectoryOperator :dir="activeTab.dir" />
                </div>
                <div v-else-if="activeTab?.kind === 'graph'" class="min-h-0 flex-1">
                    <GitGraph :repo="activeTab.repo" @open-diff="openDiff" @switch-repo="openGraph" />
                </div>
                <WorkspaceEmptyState v-else @pick="fileInput?.click()" />
                <!-- Drop-to-root hint over the viewer, shown only for external file drags (an internal move is
                     guided by the row rings instead). pointer-events-none so the drop still reaches the body. -->
                <div
                    v-if="rootDragging && externalDrag"
                    class="ws-dropzone pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 text-primary-500"
                >
                    <Icon name="upload" class="text-2xl" />
                    <span class="text-xs font-medium">Drop files to add to workspace root</span>
                </div>
            </section>

            <UploadProgress v-if="uploadScanning || uploadFiles.length > 0 || uploadSkipped !== undefined" />
        </div>

        <!-- Bottom terminal panel. v-if unmounts it when closed, but the tabs live in a module-level Map in
             useTerminal (each a tmux session) — detach only removes the host element, so the shells and scrollback
             survive close, navigation, and page reload. -->

        <!-- Right-click tab menu + the confirm shown before a bulk close discards unsaved edits. Dense pt matches
             the file tree's context menu (WorkspaceTree.vue). -->
        <ContextMenu
            ref="tabMenu"
            :model="tabMenuItems"
            :pt="{
                root: '!min-w-40 !text-xs',
                rootList: '!p-1',
                itemLink: '!gap-2 !rounded !px-2 !py-1 !text-xs',
                itemIcon: '!text-2xs',
                separator: '!my-1',
            }"
        >
            <template #itemicon="{ item }"><Icon :name="item.icon as IconName" /></template>
        </ContextMenu>
        <Dialog
            :visible="pendingClose !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '26rem' }"
            :header="pendingCloseDirty.length === 1 ? 'Discard unsaved changes?' : `Discard unsaved changes in ${pendingCloseDirty.length} files?`"
            @update:visible="pendingClose = undefined"
        >
            <ul class="flex flex-col gap-1">
                <li v-for="path in pendingCloseDirty.slice(0, 5)" :key="path" class="flex min-w-0 items-center gap-2 text-sm">
                    <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
                    <span class="truncate text-content">{{ path }}</span>
                </li>
                <li v-if="pendingCloseDirty.length > 5" class="text-xs text-subtle">…and {{ pendingCloseDirty.length - 5 }} more</li>
            </ul>
            <p class="mt-3 text-xs text-muted">Closing these tabs discards their unsaved edits. This can't be undone.</p>
            <template #footer>
                <Button label="Cancel" severity="secondary" :text="true" @click="pendingClose = undefined" />
                <Button label="Close anyway" severity="danger" autofocus @click="confirmClose">
                    <template #icon><Icon name="times" /></template>
                </Button>
            </template>
        </Dialog>
    </div>
</template>

<style scoped>
/* Drag-to-resize handle on the sidebar's right edge (pointer-capture, no global listeners). */
.ws-resize {
    position: absolute;
    inset: 0 -3px 0 auto;
    width: 6px;
    cursor: col-resize;
    z-index: 20;
    touch-action: none;
    transition: background-color 0.15s;
}
.ws-resize:hover,
.ws.is-resizing .ws-resize {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
.ws.is-resizing {
    user-select: none;
}
/* Root drop-zone hint (a folder row shows its own inset ring instead). */
.ws-dropzone {
    border: 2px dashed color-mix(in srgb, var(--color-primary-500) 60%, transparent);
    background: color-mix(in srgb, var(--color-primary-500) 6%, transparent);
    border-radius: 0.375rem;
}
</style>
