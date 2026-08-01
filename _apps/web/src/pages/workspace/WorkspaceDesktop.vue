<script setup lang="ts">
import { cmp, ConfirmDialog, ContextMenu, type IconName, Segmented } from "@intentic-app/ui";
import type { Disposable } from "@intentic/extension-api";
import Button from "primevue/button";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { inTabSurface } from "../../composables/commands/tabSurface";
import { commandShortcut, registerCommand, type RegisteredCommand } from "../../composables/commands/useCommands";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { usePanels } from "../../composables/extensions/usePanels";
import { detectActivations } from "../../core-views/registry";
import { useEditBuffers } from "../../composables/workspace/useEditBuffers";
import { useMonaco } from "../../composables/workspace/useMonaco";
import { type SidebarPanel, useLayout } from "../../composables/useLayout";
import { reportOpenPath } from "../../composables/usePresence";
import { outgoingMark, outgoingSummary } from "../../composables/workspace/outgoingWork";
import { useChanges } from "../../composables/workspace/useChanges";
import { useRepos } from "../../composables/workspace/useRepos";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { useWorkspaceRoute } from "../../composables/workspace/useWorkspaceRoute";
import { type SearchScope, useWorkspaceSearch } from "../../composables/workspace/useWorkspaceSearch";
import { useSearchOptions } from "../../composables/workspace/useSearchOptions";
import { useWorkspaceTabs } from "../../composables/workspace/useWorkspaceTabs";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { filesToEntries } from "./dropEntries";
import BinaryDiffView from "./viewers/BinaryDiffView.vue";
import CodebaseHealth from "./CodebaseHealth.vue";
import DiffToolbar from "./viewers/DiffToolbar.vue";
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
import { rendersAsBytes } from "./fileType";

/* The Workspace area: a VSCode-like, full-height explorer + viewer of the /work filesystem the agent sees
 * ("what the LLM sees"), read DIRECTLY from the sandbox daemon (no platform state, see CLAUDE.md). A resizable
 * file tree on the left, open-file tabs + a syntax-highlighted / image / PDF / markdown viewer on the right, and
 * Read-only — editing happens via the agent in chat. The terminal panel below is the SHELL's (sandbox-global),
 * toggled from the rail — this view owns no control for it. */

const layout = useLayout();
const { tree, rootHidden, error, isLoading, refetch, entry, expanded, collapseAll, moveIntoMany, run, busy, actionError } = useWorkspaceTree();
const { files: uploadFiles, scanning: uploadScanning, skippedNotice: uploadSkipped, enqueue, enqueueFromDataTransfer } = useUploadQueue();
const { forget, dirtyPaths } = useEditBuffers();
const changes = useChanges();
// Every git repo under /work (root + nested). Marks the tree rows that get a git-history affordance, and feeds
// the graph's repo switcher — the multi-repo axis of the workspace ("root is a repo; it may contain repos").
const { repoDirs } = useRepos();

const openReview = (): void => layout.setSidebarPanel(`changes`);

// The Changes tab's chip when there is no count to show: committed work still on this disk. Gated on a zero
// count because the chip states ONE thing — with files to review, how many is the more urgent of the two.
const changesMark = computed(() => {
    const work = changes.outgoing.value;
    return changes.count.value > 0 || work === undefined ? {} : { mark: outgoingMark(work), markTitle: outgoingSummary(work) };
});

// The sidebar's mode switch lives ON the sidebar (proximity — the control sits with what it changes). The
// Changes tab carries the uncommitted count so pending work is visible from any mode — and, once that count is
// zero, the outgoing mark, so the tab does not read as "nothing here" over a panel holding a Push button.
const sidebarMode = computed<SidebarPanel>({ get: () => layout.sidebarPanel.value, set: (value) => layout.setSidebarPanel(value) });
const sidebarModeOptions = computed(() => [
    // No hint on Files/Changes: "Browse the workspace files" under a pill reading "Files" is the label again in
    // a smaller font. Checkpoints keeps one because the word alone doesn't say what it restores, and Changes
    // gets one only while the mark is up — there the chip is a glyph, and the amount has nowhere else to go.
    { label: `Files`, value: `files` as const },
    { label: `Changes`, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
    { label: `Checkpoints`, value: `history` as const, title: `Restore files to any earlier point` },
]);

const filter = ref(``);
/* One input, three scopes. `name` filters the loaded tree instantly (client-side); the other two search file
 * contents on the daemon (debounced, via useWorkspaceSearch) and swap the tree for a match list:
 *
 *   Text  — what an editor's search box does: the query is one pattern, matched literally (or as a regex with
 *           .*), case-insensitively unless Aa, and every occurrence is marked in the results.
 *   Smart — iq's fused retrieval: the query is a question, its words scored separately against the index and
 *           reranked. Finds the file that ANSWERS the words; finds nothing to underline in them.
 *
 * The Ignored toggle widens BOTH the tree and the search to node_modules/.gitignore'd paths (secrets stay
 * hidden). The match switches beside it belong to Text alone — they change what the pattern means. */
const searchScope = ref<"name" | SearchScope>(`name`);
const contentMode = computed(() => searchScope.value !== `name`);
const textMode = computed(() => searchScope.value === `text`);
const contentScope = computed<SearchScope>(() => (searchScope.value === `smart` ? `smart` : `text`));
const search = useSearchOptions();
// One descriptor per switch so the row is a v-for instead of three near-identical buttons.
const matchToggles = computed(() => [
    { label: `Aa`, title: `Match case`, on: search.matchCase.value, flip: search.toggleMatchCase },
    { label: `ab`, title: `Match whole word`, on: search.wholeWord.value, flip: search.toggleWholeWord },
    { label: `.*`, title: `Use regular expression`, on: search.useRegex.value, flip: search.toggleRegex },
]);
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
} = useWorkspaceSearch(filter, contentScope, contentMode);
// The open tabs live in the useWorkspaceTabs singleton (the chat pushes plan previews in from the shell, and
// tabs survive navigation); this component owns closing — the dirty-confirm dialog and edit-buffer forget.
const {
    tabs,
    activeId,
    activeTab,
    openLine,
    openFile,
    openAtLine,
    openDiff,
    openDirectory,
    openGraph,
    openHealth,
    selectTab,
    closedTabs,
    closeTabIds,
    reopenClosedTab,
} = useWorkspaceTabs();
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

// The store drops the tabs (and remembers them for Reopen Closed Tab); this layer forgets their edit buffers.
const applyClose = (ids: ReadonlySet<string>): void => {
    closeTabIds(ids).forEach(forget); // drop unsaved edit buffers for the closed files
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
// The row that names no particular tab: it tails a tab's menu and it IS the menu a right-click on the strip's
// empty space opens (the chat and terminal strips carry the same pair of entry points).
// Reopen is here too, and it is the one row that survives an EMPTY strip: closing the last tab is exactly when
// a mis-close leaves nothing to right-click but the empty space.
const stripItems = computed<MenuItem[]>(() => [
    ...(tabs.value.length === 0
        ? []
        : [
              {
                  label: `Close All`,
                  shortcut: commandShortcut(`workspace.closeAllTabs`),
                  command: () => requestClose(new Set(tabs.value.map((tab) => tab.id))),
              },
          ]),
    ...(closedTabs.value.length === 0
        ? []
        : [{ label: `Reopen Closed Tab`, shortcut: commandShortcut(`workspace.reopenClosedTab`), command: () => reopenClosedTab() }]),
]);

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined) {
        return stripItems.value;
    }
    const index = tabs.value.findIndex((tab) => tab.id === id);
    const menuTab = tabs.value[index];
    if (menuTab === undefined) {
        return [];
    }
    const others = new Set(tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id));
    const toRight = new Set(tabs.value.slice(index + 1).map((tab) => tab.id));
    return [
        { label: `Close`, icon: `times`, shortcut: commandShortcut(`workspace.closeTab`), command: () => closeTab(id) },
        {
            label: `Close Others`,
            disabled: others.size === 0,
            shortcut: commandShortcut(`workspace.closeOtherTabs`),
            command: () => requestClose(others),
        },
        {
            label: `Close to the Right`,
            disabled: toRight.size === 0,
            shortcut: commandShortcut(`workspace.closeTabsToRight`),
            command: () => requestClose(toRight),
        },
        { separator: true },
        ...stripItems.value, // Close All — the one row the empty-space menu shows on its own
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
// `id` is undefined for a right-click on the strip's empty space — the menu then holds only the strip-wide rows.
// An empty strip has none, so the browser's own menu is left alone there.
const openTabMenu = (id: string | undefined, event: Event): void => {
    if (id === undefined && stripItems.value.length === 0) {
        return;
    }
    event.preventDefault();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Every workspace action as a registered command — palette-searchable (Ctrl+P `>`), on a default chord where
// one earns its keys, all rebindable in Settings → Keybindings and shown as hints in the tab menu above.
// Registered while the Workspace is mounted (scoped to /workspace) and disposed on unmount. Keyboard/palette
// close commands act on the ACTIVE tab (the context menu keeps acting on the right-clicked one) and no-op on
// an empty strip. The close + cycle chords below are the shell-wide tab family: the chat and terminal strips
// register the SAME chords for their own tabs, and focus decides which one a press reaches (tabSurface.ts).
//
// Chord choices dodge three owners of the keyboard. The BROWSER: Ctrl+W / Ctrl+Shift+W / Ctrl+Tab AND
// Ctrl+PageUp/PageDown (VSCode's editor-cycling pair) are un-interceptable tab chords, so Close is
// Ctrl+Shift+X (the × glyph), "," and "." (reads ">") aim Close Others / Close to the Right (physical-key
// matched, see keybindings' CODE_TO_KEY), Close All is Ctrl+Shift+Backspace, and tab cycling sits on
// Alt+PageUp/PageDown — free in every browser, and unlike Ctrl+Shift+[/] not a Monaco fold chord, so it
// still works while editing. Mod+F is deliberately left UNBOUND: it belongs to the browser's own find-in-page
// (and, with the editor focused, to Monaco's find widget) — workspace search lives on Mod+Shift+F alone, so
// nothing has to guess whether a Ctrl+F was meant for us. The SHELL: a bound chord is FORWARDED off a focused
// terminal (terminalSession's key hook), so a bare-Ctrl chord would steal a readline/tmux key; Mod+B (VSCode's
// sidebar toggle) IS the tmux prefix so the explorer toggles on Ctrl+Shift+B instead, and everything else
// stays in the Ctrl+Shift family the terminal panel's commands established. Changes opens on Ctrl+Shift+D
// (D = diff; VSCode's Ctrl+Shift+G is terminal.join's "G = group"); Show Files / Checkpoints / Refresh / Toggle
// Ignored Files ship unbound (palette-only), as VSCode leaves rarely-chorded views.
const closeActiveTab = (): void => {
    if (activeId.value !== null) {
        closeTab(activeId.value);
    }
};
const closeOtherTabs = (): void => {
    const id = activeId.value;
    if (id === null) {
        return;
    }
    const others = new Set(tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id));
    if (others.size > 0) {
        requestClose(others);
    }
};
const closeTabsToRight = (): void => {
    const index = tabs.value.findIndex((tab) => tab.id === activeId.value);
    if (index === -1) {
        return;
    }
    const toRight = new Set(tabs.value.slice(index + 1).map((tab) => tab.id));
    if (toRight.size > 0) {
        requestClose(toRight);
    }
};
const closeAllTabs = (): void => {
    if (tabs.value.length > 0) {
        requestClose(new Set(tabs.value.map((tab) => tab.id)));
    }
};
const filterInput = ref<HTMLInputElement>();
// Reveal the Files sidebar with the cursor in its search input, selecting any previous query (VSCode's find
// flow). Plain find keeps the scope the user last chose; Search in Files forces the text scope. The nextTick
// waits out the v-if that mounts the input when the sidebar mode flips.
const focusSearch = (scope?: "name" | SearchScope): void => {
    layout.setSidebarCollapsed(false);
    layout.setSidebarPanel(`files`);
    if (scope !== undefined) {
        searchScope.value = scope;
    }
    void nextTick(() => {
        filterInput.value?.focus();
        filterInput.value?.select();
    });
};
// Alt+PageDown/PageUp cycle the strip with wrap-around (Next/Previous Editor).
const cycleTab = (delta: number): void => {
    const count = tabs.value.length;
    if (count < 2) {
        return;
    }
    const index = tabs.value.findIndex((tab) => tab.id === activeId.value);
    const next = tabs.value[(index + delta + count) % count];
    if (next !== undefined) {
        selectTab(next.id);
    }
};
const WORKSPACE_COMMANDS: readonly Omit<RegisteredCommand, `owner`>[] = [
    { command: `workspace.search`, title: `Search Workspace…`, icon: `search`, handler: () => focusSearch() },
    {
        command: `workspace.searchContent`,
        title: `Search in Files…`,
        icon: `search`,
        keybinding: `Mod+Shift+F`,
        handler: () => focusSearch(`text`),
    },
    { command: `workspace.showChanges`, title: `Show Changes`, icon: `check-square`, keybinding: `Ctrl+Shift+D`, handler: openReview },
    { command: `workspace.showFiles`, title: `Show Files`, icon: `folder`, handler: () => focusSearch() },
    { command: `workspace.showHistory`, title: `Show Checkpoints`, icon: `history`, handler: () => layout.setSidebarPanel(`history`) },
    // The workspace root's commit graph. Root is a repo like any other but owns no tree row, so this is its
    // keyboard/palette route to the graph — the same target the explorer toolbar's icon opens.
    { command: `workspace.gitHistory`, title: `Show Git History`, icon: `sitemap`, handler: () => openGraph(`root`) },
    // Same story for the root repo's health report — the palette route to what a nested repo opens from its row.
    { command: `workspace.codebaseHealth`, title: `Show Codebase Health`, icon: `wave-pulse`, handler: () => openHealth(`root`) },
    { command: `workspace.toggleSidebar`, title: `Toggle Explorer`, icon: `bars`, keybinding: `Ctrl+Shift+B`, handler: () => layout.toggleSidebar() },
    // The explorer toolbar's Ignored chip, reachable from the palette — and from anywhere the sidebar is
    // collapsed, where the chip isn't on screen to click.
    { command: `workspace.toggleIgnored`, title: `Toggle Ignored Files`, icon: `eye-slash`, handler: () => layout.toggleHideIgnored() },
    // The tab family is shared with the chat and terminal strips and resolved by focus (tabSurface.ts). The
    // workspace is the FALLBACK surface, so its gate is "the keystroke came from neither of the other two" —
    // a chord pressed with focus on the shell chrome, the explorer or the editor still closes an editor tab,
    // exactly as it did before the family was shared.
    { command: `workspace.nextTab`, title: `Next Tab`, keybinding: `Alt+PageDown`, when: inTabSurface(`workspace`), handler: () => cycleTab(1) },
    {
        command: `workspace.previousTab`,
        title: `Previous Tab`,
        keybinding: `Alt+PageUp`,
        when: inTabSurface(`workspace`),
        handler: () => cycleTab(-1),
    },
    {
        command: `workspace.closeTab`,
        title: `Close Tab`,
        icon: `times`,
        keybinding: `Ctrl+Shift+X`,
        when: inTabSurface(`workspace`),
        handler: closeActiveTab,
    },
    {
        command: `workspace.closeOtherTabs`,
        title: `Close Other Tabs`,
        icon: `times`,
        keybinding: `Ctrl+Shift+,`,
        when: inTabSurface(`workspace`),
        handler: closeOtherTabs,
    },
    {
        command: `workspace.closeTabsToRight`,
        title: `Close Tabs to the Right`,
        icon: `times`,
        keybinding: `Ctrl+Shift+.`,
        when: inTabSurface(`workspace`),
        handler: closeTabsToRight,
    },
    {
        command: `workspace.closeAllTabs`,
        title: `Close All Tabs`,
        icon: `times`,
        keybinding: `Ctrl+Shift+Backspace`,
        when: inTabSurface(`workspace`),
        handler: closeAllTabs,
    },
    // The close family's undo. VSCode puts it on Ctrl+Shift+T, which is the one chord a browser will never hand
    // over — it reopens the BROWSER's closed tab and, like Ctrl+W, isn't cancellable — so this takes
    // Ctrl+Shift+O ("reOpen") and stays inside the Ctrl+Shift family the rest of the tab verbs live in. An
    // Alt+letter chord was the other candidate and is worse: Option+Shift+letter composes a glyph on Apple
    // layouts ("ˇ" for T), which the letter half of matchesChord deliberately matches by produced character.
    // Surface-gated like the rest of the family, so a press in a terminal or the chat is left to its owner
    // rather than resurrecting an editor tab behind it.
    {
        command: `workspace.reopenClosedTab`,
        title: `Reopen Closed Tab`,
        icon: `undo`,
        keybinding: `Ctrl+Shift+O`,
        when: inTabSurface(`workspace`),
        handler: reopenClosedTab,
    },
    { command: `workspace.refresh`, title: `Refresh Workspace Files`, icon: `refresh`, handler: () => refetch() },
];
let workspaceCommandDisposables: readonly Disposable[] = [];

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
    workspaceCommandDisposables = WORKSPACE_COMMANDS.map((spec) => registerCommand({ owner: `builtin`, ...spec }));
});
onBeforeUnmount(() => {
    window.removeEventListener(`drop`, resetRootDrag, true);
    window.removeEventListener(`dragend`, resetRootDrag, true);
    for (const disposable of workspaceCommandDisposables) {
        disposable.dispose();
    }
    workspaceCommandDisposables = [];
});
const onPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.files !== null && input.files.length > 0) {
        void enqueue(``, filesToEntries(input.files));
    }
    input.value = ``;
};

// Toolbar tooltips teach their command's key: live through commandShortcut, so a remap re-renders the hint.
const tooltipWithChord = (label: string, command: string): string => {
    const chord = commandShortcut(command);
    return chord === undefined ? label : `${label} (${chord})`;
};
const explorerTooltip = computed(() =>
    tooltipWithChord(layout.sidebarCollapsed.value ? `Show explorer` : `Hide explorer`, `workspace.toggleSidebar`),
);
const rootHistoryTooltip = computed(() => tooltipWithChord(`Git history of the workspace root`, `workspace.gitHistory`));
const rootHealthTooltip = computed(() => tooltipWithChord(`Codebase health of the workspace root`, `workspace.codebaseHealth`));

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
                <div class="view-header flex items-center gap-1 border-b border-line px-1.5">
                    <Segmented v-model="sidebarMode" size="xs" :options="sidebarModeOptions" />
                    <span class="flex-1"></span>
                    <!-- Changes' panel-wide actions ride the switch's row rather than a header row of their own:
                         the switch's "Changes" tab already titles the panel and carries its count, so a second
                         line below it spent height restating both before a single file was named. -->
                    <template v-if="layout.sidebarPanel.value === 'changes'">
                        <!-- Git history: the committed side of the same real-git story the panel below reviews
                             uncommitted. Opens the /work root repo's graph — as does the Files toolbar's icon,
                             root having no tree row of its own; nested repos open theirs from their tree row. -->
                        <button
                            type="button"
                            :class="cmp.iconButton()"
                            @click="openGraph('root')"
                            v-tooltip.bottom="'Git history'"
                            aria-label="Open git history"
                        >
                            <Icon name="sitemap" class="text-xs" />
                        </button>
                        <button
                            type="button"
                            :class="cmp.iconButton()"
                            @click="changes.refresh()"
                            v-tooltip.bottom="'Refresh'"
                            aria-label="Refresh changes"
                            :disabled="changes.actionBusy.value || changes.loading.value"
                        >
                            <Icon name="refresh" class="text-xs" :spin="changes.loading.value || changes.actionBusy.value" />
                        </button>
                    </template>
                </div>
                <ReviewPanel v-if="layout.sidebarPanel.value === 'changes'" @open-diff="openDiff" />
                <HistoryPanel v-else-if="layout.sidebarPanel.value === 'history'" @open-diff="openDiff" />
                <!-- Search header: input hero on row 1; scope switch + ignored-scope toggle on row 2. One `filter`
                     ref, three scopes (name = instant client-side tree filter, text/smart = debounced daemon search).
                     The leading icon doubles as the content-search spinner; the ✕ (and Esc) clear text AND snap scope
                     back to name. The Aa/ab/.* switches sit INSIDE the field, where every editor puts them, and only
                     in the text scope — they change what the pattern means, and the other scopes have no pattern. -->
                <div v-if="layout.sidebarPanel.value === 'files'" class="flex shrink-0 flex-col gap-1 p-1.5">
                    <div class="relative">
                        <Icon
                            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                            aria-hidden="true"
                            :name="contentMode && (searching || searchPending) ? `spinner` : `search`"
                            :spin="contentMode && (searching || searchPending)"
                        />
                        <input
                            ref="filterInput"
                            v-model="filter"
                            type="text"
                            :placeholder="contentMode ? `Search in files…` : `Filter files…`"
                            class="w-full min-w-0 rounded-md border border-line bg-canvas py-1 pl-7 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                            :class="textMode ? `pr-[4.75rem]` : `pr-7`"
                            @keydown.esc="clearFilter"
                        />
                        <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                            <!-- Aa / ab / .* — the same three switches, in the same order, as the editor this
                                 panel is modelled on. Glyphs, not icons: they ARE the notation. `mousedown` is
                                 suppressed so a press leaves the caret in the field it sits inside: the query is
                                 half typed and the next keystroke belongs to it. The click still fires, so
                                 keyboard activation is untouched. -->
                            <template v-if="textMode">
                                <button
                                    v-for="toggle in matchToggles"
                                    :key="toggle.label"
                                    type="button"
                                    class="flex h-4 w-4 items-center justify-center rounded font-mono text-[0.6rem] leading-none text-subtle transition-colors hover:bg-overlay hover:text-content"
                                    :class="{ 'bg-primary-600/20 text-link': toggle.on }"
                                    :aria-pressed="toggle.on"
                                    v-tooltip.bottom="toggle.title"
                                    :aria-label="toggle.title"
                                    @mousedown.prevent
                                    @click="toggle.flip()"
                                >
                                    {{ toggle.label }}
                                </button>
                            </template>
                            <button
                                v-if="filter"
                                type="button"
                                class="flex items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                                v-tooltip.bottom="'Clear (Esc)'"
                                aria-label="Clear filter"
                                @click="clearFilter"
                            >
                                <Icon name="times" />
                            </button>
                        </div>
                    </div>
                    <div class="flex items-center gap-1">
                        <Segmented
                            v-model="searchScope"
                            size="xs"
                            :options="[
                                { label: `Name`, value: `name`, title: `Filter by file name` },
                                { label: `Text`, value: `text`, title: `Search file contents for this exact text` },
                                { label: `Smart`, value: `smart`, title: `Search by meaning — ranked across the indexed workspace` },
                            ]"
                        />
                        <span class="flex-1"></span>
                        <button
                            v-if="contentMode"
                            type="button"
                            class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': search.includeIgnored.value }"
                            :aria-pressed="search.includeIgnored.value"
                            v-tooltip.bottom="
                                search.includeIgnored.value
                                    ? 'Including ignored files — node_modules, gitignored paths, the refs/ reference shelf'
                                    : 'Skipping ignored files — node_modules, gitignored paths, the refs/ reference shelf'
                            "
                            @click="search.toggleIncludeIgnored()"
                        >
                            <Icon class="text-2xs" :name="search.includeIgnored.value ? `eye` : `eye-slash`" />
                            Ignored
                        </button>
                        <!-- The tree's own take on the same set. Shown (grayed) by default — the explorer's job is
                             "what the LLM sees" — so this is the way out when the project itself is what you want
                             to read: node_modules/dist/.turbo go away and the folders you work in close up. The
                             icon says which way it stands, the highlight that it's the non-default one. -->
                        <button
                            v-else
                            type="button"
                            class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': layout.hideIgnored.value }"
                            :aria-pressed="layout.hideIgnored.value"
                            v-tooltip.bottom="
                                layout.hideIgnored.value
                                    ? 'Hiding ignored files — node_modules, gitignored paths, the refs/ reference shelf'
                                    : 'Showing ignored files — node_modules, gitignored paths, the refs/ reference shelf'
                            "
                            @click="layout.toggleHideIgnored()"
                        >
                            <Icon class="text-2xs" :name="layout.hideIgnored.value ? `eye-slash` : `eye`" />
                            Ignored
                        </button>
                        <!-- The /work repo's git history. Root IS a repo (ensureRootRepo versions the whole
                             workspace), but the tree draws no row for it, so its git-history affordance can't ride a
                             row the way a nested repo's does — it belongs on the explorer's own root-scoped toolbar,
                             the same sitemap glyph one level up. Not tree-scoped like Collapse All, so it stays in
                             both search scopes. -->
                        <button
                            type="button"
                            class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-muted transition-colors hover:text-content"
                            v-tooltip.bottom="rootHistoryTooltip"
                            aria-label="Open git history of the workspace root"
                            @click="openGraph('root')"
                        >
                            <Icon name="sitemap" class="text-xs" />
                        </button>
                        <!-- The root repo's codebase health, sibling to its history for the same reason: root
                             owns no tree row to hang the pair off. A nested repo carries both on its own row. -->
                        <button
                            type="button"
                            class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-muted transition-colors hover:text-content"
                            v-tooltip.bottom="rootHealthTooltip"
                            aria-label="Open codebase health of the workspace root"
                            @click="openHealth('root')"
                        >
                            <Icon name="wave-pulse" class="text-xs" />
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
                <!-- The match list owns its own scroller (it virtualizes against it); the tree scrolls in the
                     wrapper the way it always has. -->
                <div v-if="layout.sidebarPanel.value === 'files' && contentMode" class="min-h-0 flex-1">
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
                        :query="filter"
                        @open-match="openAtLine"
                        @load-more="searchLoadMore"
                    />
                </div>
                <div v-else-if="layout.sidebarPanel.value === 'files'" class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
                    <WorkspaceTree
                        :tree="tree"
                        :root-hidden="rootHidden"
                        :filter="filter"
                        :selected-path="openPath"
                        :manageable-dirs="manageableDirs"
                        :repo-dirs="repoDirs"
                        @open-file="openFile"
                        @open-directory="openDirectory"
                        @open-graph="openGraph"
                        @open-health="openHealth"
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
                <div class="view-header flex items-stretch border-b border-line bg-card">
                    <button
                        type="button"
                        class="mx-1 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="layout.toggleSidebar()"
                        v-tooltip.bottom="explorerTooltip"
                        aria-label="Toggle explorer"
                    >
                        <Icon name="bars" class="text-sm" />
                    </button>
                    <FileTabs :tabs="tabs" :active="activeId" @select="selectTab" @close="closeTab" @contextmenu="openTabMenu" />
                    <div class="flex shrink-0 items-center gap-2 px-2">
                        <span v-if="actionError" class="max-w-64 truncate text-2xs text-danger" v-tooltip.bottom.overflow="actionError">{{
                            actionError
                        }}</span>
                        <!-- The lone remaining status: one spinner for both a running file action and a tree
                             (re)load — the Refresh button that used to spin is now only the command. -->
                        <Icon name="spinner" v-if="busy || isLoading" class="text-sm text-muted" spin aria-label="Working" />
                        <span v-if="error" class="max-w-64 truncate text-2xs text-danger" v-tooltip.bottom.overflow="error">{{ error }}</span>
                        <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
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
                <!-- The tab strip names the file; this bar says how it is being READ (side-by-side or inline,
                     comments in or out) — the same bar the agent review renders, so one habit carries across
                     both surfaces. Above every diff state, so a binary or oversized one still has its controls. -->
                <template v-else-if="activeTab?.kind === 'diff'">
                    <DiffToolbar
                        :path="activeTab.label"
                        :status="activeTab.status"
                        :additions="activeTab.additions"
                        :deletions="activeTab.deletions"
                    />
                    <div class="min-h-0 flex-1">
                        <!-- No text to diff is not the same as nothing to see: an image renders as its two sides. -->
                        <BinaryDiffView
                            v-if="rendersAsBytes(activeTab.path, activeTab.binary)"
                            :key="activeTab.id"
                            :path="activeTab.path"
                            :before="activeTab.beforeRaw"
                            :after="activeTab.afterRaw"
                        />
                        <p v-else-if="activeTab.truncated" class="p-4 text-xs text-subtle">File too large to diff in the browser.</p>
                        <DiffView v-else :key="activeTab.id" :before="activeTab.before" :after="activeTab.after" :path="activeTab.path" />
                    </div>
                </template>
                <div v-else-if="activeTab?.kind === 'plan'" class="min-h-0 flex-1">
                    <MarkdownViewer :source="activeTab.text" />
                </div>
                <div v-else-if="activeTab?.kind === 'directory'" class="min-h-0 flex-1">
                    <DirectoryOperator :dir="activeTab.dir" />
                </div>
                <div v-else-if="activeTab?.kind === 'graph'" class="min-h-0 flex-1">
                    <GitGraph :repo="activeTab.repo" @open-diff="openDiff" @switch-repo="openGraph" />
                </div>
                <div v-else-if="activeTab?.kind === 'health'" class="min-h-0 flex-1">
                    <!-- Every ranked row is an anchor: clicking one opens the file it names, because a ranking
                         whose rows don't go anywhere just makes the reader retype a path. -->
                    <CodebaseHealth :repo="activeTab.repo" @open-file="openFile" @switch-repo="openHealth" />
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

        <!-- Right-click tab menu + the confirm shown before a bulk close discards unsaved edits. -->
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :min-width="13" />
        <ConfirmDialog
            :open="pendingClose !== undefined"
            :header="pendingCloseDirty.length === 1 ? 'Discard unsaved changes?' : `Discard unsaved changes in ${pendingCloseDirty.length} files?`"
            confirm-label="Close anyway"
            confirm-icon="times"
            :items="pendingCloseDirty"
            @cancel="pendingClose = undefined"
            @confirm="confirmClose"
        >
            <template #item="{ item }">
                <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
                <span class="truncate text-content">{{ item }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">Closing these tabs discards their unsaved edits. This can't be undone.</p>
        </ConfirmDialog>
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
