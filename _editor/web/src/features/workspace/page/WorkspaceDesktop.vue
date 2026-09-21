<script setup lang="ts">
import { Button, clipboardOf, ui, ConfirmDialog, ContextMenu, type IconName, ResizeSeam, SegmentedControl, useNarrow } from "@intentic/ui";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { Disposable } from "@intentic/extension-api";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { WORKSPACE } from "../../../shell/commands/categories";
import { commandShortcut, type CommandRegistration, registerCommand } from "../../../shell/commands/useCommands";
import { useAudience } from "../../../app/useAudience";
import { useVocabulary } from "../../../core-views/vocabulary";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { usePanels } from "../../extensions/usePanels";
import { personaStartDirs } from "../../sandbox/personas/personaRules";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { useRepoChecks } from "../../sandbox/environment/useRepoChecks";
import { lensPersonaId, reachOf, reachSentence } from "../directory-ui/personaReach";
import { workspaceAgent, workspaceDir } from "../health/workspaceScope";
import { detectActivations } from "../../../core-views/registry";
import { useEditBuffers } from "../files/useEditBuffers";
import { useMonaco } from "../files/useMonaco";
import {
    defaultSidebarWidth,
    DEFAULT_SIDE_PANE_WIDTH,
    MAX_SIDEBAR_WIDTH,
    MIN_PANE_PX,
    MIN_SIDEBAR_WIDTH,
    type SidebarPanel,
    useLayout,
} from "../../../shell/window/useLayout";
import { toAppPx, toScreenPx, uiLength } from "../../../shell/window/uiScale";
import { reportOpenPath } from "../../../shell/presence/usePresence";
import { outgoingMark, outgoingSummary } from "../push/outgoingWork";
import { useDiffStat } from "../changes/useDiffStat";
import { useChanges } from "../changes/useChanges";
import { useUploadQueue } from "../files/upload/useUploadQueue";
import { useWorkspaceRoute } from "../health/useWorkspaceRoute";
import { useExplorerSearch } from "../search/useExplorerSearch";
import type { SearchScope } from "../search/useWorkspaceSearch";
import { matchToggles } from "../search/useSearchOptions";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { opensAsFolder } from "../files/archiveEntries";
import { HOME_DIR_ACTIONS, HOME_SEARCH, useHome } from "../home/useHome";
import { filesOffered, watchDragSource } from "../explorer/transfer/dragSource";
import EntryDragGhost from "../explorer/transfer/EntryDragGhost.vue";
import { filesToEntries } from "../explorer/transfer/dropEntries";
import DirectoryChecks from "../directory-ui/DirectoryChecks.vue";
import DirectoryPersonas from "../directory-ui/DirectoryPersonas.vue";
import EditorPane from "../files/EditorPane.vue";
import HistoryPanel from "../changes/history/HistoryPanel.vue";
import ReviewPanel from "../changes/ReviewPanel.vue";
import SaveActions from "../changes/save/SaveActions.vue";
import SavePanel from "../changes/save/SavePanel.vue";
import WorkspaceDirChip from "../explorer/WorkspaceDirChip.vue";
import WorkspaceScopeChip from "../explorer/WorkspaceScopeChip.vue";
import WorkspaceSearchResults from "../search/WorkspaceSearchResults.vue";
import WorkspaceTree from "../explorer/WorkspaceTree.vue";
import { type RowAction, rowActionsFor } from "../explorer/rowActions";
import { paneOf } from "../tabs/workspaceTabs";
import { HOISTED_CONTEXT } from "../files/viewerChrome";
import { useT } from "@intentic/ui/i18n";

// Full-height explorer + viewer of the /work filesystem the agent sees, read directly from the sandbox daemon.
// Read-only: editing happens via the agent in chat. The bottom terminal panel belongs to the shell
// (sandbox-global); this view owns no control for it.

const t = useT();

const layout = useLayout();
const { maker } = useAudience();
const words = useVocabulary();
const {
    tree,
    rootHidden,
    barren,
    entriesByPath,
    lazyChildren,
    lazyHidden,
    loadChildren,
    error,
    isLoading,
    refetch,
    expanded,
    collapseAll,
    run,
    busy,
    actionError,
    canEditFiles,
    refuseWrite,
} = useWorkspaceTree();

// The tree the explorer draws: the whole workspace, or one folder's contents when rooted there (workspaceDir). A
// folder the walk carried opens at once; one it skipped is asked for, the way expanding it would.
const scopedTree = computed<readonly WorkspaceTreeEntry[]>(() => {
    const dir = workspaceDir.value;
    if (dir === ``) {
        return tree.value;
    }
    return entriesByPath.value.get(dir)?.children ?? lazyChildren.value.get(dir) ?? [];
});
watch(
    () => [workspaceDir.value, entriesByPath.value.get(workspaceDir.value)?.children] as const,
    ([dir, children]) => {
        if (dir !== `` && children === undefined) {
            void loadChildren(dir);
        }
    },
    { immediate: true },
);
const scopedRootHidden = computed(() => (workspaceDir.value === `` ? rootHidden.value : (lazyHidden.value.get(workspaceDir.value) ?? 0)));
const scopedBarren = computed(() =>
    workspaceDir.value === `` ? barren.value : barren.value.filter((path) => path.startsWith(`${workspaceDir.value}/`)),
);
const { enqueue, enqueueFromDataTransfer } = useUploadQueue();
const { forget, dirtyPaths } = useEditBuffers();
const changes = useChanges();

const openReview = (): void => layout.setSidebarPanel(`changes`);

// This view's bar carries the file's context, so breadcrumb and viewer ride the tab row, not their own band.
provide(HOISTED_CONTEXT, true);

// An archived agent's checkout is gone; every pane fails for the same reason, said once here, not three times.
const scopeBroken = computed(() => workspaceAgent.value !== undefined && error.value !== undefined);

// Chip for committed work still on disk with nothing to count; gated on zero for the more urgent of the two.
const changesMark = computed(() => {
    const work = changes.outgoing.value;
    return changes.count.value > 0 || work === undefined ? {} : { mark: outgoingMark(work), markTitle: outgoingSummary(work) };
});

// Mode switch lives on the sidebar; Changes shows its count, then the outgoing mark once zero, never empty.
const sidebarMode = computed<SidebarPanel>({ get: () => layout.sidebarPanel.value, set: (value) => layout.setSidebarPanel(value) });
const sidebarModeOptions = computed(() => [
    // No hint on Files/Changes, the label already says it; Changes gets one only while the mark shows.
    { label: t(`workspace.workspaceDesktop.files`), value: `files` as const },
    // Both audiences get the panel, since the rail badges this count at both and a badge with nowhere to press is
    // only a nag; what differs is the panel behind it (SavePanel has no index and writes its own message).
    { label: words.value.changes, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
]);

// State for the search box; the funnel beside it holds what the list leaves out (tree's Name, search's text).
const { filter, scope: searchScope, contentMode, textMode, options: search, results, clear: clearFilter } = useExplorerSearch();
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
} = results;
// Tabs live in the useWorkspaceTabs singleton to survive navigation; this component owns closing and cleanup.
const {
    tabs,
    activeId,
    activeTab,
    openFile,
    openAtLine,
    openDiff,
    openDirectory,
    openHealth,
    openDocument,
    selectTab,
    deselect,
    keepTab,
    closedTabs,
    closeTabIds,
    reopenClosedTab,
    strip,
    splitOpen,
    splitAllowed,
    openToSide,
    collapseSplit,
} = useWorkspaceTabs();
// Mirrors the active file into the URL so a reload or shared link reopens it.
useWorkspaceRoute();

// Nothing to draw: the pane shows every way to get code in, and the home has no folder to show.
const emptyWorkspace = computed(() => !isLoading.value && tree.value.length === 0);
// The home (features/workspace/home): what is under the tabs. Showing it unsets the main pane's active tab and closes
// nothing, so the strip is a click away from where it was.
const { selected, pick } = useHome();
const homeCovered = computed(() => !emptyWorkspace.value && strip.value.main.active !== null);
const showHome = (): void => deselect(`main`);

// Below ~40rem the tree becomes a drawer over the viewer instead of a column. `drawerOpen` is separate from the
// persisted `sidebarCollapsed`, so a chat-narrowed session can't leave the explorer hidden on a later wide one.
const workspaceBody = ref<HTMLElement | undefined>(undefined);
const narrowBody = useNarrow(workspaceBody, 40);
const drawerOpen = ref(false);
// True while a split has stood the explorer aside, not the persisted `sidebarCollapsed`; clears when it closes.
const autoHidden = ref(false);
// One-shot pulse at the moment of hiding; a silent appearance on an unwatched control goes unseen, then clears.
const justHidden = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
const PULSE_MS = 2600;

const sidebarOpen = computed(() => (narrowBody.value ? drawerOpen.value : !layout.sidebarCollapsed.value && !autoHidden.value));
const toggleSidebar = (): void => {
    if (narrowBody.value) {
        drawerOpen.value = !drawerOpen.value;
        return;
    }
    // A press first answers the dot, restoring the panel for the rest of the split; the next press collapses it.
    if (autoHidden.value) {
        autoHidden.value = false;
        justHidden.value = false;
        return;
    }
    layout.toggleSidebar();
};
// Opening a file is the drawer's whole purpose, so it closes the moment one lands.
watch(
    () => activeId.value,
    () => (drawerOpen.value = false),
);

watch(splitOpen, (open) => {
    clearTimeout(pulseTimer);
    if (!open) {
        autoHidden.value = false;
        justHidden.value = false;
        return;
    }
    if (narrowBody.value || layout.sidebarCollapsed.value) {
        return; // nothing to stand aside: a drawer, or a column the reader already closed
    }
    autoHidden.value = true;
    justHidden.value = true;
    pulseTimer = setTimeout(() => (justHidden.value = false), PULSE_MS);
});

// Measured, not inferred from the window: the rail and chat panel have already taken their share of it.
const bodyWidth = ref(0);
let bodyObserver: ResizeObserver | undefined;
// Both panes need room for a diff (two gutters, ~80 characters each); see MIN_PANE_PX.
const canSplit = computed(() => toAppPx(bodyWidth.value) >= MIN_PANE_PX * 2);
// The companion never squeezes its own pane below that floor; the explorer isn't the editor's to spend.
const maxSideWidth = computed(() =>
    Math.max(MIN_PANE_PX, toAppPx(bodyWidth.value) - MIN_PANE_PX - (sidebarOpen.value && !narrowBody.value ? layout.sidebarWidth.value : 0)),
);
const sideWidth = computed(() => Math.min(layout.sidePaneWidth.value, maxSideWidth.value));
// The seam speaks in pointer coordinates; widths above are app pixels (see uiScale).
const seamWidth = computed<number>({
    get: () => toScreenPx(sideWidth.value),
    set: (px) => layout.setSidePaneWidth(toAppPx(px)),
});

// The store never asks the layout; this view says whether a split fits, folding the companion back if not.
watch(
    canSplit,
    (allowed) => {
        splitAllowed.value = allowed;
        // Only once measured: zero width isn't "too narrow", or a restored split collapses before the real width lands.
        if (!allowed && bodyWidth.value > 0) {
            collapseSplit();
        }
    },
    { immediate: true },
);

// Repos a directory-surface extension serves (Git, Docs, Health, Apps, UI); selecting one opens its management tab,
// not an editor.
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
// Personas whose sessions start in each folder, computed once per render rather than re-filtered per row.
const { personas } = usePersonas();
const personaDirs = computed(() => personaStartDirs(personas.value));
// Folder whose personas are open in the quick panel; undefined means closed.
const personaDir = ref<string | undefined>(undefined);

// Repositories carrying their own checks, keyed by repo id, which is also the tree path for every repo but the
// workspace root (which has no row of its own).
const { repos: declaringRepos } = useRepoChecks();
const checkDirs = computed(
    () => new Map((declaringRepos.value ?? []).map((entry) => [entry.repo, { adopted: entry.adopted, changed: entry.changed }])),
);
// Repository whose checks are open in the quick panel; undefined means closed.
const checksDir = ref<string | undefined>(undefined);

// What each directory row offers beside its name (documents, personas, checks, management). Composed here, where the
// openers live; passed as a function so only on-screen rows are asked.
const rowActions = (dir: string): readonly RowAction[] =>
    rowActionsFor(dir, {
        plain: maker.value,
        manageableDirs: manageableDirs.value,
        personaDirs: personaDirs.value,
        checkDirs: checkDirs.value,
        openDirectory,
        openPersonas: (target: string): void => {
            personaDir.value = target;
        },
        openChecks: (target: string): void => {
            checksDir.value = target;
        },
        openDocument,
    });

// The home's menu offers a folder the same rows; it is mounted by the pane, so they travel by injection.
provide(HOME_DIR_ACTIONS, rowActions);

// The file the reader is in; with two panes, the focused one's. Feeds presence and, through `pick`, the current entry.
const openPath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
// A file opening from anywhere (tree, home, quick-open, chat) becomes the current entry: the home moves to its folder.
watch(
    openPath,
    (path) => {
        if (path !== undefined) {
            pick(path, `file`);
        }
    },
    { immediate: true },
);
// The home's search is the sidebar's: one query, each view answering it in its own scope (HomeView).
provide(HOME_SEARCH, { filter, scope: searchScope, contentMode, groups: searchGroups, searching, clear: clearFilter });
// Presence: announces the open file; component-scoped since it stops existing when this view unmounts.
watch(openPath, (path) => reportOpenPath(path), { immediate: true });
onBeforeUnmount(() => reportOpenPath(undefined));

const fileInput = ref<HTMLInputElement>();
// Root drop zone highlight for OS files; an enter/leave depth stops bubbling over child rows from flickering it off.
const rootDragging = ref(false);
let dragDepth = 0;
// Whether a drag is an upload from this document; shared with tree rows so a row can't accept a rejected drop.
let unwatchDragSource: (() => void) | undefined;

// Pointer coordinates here, while the stored width is app pixels; <ResizeSeam> reports a size, not a position.
const sidebarSeamWidth = computed<number>({
    get: () => toScreenPx(layout.sidebarWidth.value),
    set: (px) => layout.setSidebarWidth(toAppPx(px)),
});

// Explorer filters live behind one funnel menu instead of competing toolbar chips. Rows follow the active
// scope, since Name filters the tree while Text/Smart reach the daemon's own match list.
// The persona lens filters the list to what a persona's own reach would show, checked against the real tree
// rather than the card's text. A radio group (one at a time); "Nobody" is the off state.
const personaLensItems = computed<MenuItem[]>(() =>
    personas.value.length === 0
        ? []
        : [
              {
                  label: t(`workspace.workspaceDesktop.viewing`),
                  items: [
                      {
                          label: t(`workspace.workspaceDesktop.nobody`),
                          checked: lensPersonaId.value === undefined,
                          command: () => (lensPersonaId.value = undefined),
                      },
                      ...personas.value.map((persona) => ({
                          label: persona.label ?? persona.id,
                          checked: lensPersonaId.value === persona.id,
                          command: () => (lensPersonaId.value = persona.id),
                      })),
                  ],
              },
          ],
);

const filterMenu = ref<{ show: (event: Event) => void }>();
const filterMenuItems = computed<MenuItem[]>(() =>
    contentMode.value
        ? [
              {
                  label: t(`workspace.workspaceDesktop.searchIgnoredFiles`),
                  checked: search.includeIgnored.value,
                  command: () => (search.includeIgnored.value = !search.includeIgnored.value),
              },
          ]
        : [
              {
                  label: t(`workspace.workspaceDesktop.showIgnoredFiles`),
                  checked: layout.showIgnored.value,
                  command: () => layout.toggleShowIgnored(),
              },
              { label: t(`workspace.workspaceDesktop.hideTests`), checked: layout.hideTests.value, command: () => layout.toggleHideTests() },
              {
                  label: t(`workspace.workspaceDesktop.hideTechnicalFiles`),
                  checked: layout.hideTechnical.value,
                  command: () => layout.toggleHideTechnical(),
              },
              ...personaLensItems.value,
          ],
);
// Lit whenever the list isn't the default one, so a missing spec or a search into node_modules never reads as
// the workspace itself changing. The technical switch is a maker's default, so it lights only when it disagrees with
// the audience.
const filtersActive = computed(() =>
    contentMode.value
        ? search.includeIgnored.value
        : layout.showIgnored.value || layout.hideTests.value || layout.hideTechnical.value !== maker.value || lensPersonaId.value !== undefined,
);

// The lens's folder list rides a tooltip on the already-lit funnel, not a separate stripe (whose folder names
// wrapped to two lines).
const lensCard = computed(() => personas.value.find((persona) => persona.id === lensPersonaId.value));
const lensLine = computed(() =>
    lensCard.value === undefined ? undefined : reachSentence(lensCard.value.label ?? lensCard.value.id, reachOf(lensCard.value)),
);

// This view's root, where a clipboard write targets the visible window, not the opener's (see clipboardOf).
const rootEl = ref<HTMLElement>();
const tabMenu = ref<{ show: (event: Event) => void }>();
const menuTabId = ref<string>();
const pendingClose = ref<ReadonlySet<string>>();

// Every open tab across both panes: what a close confirm must check (a companion pane's unsaved work is easy
// to miss) and what "Close All" means.
const allTabs = computed(() => [...strip.value.main.tabs, ...strip.value.side.tabs]);

// The store drops the tabs (kept for Reopen Closed Tab); this layer also forgets their edit buffers.
const applyClose = (ids: ReadonlySet<string>): void => {
    closeTabIds(ids).forEach(forget); // drop unsaved edit buffers for the closed files
};
// A lone close stays silent (the dirty dot already shows); a bulk close confirms first if any tab going away is dirty.
const closeTab = (id: string): void => applyClose(new Set([id]));
const requestClose = (ids: ReadonlySet<string>): void => {
    const hasDirty = allTabs.value.some((tab) => ids.has(tab.id) && tab.kind === `file` && dirtyPaths.value.has(tab.path));
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
        : allTabs.value.flatMap((tab) =>
              pendingClose.value?.has(tab.id) === true && tab.kind === `file` && dirtyPaths.value.has(tab.path) ? [tab.path] : [],
          ),
);
// The strip-wide rows (shared with chat/terminal menus); Reopen survives an empty strip, since a mis-close
// leaves nothing else to right-click.
const stripItems = computed<MenuItem[]>(() => [
    ...(allTabs.value.length === 0
        ? []
        : [
              {
                  label: t(`workspace.workspaceDesktop.closeAll`),
                  shortcut: commandShortcut(`workspace.closeAllTabs`),
                  command: () => requestClose(new Set(allTabs.value.map((tab) => tab.id))),
              },
          ]),
    ...(closedTabs.value.length === 0
        ? []
        : [
              {
                  label: t(`workspace.workspaceDesktop.reopenClosedTab`),
                  shortcut: commandShortcut(`workspace.reopenClosedTab`),
                  command: () => reopenClosedTab(),
              },
          ]),
]);

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined) {
        return stripItems.value;
    }
    // Acts on the tab that was right-clicked, in whichever pane holds it: a strip is a strip.
    const home = paneOf(strip.value, id) ?? `main`;
    const paneTabs = strip.value[home].tabs;
    const index = paneTabs.findIndex((tab) => tab.id === id);
    const menuTab = paneTabs[index];
    if (menuTab === undefined) {
        return [];
    }
    const others = new Set(paneTabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
    const toRight = new Set(paneTabs.slice(index + 1).map((tab) => tab.id));
    return [
        // Promotes the preview tab, mirroring the double-click that does the same thing.
        ...(id === strip.value[home].preview
            ? [{ label: t(`workspace.workspaceDesktop.keepOpen`), command: () => keepTab(id) }, { separator: true }]
            : []),
        // The way into a split for pairings nothing can guess: a README beside its code, a test beside its subject.
        ...(canSplit.value
            ? [
                  {
                      label: home === `side` ? `Move Back` : `Open to the Side`,
                      icon: `split-columns`,
                      shortcut: commandShortcut(`workspace.splitEditor`),
                      command: () => openToSide(id),
                  },
                  { separator: true },
              ]
            : []),
        { label: t(`ui.action.close`), icon: `times`, shortcut: commandShortcut(`workspace.closeTab`), command: () => closeTab(id) },
        {
            label: t(`workspace.workspaceDesktop.closeOthers`),
            disabled: others.size === 0,
            shortcut: commandShortcut(`workspace.closeOtherTabs`),
            command: () => requestClose(others),
        },
        {
            label: t(`workspace.workspaceDesktop.closeToRight`),
            disabled: toRight.size === 0,
            shortcut: commandShortcut(`workspace.closeTabsToRight`),
            command: () => requestClose(toRight),
        },
        { separator: true },
        ...stripItems.value, // Close All: the one row the empty-space menu shows on its own
        // Only file/diff tabs have a path to copy; clipboard write goes through this view's root (see clipboardOf).
        ...(menuTab.kind === `file` || menuTab.kind === `diff`
            ? [
                  { separator: true },
                  {
                      label: t(`workspace.workspaceDesktop.copyPath`),
                      icon: `copy`,
                      command: () =>
                          void clipboardOf(rootEl.value)
                              .writeText(menuTab.path)
                              .catch(() => undefined),
                  },
              ]
            : []),
    ];
});
// `id` is undefined for a right-click on empty strip space; an empty strip has no rows, so the browser's own
// menu is left alone.
const openTabMenu = (id: string | undefined, event: Event): void => {
    if (id === undefined && stripItems.value.length === 0) {
        return;
    }
    event.preventDefault();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Every workspace action as a registered command, palette-searchable and rebindable; hints show in the tab
// menu. Close/cycle chords are shared with the chat and terminal strips (tabSurface.ts resolves by focus).
//
// Chord picks dodge three owners of the keyboard:
// - browser: Ctrl+W/Shift+W/Tab and Ctrl+PageUp/Down are un-interceptable, so Close is Ctrl+Shift+X, Close
//   Others/Right are Ctrl+Shift+,/., Close All is Ctrl+Shift+Backspace, cycling is Alt+PageUp/Down.
// - Mod+F stays unbound (it's the browser's find-in-page, and Monaco's own find widget); search uses
//   Mod+Shift+F instead.
// - shell: a bound chord is forwarded off a focused terminal, so Mod+B (the tmux prefix) is avoided; the
//   explorer toggles on Ctrl+Shift+B instead.
// - rarely-used views (Show Files, Restore Points, Refresh, the two filters) ship unbound, palette-only.
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
// The one close verb not about a single pane: "Close All" takes the companion pane's tabs too, ending the split.
const closeAllTabs = (): void => {
    if (allTabs.value.length > 0) {
        requestClose(new Set(allTabs.value.map((tab) => tab.id)));
    }
};
const filterInput = ref<HTMLInputElement>();
// Reveals the Files sidebar with focus in the search input, selecting any previous query. Plain find keeps
// the last scope; Search in Files forces text scope.
const focusSearch = (scope?: "name" | SearchScope): void => {
    layout.setSidebarCollapsed(false);
    autoHidden.value = false; // asked for the explorer by name: a split must not swallow the answer
    layout.setSidebarPanel(`files`);
    if (scope !== undefined) {
        searchScope.value = scope;
    }
    void nextTick(() => {
        filterInput.value?.focus();
        filterInput.value?.select();
    });
};
// Alt+PageDown/PageUp cycle the strip with wrap-around.
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
const WORKSPACE_COMMANDS = computed((): readonly Omit<CommandRegistration, `owner`>[] => [
    { command: `workspace.search`, title: t(`workspace.workspaceDesktop.search`), icon: `search`, handler: () => focusSearch() },
    {
        command: `workspace.searchContent`,
        title: t(`workspace.workspaceDesktop.searchInFiles2`),
        icon: `search`,
        keybinding: `Mod+Shift+F`,
        handler: () => focusSearch(`text`),
    },
    {
        command: `workspace.showChanges`,
        title: t(`workspace.workspaceDesktop.showChanges`),
        icon: `check-square`,
        keybinding: `Ctrl+Shift+D`,
        handler: openReview,
    },
    { command: `workspace.showFiles`, title: t(`workspace.workspaceDesktop.showFiles`), icon: `folder`, handler: () => focusSearch() },
    {
        command: `workspace.showHistory`,
        title: t(`workspace.workspaceDesktop.show`, { restorePoints: words.value.restorePoints }),
        icon: `history`,
        handler: () => layout.setSidebarPanel(`history`),
    },
    // The root repo's health report: the palette route to what a nested repo opens from its own tree row.
    {
        command: `workspace.codebaseHealth`,
        title: t(`workspace.workspaceDesktop.showCodebaseHealth`),
        icon: `wave-pulse`,
        handler: () => openHealth(`root`),
    },
    { command: `workspace.showHome`, title: t(`workspace.workspaceDesktop.showHome2`), icon: `th-large`, handler: showHome },
    {
        command: `workspace.toggleSidebar`,
        title: t(`workspace.workspaceDesktop.toggleExplorer2`),
        icon: `bars`,
        keybinding: `Ctrl+Shift+B`,
        handler: () => toggleSidebar(),
    },
    // One chord toggles both directions; Ctrl+Shift+\ avoids bare Ctrl+\, which is SIGQUIT in a focused terminal.
    {
        command: `workspace.splitEditor`,
        title: t(`workspace.workspaceDesktop.openTabToSide`),
        icon: `split-columns`,
        keybinding: `Ctrl+Shift+\\`,
        when: `tabSurface == 'workspace'`,
        handler: () => openToSide(),
    },
    { command: `workspace.unsplitEditor`, title: t(`workspace.workspaceDesktop.closeSplit`), icon: `split-columns`, handler: () => collapseSplit() },
    // The explorer's two filters, reachable from the palette when the sidebar is collapsed and off-screen.
    {
        command: `workspace.toggleIgnored`,
        title: t(`workspace.workspaceDesktop.toggleIgnoredFiles`),
        icon: `eye`,
        handler: () => layout.toggleShowIgnored(),
    },
    {
        command: `workspace.toggleTests`,
        title: t(`workspace.workspaceDesktop.toggleTestFiles`),
        icon: `filter`,
        handler: () => layout.toggleHideTests(),
    },
    // Shared tab family with chat/terminal (tabSurface.ts resolves by focus); workspace is the fallback surface.
    {
        command: `workspace.nextTab`,
        title: t(`workspace.workspaceDesktop.nextTab`),
        keybinding: `Alt+PageDown`,
        when: `tabSurface == 'workspace'`,
        handler: () => cycleTab(1),
    },
    {
        command: `workspace.previousTab`,
        title: t(`workspace.workspaceDesktop.previousTab`),
        keybinding: `Alt+PageUp`,
        when: `tabSurface == 'workspace'`,
        handler: () => cycleTab(-1),
    },
    {
        command: `workspace.closeTab`,
        title: t(`workspace.workspaceDesktop.closeTab`),
        icon: `times`,
        keybinding: `Ctrl+Shift+X`,
        when: `tabSurface == 'workspace'`,
        handler: closeActiveTab,
    },
    {
        command: `workspace.closeOtherTabs`,
        title: t(`workspace.workspaceDesktop.closeOtherTabs`),
        icon: `times`,
        keybinding: `Ctrl+Shift+,`,
        when: `tabSurface == 'workspace'`,
        handler: closeOtherTabs,
    },
    {
        command: `workspace.closeTabsToRight`,
        title: t(`workspace.workspaceDesktop.closeTabsToRight`),
        icon: `times`,
        keybinding: `Ctrl+Shift+.`,
        when: `tabSurface == 'workspace'`,
        handler: closeTabsToRight,
    },
    {
        command: `workspace.closeAllTabs`,
        title: t(`workspace.workspaceDesktop.closeAllTabs`),
        icon: `times`,
        keybinding: `Ctrl+Shift+Backspace`,
        when: `tabSurface == 'workspace'`,
        handler: closeAllTabs,
    },
    // Ctrl+Shift+O ("reOpen"), not VSCode's Ctrl+Shift+T: that reopens the browser's own tab and isn't cancellable.
    {
        command: `workspace.reopenClosedTab`,
        title: t(`workspace.workspaceDesktop.reopenClosedTab`),
        icon: `undo`,
        keybinding: `Ctrl+Shift+O`,
        when: `tabSurface == 'workspace'`,
        handler: reopenClosedTab,
    },
    { command: `workspace.refresh`, title: t(`workspace.workspaceDesktop.refreshFiles`), icon: `refresh`, handler: () => refetch() },
]);
let workspaceCommandDisposables: readonly Disposable[] = [];

// Root-level upload: OS files dropped on the explorer background or the browse button land at /work root; directories
// recurse via collectDroppedFiles. Rows and tiles move by pointer (useEntryDrag), so no other drag is read here.
const resetRootDrag = (): void => {
    dragDepth = 0;
    rootDragging.value = false;
};
const onRootDragEnter = (event: DragEvent): void => {
    if (!filesOffered(event)) {
        return;
    }
    dragDepth += 1;
    rootDragging.value = true;
};
const onRootDragLeave = (): void => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
        resetRootDrag();
    }
};
const onRootDrop = (event: DragEvent): void => {
    const files = filesOffered(event);
    resetRootDrag();
    // A read-only member sees the tier immediately, not a refusal after the files are dropped.
    if (event.dataTransfer === null || !files || refuseWrite()) {
        return;
    }
    const dataTransfer = event.dataTransfer;
    // Lands in the folder the explorer is rooted at, like the row move above: with a project open, the workspace root
    // isn't on screen, so files dropped there would vanish from the view that took the drop.
    // Runs the capture synchronously (webkitGetAsEntry needs the drop's items alive) and shows scanning instantly.
    enqueueFromDataTransfer(workspaceDir.value, dataTransfer);
};
// A row's own drop stops propagation; the window resets in the capture phase, before that, so the drop hint
// can never stick.
onMounted(() => {
    unwatchDragSource = watchDragSource();
    // The pane's own width decides split geometry; the window's width already went partly to the rail and chat.
    bodyObserver = new ResizeObserver((entries) => {
        bodyWidth.value = entries[0]?.contentRect.width ?? 0;
    });
    if (workspaceBody.value !== undefined) {
        bodyObserver.observe(workspaceBody.value);
    }
    window.addEventListener(`drop`, resetRootDrag, true);
    window.addEventListener(`dragend`, resetRootDrag, true);
    // Loads Monaco (+ Shiki bridge) while browsing the tree, so the first file open isn't cold.
    void useMonaco().ensureMonaco();
    // One family for the whole list, stated here rather than on every entry.
    workspaceCommandDisposables = WORKSPACE_COMMANDS.value.map((spec) => registerCommand({ owner: `builtin`, category: WORKSPACE, ...spec }));
});
onBeforeUnmount(() => {
    unwatchDragSource?.();
    unwatchDragSource = undefined;
    bodyObserver?.disconnect();
    bodyObserver = undefined;
    clearTimeout(pulseTimer);
    window.removeEventListener(`drop`, resetRootDrag, true);
    window.removeEventListener(`dragend`, resetRootDrag, true);
    for (const disposable of workspaceCommandDisposables) {
        disposable.dispose();
    }
    workspaceCommandDisposables = [];
});
const onPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.files !== null && input.files.length > 0 && !refuseWrite()) {
        void enqueue(workspaceDir.value, filesToEntries(input.files));
    }
    input.value = ``;
};

// Tooltips teach their command's key via commandShortcut, so a remap re-renders the hint.
const tooltipWithChord = (label: string, command: string): string => {
    const chord = commandShortcut(command);
    return chord === undefined ? label : `${label} (${chord})`;
};
// States why as well as what: the reader didn't close this panel and shouldn't have to guess what happened to it.
const explorerTooltip = computed(() =>
    tooltipWithChord(
        autoHidden.value ? `Show explorer · hidden to make room for the split` : sidebarOpen.value ? `Hide explorer` : `Show explorer`,
        `workspace.toggleSidebar`,
    ),
);
const rootHealthTooltip = computed(() => tooltipWithChord(`Codebase health of the workspace root`, `workspace.codebaseHealth`));
const homeTooltip = computed(() => tooltipWithChord(`Show home · your tabs stay open`, `workspace.showHome`));
</script>

<template>
    <!-- Swallows drops that miss the explorer, so the browser doesn't navigate to the file (wiping unsaved buffers). -->
    <div
        ref="rootEl"
        class="ws flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-content"
        :class="{ 'ws-scoped': workspaceAgent !== undefined }"
        @dragover.prevent
        @drop.prevent
    >
        <!-- Sidebar + viewer, only the leaf panes scroll. The whole body is the root drop target; a row captures its own. -->
        <div
            ref="workspaceBody"
            class="relative flex min-h-0 flex-1"
            @dragenter="onRootDragEnter"
            @dragover.prevent
            @dragleave="onRootDragLeave"
            @drop.prevent="onRootDrop"
        >
            <!-- A column when there's room for two, a drawer over the viewer otherwise; the drawer ignores the stored column width. -->
            <aside
                v-if="sidebarOpen"
                class="relative flex min-h-0 flex-col border-r border-line bg-card"
                :class="narrowBody ? `absolute inset-y-0 left-0 z-20 w-[min(20rem,85%)] shadow-xl` : `shrink-0`"
                :style="narrowBody ? undefined : { width: uiLength(layout.sidebarWidth.value) }"
            >
                <!-- Files and Changes are the primary modes; restore history is deliberately quieter, sharing one resize handle. -->
                <!-- No bottom rule: the filter row below already separates the switch from the tree; `shadow-none` drops the skin fillet that stands in for one. -->
                <div class="view-header flex items-center gap-1 px-1.5 shadow-none">
                    <SegmentedControl v-model="sidebarMode" size="xs" :options="sidebarModeOptions" />
                    <span class="flex-1"></span>
                    <!-- The maker's whole-tree presses ride this row rather than a bar along the panel's floor, and lead
                         it: what acts on the work sits left of what only changes what is shown. -->
                    <SaveActions v-if="maker && layout.sidebarPanel.value === 'changes'" />
                    <button
                        type="button"
                        :class="ui.iconButton(layout.sidebarPanel.value === 'history' ? 'bg-overlay text-content' : '')"
                        @click="layout.setSidebarPanel('history')"
                        v-tooltip.bottom="words.restorePointsHint"
                        :aria-pressed="layout.sidebarPanel.value === 'history'"
                        :aria-label="words.restorePoints"
                    >
                        <Icon name="history" class="text-xs" />
                    </button>
                    <!-- Changes' panel-wide actions ride the switch's row, since the tab already titles the panel and shows its count. -->
                    <template v-if="layout.sidebarPanel.value === 'changes'">
                        <button
                            type="button"
                            :class="ui.iconButton()"
                            @click="changes.refresh()"
                            v-tooltip.bottom="
                                changes.landing.value === undefined
                                    ? t(`ui.action.refresh`)
                                    : t(`workspace.workspaceDesktop.treeBeingWritten`, { landing: changes.landing.value })
                            "
                            :aria-label="t(`workspace.workspaceDesktop.refreshChanges`)"
                            :disabled="changes.actionBusy.value || changes.fetching.value || changes.landing.value !== undefined"
                        >
                            <Icon name="refresh" class="text-xs" :spin="changes.fetching.value || changes.actionBusy.value" />
                        </button>
                    </template>
                </div>
                <template v-if="layout.sidebarPanel.value === 'changes'">
                    <SavePanel v-if="maker" @open-diff="openDiff" />
                    <ReviewPanel v-else @open-diff="openDiff" />
                </template>
                <HistoryPanel v-else-if="layout.sidebarPanel.value === 'history'" @open-diff="openDiff" />
                <!-- One `filter` ref across three scopes; the Aa/ab/.* switches apply only to the text scope, which has a pattern. -->
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
                            :placeholder="contentMode ? t(`workspace.workspaceDesktop.searchInFiles`) : t(`workspace.workspaceDesktop.filterFiles`)"
                            class="ui-field-box ui-field-sm w-full min-w-0 pl-7"
                            :class="textMode ? `pr-[4.75rem]` : `pr-7`"
                            @keydown.esc="clearFilter"
                        />
                        <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                            <!-- Same three switches, same order, as the editor this models. -->
                            <template v-if="textMode">
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
                            </template>
                            <button
                                v-if="filter"
                                type="button"
                                class="flex items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                                v-tooltip.bottom="t(`workspace.workspaceDesktop.clearEsc`)"
                                :aria-label="t(`workspace.workspaceDesktop.clearFilter`)"
                                @click="clearFilter"
                            >
                                <Icon name="times" />
                            </button>
                        </div>
                    </div>
                    <!-- Files-to-include glob (VSCode grammar), its own field since it's typed, not toggled; content search only. -->
                    <div v-if="contentMode" class="relative">
                        <Icon
                            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                            aria-hidden="true"
                            name="folder"
                        />
                        <input
                            v-model="search.include.value"
                            type="text"
                            :placeholder="t(`workspace.workspaceDesktop.filesToIncludeE`)"
                            class="ui-field-box ui-field-sm w-full min-w-0 pr-2 pl-7"
                            :aria-label="t(`workspace.workspaceDesktop.filesToInclude`)"
                            v-tooltip.bottom="t(`workspace.workspaceDesktop.filesToIncludeComma`)"
                            @keydown.esc="search.include.value = ``"
                        />
                    </div>
                    <div class="flex items-center gap-1">
                        <SegmentedControl
                            v-model="searchScope"
                            size="xs"
                            :options="[
                                { label: `Name`, value: `name`, title: `Filter by file name` },
                                { label: `Text`, value: `text`, title: `Search file contents for this exact text` },
                                { label: `Smart`, value: `smart`, title: `Search by meaning, ranked across the indexed workspace` },
                            ]"
                        />
                        <span class="flex-1"></span>
                        <!-- This control reports which files the workspace list omits. -->
                        <button
                            type="button"
                            class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 transition-colors"
                            :class="filtersActive ? 'bg-primary-600/15 text-link' : 'text-muted hover:text-content'"
                            aria-haspopup="menu"
                            :aria-label="t(`workspace.workspaceDesktop.filterWhatExplorerLists`)"
                            v-tooltip.bottom="lensLine ?? t(`workspace.workspaceDesktop.filter`)"
                            @click="filterMenu?.show($event)"
                        >
                            <Icon name="filter" class="text-xs" />
                        </button>
                        <!-- Root's own codebase health: root is a repo (ensureRootRepo) with no tree row, so this lives on the toolbar. -->
                        <button
                            type="button"
                            class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-muted transition-colors hover:text-content"
                            v-tooltip.bottom="rootHealthTooltip"
                            :aria-label="t(`workspace.workspaceDesktop.openCodebaseHealthWorkspace`)"
                            @click="openHealth('root')"
                        >
                            <Icon name="wave-pulse" class="text-xs" />
                        </button>
                        <!-- Collapse every open folder; tree scope only, inert while a filter forces matches open or nothing is open. -->
                        <button
                            v-if="!contentMode"
                            type="button"
                            :class="ui.iconButton(`h-auto w-auto shrink-0 rounded-md px-1.5 py-0.5 hover:bg-transparent`)"
                            :disabled="filter.trim() !== '' || expanded.size === 0"
                            v-tooltip.bottom="t(`workspace.workspaceDesktop.collapseAllFolders`)"
                            :aria-label="t(`workspace.workspaceDesktop.collapseAllFolders`)"
                            @click="collapseAll"
                        >
                            <Icon name="collapse-all" class="text-xs" />
                        </button>
                    </div>
                </div>
                <!-- Both lists window against a scroller of their own, so neither grows a row per file in the workspace. -->
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
                <!-- Padding belongs to the tree, not this wrapper: it owns the scrollport, and the window measures against it. -->
                <div v-else-if="layout.sidebarPanel.value === 'files'" class="min-h-0 flex-1">
                    <WorkspaceTree
                        :tree="scopedTree"
                        :root-dir="workspaceDir"
                        :root-hidden="scopedRootHidden"
                        :barren="scopedBarren"
                        :filter="filter"
                        :selected-path="selected"
                        :manageable-dirs="manageableDirs"
                        :row-actions="rowActions"
                        @open-file="openFile"
                        @open-directory="openDirectory"
                        @pick="(entry) => pick(entry.path, opensAsFolder(entry) ? `dir` : entry.type)"
                        @clear="selected = undefined"
                    />
                </div>
                <!-- Root drop hint over the whole panel; files mode only, since review/history aren't drop targets. -->
                <!-- A folder row shows its own inset ring instead of this one. -->
                <div
                    v-if="rootDragging && layout.sidebarPanel.value === 'files'"
                    class="pointer-events-none absolute inset-1 z-10 rounded-sm border-2 border-dashed border-primary-500/60 bg-primary-500/6"
                ></div>
            </aside>

            <!-- The seam sizes the explorer and sits outside its column; an inside overlay would scroll away with the rows. -->
            <ResizeSeam
                v-if="sidebarOpen && !narrowBody"
                v-model="sidebarSeamWidth"
                :min="toScreenPx(MIN_SIDEBAR_WIDTH)"
                :max="toScreenPx(MAX_SIDEBAR_WIDTH)"
                :reset="toScreenPx(defaultSidebarWidth())"
                :title="t(`workspace.workspaceDesktop.dragToResizeDouble`)"
            />

            <!-- Dismisses the drawer by clicking the file it covers, the only affordance the toggle doesn't already provide. -->
            <div v-if="narrowBody && sidebarOpen" class="absolute inset-0 z-10 bg-black/30" @click="drawerOpen = false"></div>

            <!-- The editor: one pane, or two with a seam (EditorStrip). Workspace chrome rides the main pane's bar as slots. -->
            <div class="relative flex min-h-0 min-w-0 flex-1">
                <EditorPane
                    pane="main"
                    :broken="scopeBroken"
                    :empty="emptyWorkspace"
                    @select="selectTab"
                    @keep="keepTab"
                    @close="closeTab"
                    @contextmenu="openTabMenu"
                    @pick="canEditFiles ? fileInput?.click() : refuseWrite()"
                >
                    <template #lead>
                        <!-- The explorer control shows when a split pane is hidden. -->
                        <button
                            type="button"
                            :class="ui.iconButton(`relative mx-1 h-7 w-7 self-center`)"
                            @click="toggleSidebar()"
                            v-tooltip.bottom="explorerTooltip"
                            :aria-label="t(`workspace.workspaceDesktop.toggleExplorer`)"
                        >
                            <Icon name="bars" class="text-sm" />
                            <span
                                v-if="autoHidden"
                                class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary-500"
                                :class="{ 'ws-stashed-new': justHidden }"
                                aria-hidden="true"
                            ></span>
                        </button>
                        <!-- What is under the tabs, without closing any; only while a tab covers the home. -->
                        <button
                            v-if="homeCovered"
                            type="button"
                            :class="ui.iconButton(`mr-1 h-7 w-7 self-center`)"
                            @click="showHome"
                            v-tooltip.bottom="homeTooltip"
                            :aria-label="t(`workspace.workspaceDesktop.showHome`)"
                        >
                            <Icon name="th-large" class="text-sm" />
                        </button>
                    </template>
                    <template #status>
                        <div class="flex shrink-0 items-center gap-2 px-2">
                            <span
                                v-if="actionError"
                                class="max-w-64 truncate text-2xs text-danger"
                                v-tooltip.bottom="actionError.detail ?? actionError.title"
                                >{{ actionError.title }}</span
                            >
                            <!-- The one remaining status: a single spinner for both a running file action and a tree (re)load. -->
                            <Icon
                                name="spinner"
                                v-if="busy || isLoading"
                                class="text-sm text-muted"
                                spin
                                :aria-label="t(`workspace.workspaceDesktop.working`)"
                            />
                            <!-- Suppressed while the scope itself is broken, since the pane below already says so at full size. -->
                            <span v-if="error && !scopeBroken" class="max-w-64 truncate text-2xs text-danger" v-tooltip.bottom.overflow="error">{{
                                error
                            }}</span>
                            <!-- Which workspace copy this is about; absent on the shared tree, which needs no marker. -->
                            <WorkspaceScopeChip />
                            <!-- Which folder the tree is rooted at; absent on the whole tree. -->
                            <WorkspaceDirChip />
                            <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                        </div>
                    </template>
                </EditorPane>
                <!-- The seam sizes the companion pane, dragged left to grow the diff; double-click resets its opening width. -->
                <ResizeSeam
                    v-if="splitOpen && !scopeBroken"
                    v-model="seamWidth"
                    pane="after"
                    :min="toScreenPx(MIN_PANE_PX)"
                    :max="toScreenPx(maxSideWidth)"
                    :reset="toScreenPx(DEFAULT_SIDE_PANE_WIDTH)"
                />
                <div
                    v-if="splitOpen && !scopeBroken"
                    class="flex min-h-0 shrink-0 flex-col border-l border-line"
                    :style="{ width: uiLength(sideWidth) }"
                >
                    <EditorPane pane="side" @select="selectTab" @keep="keepTab" @close="closeTab" @contextmenu="openTabMenu" />
                </div>
                <!-- Drop-to-root hint for OS files; a row or tile on the move lights the folder it is over instead. -->
                <div
                    v-if="rootDragging && canEditFiles"
                    class="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-primary-500/60 bg-primary-500/6 text-primary-500"
                >
                    <Icon name="upload" class="text-2xl" />
                    <span class="text-xs font-medium">{{ t(`workspace.workspaceDesktop.dropFilesToAdd`) }}</span>
                </div>
            </div>
        </div>

        <!-- Bottom terminal panel; v-if unmounts only the host element, so its tmux session survives in useTerminal's map. -->

        <!-- Right-click tab menu, plus the confirm shown before a bulk close discards unsaved edits. -->
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :min-width="13" />
        <!-- The explorer toolbar's funnel, opened by a left click rather than a row's right click. -->
        <ContextMenu ref="filterMenu" :model="filterMenuItems" :min-width="11" />
        <ConfirmDialog
            :open="pendingClose !== undefined"
            :header="
                pendingCloseDirty.length === 1
                    ? t(`workspace.workspaceDesktop.discardUnsavedChanges`)
                    : t(`workspace.workspaceDesktop.discardUnsavedChangesIn`, { count: pendingCloseDirty.length })
            "
            :confirm-label="t(`workspace.workspaceDesktop.closeAnyway`)"
            confirm-icon="times"
            :items="pendingCloseDirty"
            @cancel="pendingClose = undefined"
            @confirm="confirmClose"
        >
            <template #item="{ item }">
                <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
                <span class="truncate text-content">{{ item }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">{{ t(`workspace.workspaceDesktop.closingTabsDiscardsUnsaved`) }}</p>
        </ConfirmDialog>
        <!-- Opened by a directory row's person icon: who works there, and how to add one. Mounted here, not the tree. -->
        <DirectoryPersonas v-model="personaDir" />
        <DirectoryChecks v-model="checksDir" />
        <!-- The pill a row or tile becomes while the pointer carries it, over either surface. -->
        <EntryDragGhost />
    </div>
</template>

<style scoped>
/* `.ws-scoped` (the not-shared-tree tint) sits in styles.css beside .view-header, reaching child bars too. */

/* The context seat's own rule travels with the markup, in EditorPane, which now has two such seats. */

/* The dot pulses once via a separate scaling ring, so the dot itself never moves; reduced motion drops the ring. */
.ws-stashed-new::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    border: 1px solid var(--color-primary-500);
    animation: ws-stashed-ping 1.3s cubic-bezier(0, 0, 0.2, 1) 2;
}
@keyframes ws-stashed-ping {
    0% {
        transform: scale(1);
        opacity: 0.8;
    }
    80%,
    100% {
        transform: scale(2.8);
        opacity: 0;
    }
}
@media (prefers-reduced-motion: reduce) {
    .ws-stashed-new::after {
        animation: none;
    }
}
</style>
