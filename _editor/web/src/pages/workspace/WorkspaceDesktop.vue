<script setup lang="ts">
import { Button, clipboardOf, ui, ConfirmDialog, ContextMenu, type IconName, ResizeSeam, SegmentedControl, useNarrow } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { commandShortcut, type CommandRegistration, registerCommand } from "../../composables/commands/useCommands";
import { openPreview } from "../../composables/preview/previewSurface";
import { repoTargetId } from "../../composables/preview/previewModel";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { usePanels } from "../../composables/extensions/usePanels";
import { personaStartDirs } from "../../composables/sandbox/personaCard";
import { usePersonas } from "../../composables/sandbox/usePersonas";
import { lensPersonaId, reachOf, reachSentence } from "../../composables/workspace/personaReach";
import ChangeOrderButton from "../../components/ChangeOrderButton.vue";
import { workspaceAgent } from "../../composables/workspace/workspaceScope";
import { detectActivations } from "../../core-views/registry";
import { useEditBuffers } from "../../composables/workspace/useEditBuffers";
import { useMonaco } from "../../composables/workspace/useMonaco";
import { DEFAULT_SIDE_PANE_WIDTH, MIN_PANE_PX, type SidebarPanel, useLayout } from "../../composables/useLayout";
import { toAppPx, toScreenPx, uiLength } from "../../composables/uiScale";
import { reportOpenPath } from "../../composables/usePresence";
import { outgoingMark, outgoingSummary } from "../../composables/workspace/outgoingWork";
import { useDiffStat } from "../../composables/workspace/useDiffStat";
import { useChanges } from "../../composables/workspace/useChanges";
import { useRepos } from "../../composables/workspace/useRepos";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { useWorkspaceRoute } from "../../composables/workspace/useWorkspaceRoute";
import { type SearchScope, useWorkspaceSearch } from "../../composables/workspace/useWorkspaceSearch";
import { MATCH_TOGGLES, useSearchOptions } from "../../composables/workspace/useSearchOptions";
import { useWorkspaceTabs } from "../../composables/workspace/useWorkspaceTabs";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { dragOffer, watchDragSource } from "./dragSource";
import { filesToEntries } from "./dropEntries";
import DirectoryPersonas from "./DirectoryPersonas.vue";
import EditorPane from "./EditorPane.vue";
import HistoryPanel from "./HistoryPanel.vue";
import ReviewPanel from "./ReviewPanel.vue";
import WorkspaceScopeChip from "./WorkspaceScopeChip.vue";
import WorkspaceSearchResults from "./WorkspaceSearchResults.vue";
import WorkspaceTree from "./WorkspaceTree.vue";
import { type RowAction, rowActionsFor } from "./rowActions";
import { paneOf } from "./workspaceTabs";
import { HOISTED_CONTEXT } from "./viewerChrome";

/* The Workspace area: a VSCode-like, full-height explorer + viewer of the /work filesystem the agent sees
 * ("what the LLM sees"), read DIRECTLY from the sandbox daemon (no platform state, see CLAUDE.md). A resizable
 * file tree on the left, open-file tabs + a syntax-highlighted / image / PDF / markdown viewer on the right, and
 * Read-only: editing happens via the agent in chat. The terminal panel below is the SHELL's (sandbox-global),
 * toggled from the rail: this view owns no control for it. */

const layout = useLayout();
const { tree, rootHidden, error, isLoading, refetch, expanded, collapseAll, moveIntoMany, run, busy, actionError } = useWorkspaceTree();
const { enqueue, enqueueFromDataTransfer } = useUploadQueue();
const { forget, dirtyPaths } = useEditBuffers();
const changes = useChanges();
// Every git repo under /work (root + nested). Marks the tree rows that get a git-history affordance, and feeds
// the graph's repo switcher: the multi-repo axis of the workspace ("root is a repo; it may contain repos").
const { repoDirs } = useRepos();

const openReview = (): void => layout.setSidebarPanel(`changes`);

/* THIS VIEW'S BAR CARRIES THE OPEN FILE'S CONTEXT, so the breadcrumb rides the tab row instead of opening a
 * band under it, and the markdown surface's controls ride the breadcrumb (see viewerChrome). The phone provides
 * nothing and gets the bands, which is right there: it has no tab strip to hang them on. */
provide(HOISTED_CONTEXT, true);

/* THE SCOPE IS POINTED AT A CHECKOUT THAT ISN'T THERE. An archived agent keeps its work on its branch but
 * loses its working copy, so there is no tree to read and no file to open: every pane in this view is about to
 * fail for the same one reason. Said once, in the pane, rather than three times in three error slots. */
const scopeBroken = computed(() => workspaceAgent.value !== undefined && error.value !== undefined);

// The Changes tab's chip when there is no count to show: committed work still on this disk. Gated on a zero
// count because the chip states ONE thing: with files to review, how many is the more urgent of the two.
const changesMark = computed(() => {
    const work = changes.outgoing.value;
    return changes.count.value > 0 || work === undefined ? {} : { mark: outgoingMark(work), markTitle: outgoingSummary(work) };
});

// The sidebar's primary mode switch lives ON the sidebar (proximity: the control sits with what it changes).
// Files and Changes are the everyday views; restore history is the quieter icon beside them. The Changes tab
// carries the uncommitted count so pending work is visible from any mode, and, once that count is zero, the
// outgoing mark, so the tab does not read as "nothing here" over a panel holding a Push button.
const sidebarMode = computed<SidebarPanel>({ get: () => layout.sidebarPanel.value, set: (value) => layout.setSidebarPanel(value) });
const sidebarModeOptions = computed(() => [
    // No hint on Files/Changes: "Browse the workspace files" under a pill reading "Files" is the label again in
    // a smaller font. Changes gets one only while the mark is up: there the chip is a glyph, and the amount has
    // nowhere else to go.
    { label: `Files`, value: `files` as const },
    { label: `Changes`, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
]);

const filter = ref(``);
/* One input, three scopes. `name` filters the loaded tree instantly (client-side); the other two search file
 * contents on the daemon (debounced, via useWorkspaceSearch) and swap the tree for a match list:
 *
 *   Text , what an editor's search box does: the query is one pattern, matched literally (or as a regex with
 *           .*), case-insensitively unless Aa, and every occurrence is marked in the results.
 *   Smart, iq's fused retrieval: the query is a question, its words scored separately against the index and
 *           reranked. Finds the file that ANSWERS the words; finds nothing to underline in them.
 *
 * The funnel beside the scopes holds what the list on screen leaves out: the tree's under Name, the search's
 * under Text/Smart, all off by default. The match switches inside the field belong to Text alone: they change
 * what the pattern means. */
const searchScope = ref<"name" | SearchScope>(`name`);
const contentMode = computed(() => searchScope.value !== `name`);
const textMode = computed(() => searchScope.value === `text`);
const contentScope = computed<SearchScope>(() => (searchScope.value === `smart` ? `smart` : `text`));
const search = useSearchOptions();
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
// The open tabs live in the useWorkspaceTabs singleton so they survive navigation; this component owns closing
//: the dirty-confirm dialog and edit-buffer forget.
const {
    tabs,
    activeId,
    activeTab,
    openFile,
    openAtLine,
    openDiff,
    fillDiff,
    openDirectory,
    openHealth,
    openDocument,
    selectTab,
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
// Mirror the active file into the URL (`/workspace/<path>`) so a reload / shared link reopens it.
useWorkspaceRoute();

/* THE EXPLORER STOPS BEING A COLUMN WHEN THERE IS NO ROOM FOR TWO. This view renders into the workspace pane,
 * not the window, so a reader with the chat panel open gets ~500px, and the explorer's own floor is 272px, which
 * left the file they opened about 190px to be read in: "Drop your work here" came out one word per line. Below
 * ~40rem the tree becomes a DRAWER over the viewer instead: the same rows, the same actions, opened and closed by
 * the same control, but the file always has the pane.
 *
 * The drawer's open state is local and starts closed, deliberately: `sidebarCollapsed` is a preference the reader
 * set for a docked column on a wide pane, and writing "collapsed" into it because a chat panel is open would hand
 * them a hidden explorer on their next full-width session. Two situations, two pieces of state, and the toggle,
 * the command and the tooltip all route through here so there is still ONE control. */
const workspaceBody = ref<HTMLElement | undefined>(undefined);
const narrowBody = useNarrow(workspaceBody, 40);
const drawerOpen = ref(false);
/* THE EXPLORER STANDS ASIDE FOR A SPLIT, and says so on the control that brings it back.
 *
 * Two panes and a docked tree are three columns in a pane that often has room for two, and the tree is the one
 * of the three the reader is NOT looking at: they are reading a document and the file it names. So opening a
 * split hides it, and closing the split gives it back.
 *
 * It is its own piece of state, never the stored preference: `sidebarCollapsed` is what this reader chose for a
 * docked column, and writing "collapsed" into it because a split is open would hand them a hidden explorer in
 * every later session. Same two-pieces-of-state rule as the narrow drawer above. The hamburger carries a dot
 * while this is true, because a panel that vanishes without a trace is indistinguishable from one that broke. */
const autoHidden = ref(false);
// The dot's one-shot pulse, at the moment of hiding: an indicator that appears silently on a control nobody was
// looking at is the same as no indicator. It stops on its own, so it never becomes furniture.
const justHidden = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
const PULSE_MS = 2600;

const sidebarOpen = computed(() => (narrowBody.value ? drawerOpen.value : !layout.sidebarCollapsed.value && !autoHidden.value));
const toggleSidebar = (): void => {
    if (narrowBody.value) {
        drawerOpen.value = !drawerOpen.value;
        return;
    }
    // The press answers the dot first: the reader is asking for the panel the split took away, and it then stays
    // for the rest of that split. A second press collapses it as it always did.
    if (autoHidden.value) {
        autoHidden.value = false;
        justHidden.value = false;
        return;
    }
    layout.toggleSidebar();
};
// Opening a file is the drawer's whole purpose, so it gets out of the way the moment one lands.
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

/* HOW WIDE THE PANE IS, in one measurement that answers both of the split's geometry questions: whether there is
 * room for two panes at all, and how far the seam between them may travel. Measured rather than inferred from
 * the window, this view renders into the workspace column, which the chat panel and the rail have already taken
 * their share of. */
const bodyWidth = ref(0);
let bodyObserver: ResizeObserver | undefined;
// Both panes have to stay readable, and a diff's floor is the chat's: two gutters, two sets of line numbers and
// something like eighty characters between them (see MIN_PANE_PX).
const canSplit = computed(() => toAppPx(bodyWidth.value) >= MIN_PANE_PX * 2);
// What the seam may not cross: the companion never squeezes the pane it was opened from below that same floor,
// and the docked explorer's column is not the editor's to spend.
const maxSideWidth = computed(() =>
    Math.max(MIN_PANE_PX, toAppPx(bodyWidth.value) - MIN_PANE_PX - (sidebarOpen.value && !narrowBody.value ? layout.sidebarWidth.value : 0)),
);
const sideWidth = computed(() => Math.min(layout.sidePaneWidth.value, maxSideWidth.value));
// The seam speaks in pointer coordinates; every width above is in app pixels (see uiScale).
const seamWidth = computed<number>({
    get: () => toScreenPx(sideWidth.value),
    set: (px) => layout.setSidePaneWidth(toAppPx(px)),
});

// The store never asks the layout anything; the surface that draws the panes tells it whether a split can be
// drawn at all. A pane that has just become too narrow folds its companion back in rather than leaving tabs in
// a column nobody can read.
watch(
    canSplit,
    (allowed) => {
        splitAllowed.value = allowed;
        // Only once the pane has actually been MEASURED: before the first observer callback the width is zero,
        // which is not "too narrow", and folding on it would collapse a split restored from the last session
        // one tick before the real width arrived.
        if (!allowed && bodyWidth.value > 0) {
            collapseSplit();
        }
    },
    { immediate: true },
);

// Repository directories that a directory-surface extension serves (Apps, UI): selecting one in the tree
// opens its management surface as a tab. Rail-surface repos (intent/desired-state) are absent by design.
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
// …and the ones the Preview area can show live: a runnable repo, or a monorepo whose apps preview. The row's
// eye selects that repo's target and walks to /preview (the rail panel), rather than opening an editor tab.
const router = useRouter();
const previewableDirs = computed(() => new Set(panels.value.filter((panel) => panel.hasPanel || panel.monorepo).map((panel) => panel.repo)));
/* WHO WORKS IN EACH FOLDER: the personas whose sessions start there, counted once per render rather than
 * re-filtered on every visible row. The folder a card starts in is set from the row itself (see
 * <DirectoryPersonas>), so this is also what makes that icon light up the moment one is saved. */
const { personas } = usePersonas();
const personaDirs = computed(() => personaStartDirs(personas.value));
// The folder whose personas are open in the quick panel; undefined = closed.
const personaDir = ref<string | undefined>(undefined);

/* What each directory row offers beside its name: its documents, its health, its history, its personas, its
 * management panel. Composed here because this is where the openers live; the tree just draws them (see
 * rowActions.ts). Passed as a function so only the rows actually on screen are asked, and read inside the tree's
 * render, so an extension registering a document provider lights up the rows it serves without anything having to
 * invalidate. */
const rowActions = (dir: string): readonly RowAction[] =>
    rowActionsFor(dir, {
        repoDirs: repoDirs.value,
        manageableDirs: manageableDirs.value,
        previewableDirs: previewableDirs.value,
        personaDirs: personaDirs.value,
        openHealth,
        openDirectory,
        openPreview: (target: string): void => openPreview(router, repoTargetId(target)),
        openPersonas: (target: string): void => {
            personaDir.value = target;
        },
        openDocument,
    });

// The file the reader is IN, which with two panes means the focused one's: the tree's selection mark and the
// presence report are both about where the person is, not about everything on screen.
const openPath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
// Presence: announce which file this tab has open. Component-scoped is right here, the open file genuinely
// ceases to exist when the Workspace area unmounts, and the unmount below clears it.
watch(openPath, (path) => reportOpenPath(path), { immediate: true });
onBeforeUnmount(() => reportOpenPath(undefined));

const fileInput = ref<HTMLInputElement>();
// Root drop zone highlight, tracked with an enter/leave depth so bubbling over child rows doesn't flicker it off.
const rootDragging = ref(false);
// True while the drag carries OS files (vs an internal tree-row move): gates the viewer's "drop to add" overlay.
const externalDrag = ref(false);
let dragDepth = 0;
// Whether a drag is an upload at all, and whether it started in this document, which is the half of that
// question a drag store can't answer. Shared with the tree's rows (dragSource.ts): a drop this background
// would decline must not be accepted by a row just because the pointer was over one.
let unwatchDragSource: (() => void) | undefined;

const resizing = ref(false);
const sidebar = ref<HTMLElement>();
// The sidebar's left viewport offset, captured at drag start: its width is the pointer's distance from it (the
// sidebar is not flush to the viewport edge; the shell's rail sits to its left).
let sidebarLeft = 0;

const clearFilter = (): void => {
    filter.value = ``;
    searchScope.value = `name`;
};

/* The explorer's filters, behind one funnel. They used to be a single "Ignored" chip that swapped meaning with
 * the scope; a menu takes that pair of long labels off a 256px-wide toolbar and gives the second filter: tests
 *: somewhere to live that isn't another chip competing for the same row.
 *
 * The rows follow the scope, because each one has to change what is on screen when it is clicked: under Name
 * that is the tree (both filters apply), under Text/Smart it is the daemon's match list, which the tree's own
 * switches don't reach: the search widens over ignored paths or it doesn't, and tests come back either way.
 * A row that changed nothing visible would be worse than no row. */
/* VIEWING AS A PERSONA: the fence on a card, checked against the real tree instead of read back as the words
 * somebody typed. Under the funnel with the other two because it is the same kind of thing: it changes what the
 * list on screen is SAYING without changing what the workspace holds. Absent entirely on a box with no personas
 *: a submenu offering nothing is a worse answer than no submenu.
 *
 * A radio group, not checkboxes: two personas at once would need two dimmings, and "what would BOTH of them be
 * refused" is not a question anybody has. "Nobody" is listed rather than left to a second gesture, so turning the
 * lens off is where turning it on was. */
const personaLensItems = computed<MenuItem[]>(() =>
    personas.value.length === 0
        ? []
        : [
              {
                  label: `Viewing as`,
                  items: [
                      { label: `Nobody`, checked: lensPersonaId.value === undefined, command: () => (lensPersonaId.value = undefined) },
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
                  label: `Search ignored files`,
                  checked: search.includeIgnored.value,
                  command: () => (search.includeIgnored.value = !search.includeIgnored.value),
              },
          ]
        : [
              { label: `Show ignored files`, checked: layout.showIgnored.value, command: () => layout.toggleShowIgnored() },
              { label: `Hide tests`, checked: layout.hideTests.value, command: () => layout.toggleHideTests() },
              ...personaLensItems.value,
          ],
);
// Lit whenever the list on screen is NOT the default one, so a tree missing its specs, or a search that walked
// node_modules: never reads as the workspace itself having changed.
const filtersActive = computed(() =>
    contentMode.value ? search.includeIgnored.value : layout.showIgnored.value || layout.hideTests.value || lensPersonaId.value !== undefined,
);

/* WHOSE REACH THE TREE IS BEING DIMMED BY, on the funnel that is already lit for it rather than in a stripe of
 * its own above the tree. The stripe was a second indicator for a state this button ALREADY reports (see
 * `filtersActive`, which counts the lens), and it was the more expensive of the two by the width of the
 * sidebar: its payload is a folder list, which is exactly what a 256px strip has to truncate, so it wrapped to
 * two lines and took them from the tree.
 *
 * A tooltip is where a long answer belongs on a lit control: the lens is visible without it, and the reader who
 * wants to know WHICH folders is the reader whose pointer is already on the funnel, going for the menu. */
const lensCard = computed(() => personas.value.find((persona) => persona.id === lensPersonaId.value));
const lensLine = computed(() =>
    lensCard.value === undefined ? undefined : reachSentence(lensCard.value.label ?? lensCard.value.id, reachOf(lensCard.value)),
);

// Right-click tab menu (VSCode-style). It acts on the right-clicked tab (`menuTabId`), which "Close Others"/"Close to
// the Right" keep. `pendingClose` holds the set awaiting the unsaved-changes confirm; its dirty paths feed the dialog.
// This view's root: the element a clipboard write is reached through, so it lands in the window the user is
// looking at rather than the opener's (see clipboardOf).
const rootEl = ref<HTMLElement>();
const tabMenu = ref<{ show: (event: Event) => void }>();
const menuTabId = ref<string>();
const pendingClose = ref<ReadonlySet<string>>();

// Every open tab, both panes: what a close CONFIRM has to look through (unsaved work in the companion pane is
// exactly the kind that is easy to miss) and what the strip-wide "Close All" means.
const allTabs = computed(() => [...strip.value.main.tabs, ...strip.value.side.tabs]);

// The store drops the tabs (and remembers them for Reopen Closed Tab); this layer forgets their edit buffers.
const applyClose = (ids: ReadonlySet<string>): void => {
    closeTabIds(ids).forEach(forget); // drop unsaved edit buffers for the closed files
};
// The single × (and the menu's "Close") stay silent: the dirty dot is right there on the tab. Bulk closes confirm
// first when any of the tabs going away has unsaved edits (a background tab's dirt is easy to miss).
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
// The row that names no particular tab: it tails a tab's menu and it IS the menu a right-click on the strip's
// empty space opens (the chat and terminal strips carry the same pair of entry points).
// Reopen is here too, and it is the one row that survives an EMPTY strip: closing the last tab is exactly when
// a mis-close leaves nothing to right-click but the empty space.
const stripItems = computed<MenuItem[]>(() => [
    ...(allTabs.value.length === 0
        ? []
        : [
              {
                  label: `Close All`,
                  shortcut: commandShortcut(`workspace.closeAllTabs`),
                  command: () => requestClose(new Set(allTabs.value.map((tab) => tab.id))),
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
    // The menu acts on the tab that was right-clicked, in whichever pane holds it: a strip is a strip.
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
        // Promoting the preview tab, beside the double-click that does the same thing: the gesture is invisible,
        // and a menu is where someone goes to find out what a tab can do.
        ...(id === strip.value[home].preview ? [{ label: `Keep Open`, command: () => keepTab(id) }, { separator: true }] : []),
        // The way into a split for the pairings nothing can guess: a README beside the code it describes, a test
        // beside its subject. A diff opened from a document tab already lands beside it without being asked.
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
        ...stripItems.value, // Close All: the one row the empty-space menu shows on its own
        // Only file/diff tabs have a filesystem path to copy (directory and generated panels don't).
        // Reached through this view's root so a floating panel writes to the focused window (see clipboardOf);
        // the clipboard may still be unavailable (insecure context): swallow, matching CopyButton.
        ...(menuTab.kind === `file` || menuTab.kind === `diff`
            ? [
                  { separator: true },
                  {
                      label: `Copy Path`,
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
// `id` is undefined for a right-click on the strip's empty space: the menu then holds only the strip-wide rows.
// An empty strip has none, so the browser's own menu is left alone there.
const openTabMenu = (id: string | undefined, event: Event): void => {
    if (id === undefined && stripItems.value.length === 0) {
        return;
    }
    event.preventDefault();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Every workspace action as a registered command: palette-searchable (Ctrl+P `>`), on a default chord where
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
// Alt+PageUp/PageDown: free in every browser, and unlike Ctrl+Shift+[/] not a Monaco fold chord, so it
// still works while editing. Mod+F is deliberately left UNBOUND: it belongs to the browser's own find-in-page
// (and, with the editor focused, to Monaco's find widget): workspace search lives on Mod+Shift+F alone, so
// nothing has to guess whether a Ctrl+F was meant for us. The SHELL: a bound chord is FORWARDED off a focused
// terminal (terminalSession's key hook), so a bare-Ctrl chord would steal a readline/tmux key; Mod+B (VSCode's
// sidebar toggle) IS the tmux prefix so the explorer toggles on Ctrl+Shift+B instead, and everything else
// stays in the Ctrl+Shift family the terminal panel's commands established. Changes opens on Ctrl+Shift+D
// (D = diff; VSCode's Ctrl+Shift+G is terminal.join's "G = group"); Show Files / Restore Points / Refresh / the two
// explorer filters ship unbound (palette-only), as VSCode leaves rarely-chorded views.
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
// The one close verb that is not about a pane: "Close All" means the editor, so it takes the companion pane's
// tabs with it and the split ends.
const closeAllTabs = (): void => {
    if (allTabs.value.length > 0) {
        requestClose(new Set(allTabs.value.map((tab) => tab.id)));
    }
};
const filterInput = ref<HTMLInputElement>();
// Reveal the Files sidebar with the cursor in its search input, selecting any previous query (VSCode's find
// flow). Plain find keeps the scope the user last chose; Search in Files forces the text scope. The nextTick
// waits out the v-if that mounts the input when the sidebar mode flips.
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
const WORKSPACE_COMMANDS: readonly Omit<CommandRegistration, `owner`>[] = [
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
    { command: `workspace.showHistory`, title: `Show Restore Points`, icon: `history`, handler: () => layout.setSidebarPanel(`history`) },
    // The root repo's health report: the palette route to what a nested repo opens from its own tree row.
    { command: `workspace.codebaseHealth`, title: `Show Codebase Health`, icon: `wave-pulse`, handler: () => openHealth(`root`) },
    { command: `workspace.toggleSidebar`, title: `Toggle Explorer`, icon: `bars`, keybinding: `Ctrl+Shift+B`, handler: () => toggleSidebar() },
    /* The split, both directions on one chord, because it is one toggle: the active tab goes to the companion
     * pane, and a tab already there comes back. `Ctrl+Shift+\` rather than VSCode's bare `Ctrl+\`, which is
     * SIGQUIT in a focused terminal (a bound chord is forwarded there, see the note above), and it keeps the
     * editor's verbs in the one Ctrl+Shift family. Unsplitting the whole pane is palette-only: it is the button
     * on the companion pane's own bar, where a reader who opened a split looks for it. */
    {
        command: `workspace.splitEditor`,
        title: `Open Tab to the Side`,
        icon: `split-columns`,
        keybinding: `Ctrl+Shift+\\`,
        when: `tabSurface == 'workspace'`,
        handler: () => openToSide(),
    },
    { command: `workspace.unsplitEditor`, title: `Close Split`, icon: `split-columns`, handler: () => collapseSplit() },
    // The explorer's two filters, reachable from the palette, and from anywhere the sidebar is collapsed, where
    // the toolbar's funnel isn't on screen to click.
    { command: `workspace.toggleIgnored`, title: `Toggle Ignored Files`, icon: `eye`, handler: () => layout.toggleShowIgnored() },
    { command: `workspace.toggleTests`, title: `Toggle Test Files`, icon: `filter`, handler: () => layout.toggleHideTests() },
    // The tab family is shared with the chat and terminal strips and resolved by focus (tabSurface.ts). The
    // workspace is the FALLBACK surface, so its gate is "the keystroke came from neither of the other two":
    // a chord pressed with focus on the shell chrome, the explorer or the editor still closes an editor tab,
    // exactly as it did before the family was shared.
    { command: `workspace.nextTab`, title: `Next Tab`, keybinding: `Alt+PageDown`, when: `tabSurface == 'workspace'`, handler: () => cycleTab(1) },
    {
        command: `workspace.previousTab`,
        title: `Previous Tab`,
        keybinding: `Alt+PageUp`,
        when: `tabSurface == 'workspace'`,
        handler: () => cycleTab(-1),
    },
    {
        command: `workspace.closeTab`,
        title: `Close Tab`,
        icon: `times`,
        keybinding: `Ctrl+Shift+X`,
        when: `tabSurface == 'workspace'`,
        handler: closeActiveTab,
    },
    {
        command: `workspace.closeOtherTabs`,
        title: `Close Other Tabs`,
        icon: `times`,
        keybinding: `Ctrl+Shift+,`,
        when: `tabSurface == 'workspace'`,
        handler: closeOtherTabs,
    },
    {
        command: `workspace.closeTabsToRight`,
        title: `Close Tabs to the Right`,
        icon: `times`,
        keybinding: `Ctrl+Shift+.`,
        when: `tabSurface == 'workspace'`,
        handler: closeTabsToRight,
    },
    {
        command: `workspace.closeAllTabs`,
        title: `Close All Tabs`,
        icon: `times`,
        keybinding: `Ctrl+Shift+Backspace`,
        when: `tabSurface == 'workspace'`,
        handler: closeAllTabs,
    },
    // The close family's undo. VSCode puts it on Ctrl+Shift+T, which is the one chord a browser will never hand
    // over: it reopens the BROWSER's closed tab and, like Ctrl+W, isn't cancellable, so this takes
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
        when: `tabSurface == 'workspace'`,
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
    const offer = dragOffer(event);
    if (!offer.files && !offer.rows) {
        return;
    }
    dragDepth += 1;
    rootDragging.value = true;
    externalDrag.value = offer.files;
};
const onRootDragLeave = (): void => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
        resetRootDrag();
    }
};
const onRootDrop = (event: DragEvent): void => {
    const offer = dragOffer(event);
    resetRootDrag();
    if (event.dataTransfer === null) {
        return;
    }
    const dataTransfer = event.dataTransfer;
    // Tree rows dragged in from within the explorer (one or a multi-selection, newline-joined) → move to root;
    // otherwise OS files → upload to root. A drag that started in this document is neither: the outer @drop.prevent
    // still swallows it so the browser doesn't navigate away to the image, and nothing is written.
    const internal = dataTransfer.getData(`application/x-intentic-path`);
    if (internal !== ``) {
        void run(() => moveIntoMany(internal.split(`\n`), ``), `Couldn't move those files.`);
        return;
    }
    if (!offer.files) {
        return;
    }
    // enqueueFromDataTransfer runs the capture synchronously (webkitGetAsEntry must fire while the drop's items are
    // alive) and shows the "scanning" panel instantly, before the walk finishes.
    enqueueFromDataTransfer(``, dataTransfer);
};
// A row-targeted drop calls stopPropagation (so it doesn't also upload to root), so the aside never sees that
// drop to clear its hint. Reset from the window in the CAPTURE phase: it runs before any stopPropagation, so
// the drop hint can never stick on. (Ctrl+` and the terminal panel itself live in the shell: sandbox-global.)
onMounted(() => {
    unwatchDragSource = watchDragSource();
    // The pane's own width, which is what decides whether two panes fit in it and how far their seam may travel
    // (the window's width is not it: the rail and the chat column have already taken their share).
    bodyObserver = new ResizeObserver((entries) => {
        bodyWidth.value = entries[0]?.contentRect.width ?? 0;
    });
    if (workspaceBody.value !== undefined) {
        bodyObserver.observe(workspaceBody.value);
    }
    window.addEventListener(`drop`, resetRootDrag, true);
    window.addEventListener(`dragend`, resetRootDrag, true);
    // Load Monaco (+ Shiki bridge) while the user browses the tree, so the first file open isn't cold.
    void useMonaco().ensureMonaco();
    workspaceCommandDisposables = WORKSPACE_COMMANDS.map((spec) => registerCommand({ owner: `builtin`, ...spec }));
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
// The auto-hidden state says WHY as well as what, because the reader did not close this panel and should not
// have to work out what happened to it.
const explorerTooltip = computed(() =>
    tooltipWithChord(
        autoHidden.value ? `Show explorer · hidden to make room for the split` : sidebarOpen.value ? `Hide explorer` : `Show explorer`,
        `workspace.toggleSidebar`,
    ),
);
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
    layout.setSidebarWidth(toAppPx(event.clientX - sidebarLeft));
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
        ref="rootEl"
        class="ws flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-content"
        :class="{ 'is-resizing': resizing, 'ws-scoped': workspaceAgent !== undefined }"
        @dragover.prevent
        @drop.prevent
    >
        <!-- Body: sidebar + viewer; only the leaf panes scroll. The whole body is the root drop target (sidebar
             background, viewer, and empty state all upload to /work root); a folder row captures its own drop
             (stopPropagation) so hovering a folder targets that folder instead. -->
        <div
            ref="workspaceBody"
            class="relative flex min-h-0 flex-1"
            @dragenter="onRootDragEnter"
            @dragover.prevent
            @dragleave="onRootDragLeave"
            @drop.prevent="onRootDrop"
        >
            <!-- A column while there is room for two, a drawer over the viewer once there is not (see narrowBody).
                 The drawer keeps a right-hand margin so the viewer it covers is still visibly there, and the
                 stored column width is ignored: it was chosen against a pane this one is not. -->
            <aside
                v-if="sidebarOpen"
                ref="sidebar"
                class="relative flex min-h-0 flex-col border-r border-line bg-card"
                :class="narrowBody ? `absolute inset-y-0 left-0 z-20 w-[min(20rem,85%)] shadow-xl` : `shrink-0`"
                :style="narrowBody ? undefined : { width: uiLength(layout.sidebarWidth.value) }"
            >
                <!-- Files and Changes are the primary modes; automatic restore history is deliberately quieter.
                     One column, one resize handle: review/history never steal width from the diff view in the
                     main area. The controls sit ON the sidebar they switch. -->
                <!-- `border-b border-line` because every other bar in this app has it (the main area's below,
                     the chat's tab strip, an agent's detail header) and this one did not: the class fixes the
                     HEIGHT so the line runs unbroken across the window, and the border is each bar's to draw.
                     Without it this column's bar had no bottom edge at all in the stock theme, and under a skin
                     it showed only the drop shadow meant to sit UNDER that edge — half the weight of every
                     other rule on screen, which is what made the panel's own line below look like it belonged
                     to a different design. -->
                <div class="view-header flex items-center gap-1 border-b border-line px-1.5">
                    <SegmentedControl v-model="sidebarMode" size="xs" :options="sidebarModeOptions" />
                    <span class="flex-1"></span>
                    <button
                        type="button"
                        :class="ui.iconButton(layout.sidebarPanel.value === 'history' ? 'bg-overlay text-content' : '')"
                        @click="layout.setSidebarPanel('history')"
                        v-tooltip.bottom="'Restore points: automatic file history'"
                        :aria-pressed="layout.sidebarPanel.value === 'history'"
                        aria-label="Restore points"
                    >
                        <Icon name="history" class="text-xs" />
                    </button>
                    <!-- Changes' panel-wide actions ride the switch's row rather than a header row of their own:
                         the switch's "Changes" tab already titles the panel and carries its count, so a second
                         line below it spent height restating both before a single file was named. -->
                    <template v-if="layout.sidebarPanel.value === 'changes'">
                        <!-- How the list underneath READS: biggest changes first, or git's path order. Here
                             rather than in the panel for the same reason Refresh is: the panel deliberately has
                             no header row of its own, and this row is already titled "Changes". -->
                        <ChangeOrderButton />
                        <button
                            type="button"
                            :class="ui.iconButton()"
                            @click="changes.refresh()"
                            v-tooltip.bottom="'Refresh'"
                            aria-label="Refresh changes"
                            :disabled="changes.actionBusy.value || changes.loading.value"
                        >
                            <Icon name="refresh" class="text-xs" :spin="changes.loading.value || changes.actionBusy.value" />
                        </button>
                    </template>
                </div>
                <ReviewPanel v-if="layout.sidebarPanel.value === 'changes'" @open-diff="openDiff" @fill-diff="fillDiff" />
                <HistoryPanel v-else-if="layout.sidebarPanel.value === 'history'" @open-diff="openDiff" @fill-diff="fillDiff" />
                <!-- Search header: input hero on row 1; the files-to-include field under it while a content search
                     is on; scope switch + the filter funnel on the last row. One `filter` ref, three scopes
                     (name = instant client-side tree filter, text/smart = debounced daemon search).
                     The leading icon doubles as the content-search spinner; the ✕ (and Esc) clear text AND snap scope
                     back to name. The Aa/ab/.* switches sit INSIDE the field, where every editor puts them, and only
                     in the text scope: they change what the pattern means, and the other scopes have no pattern. -->
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
                            class="ui-field-box ui-field-sm w-full min-w-0 pl-7"
                            :class="textMode ? `pr-[4.75rem]` : `pr-7`"
                            @keydown.esc="clearFilter"
                        />
                        <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                            <!-- Aa / ab / .*: the same three switches, in the same order, as the editor this
                                 panel is modelled on. Glyphs, not icons: they ARE the notation. `mousedown` is
                                 suppressed so a press leaves the caret in the field it sits inside: the query is
                                 half typed and the next keystroke belongs to it. The click still fires, so
                                 keyboard activation is untouched. -->
                            <template v-if="textMode">
                                <button
                                    v-for="toggle in MATCH_TOGGLES"
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
                                v-tooltip.bottom="'Clear (Esc)'"
                                aria-label="Clear filter"
                                @click="clearFilter"
                            >
                                <Icon name="times" />
                            </button>
                        </div>
                    </div>
                    <!-- Which files the search is asked of, in VSCode's files-to-include grammar. Its own field
                         under the query rather than another switch beside it: a glob is typed, not toggled, and
                         seeing `*.test.ts` sitting there is what keeps a narrowed search from reading as an empty
                         workspace. Only under a content search: the Name scope already matches paths. -->
                    <div v-if="contentMode" class="relative">
                        <Icon
                            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                            aria-hidden="true"
                            name="folder"
                        />
                        <input
                            v-model="search.include.value"
                            type="text"
                            placeholder="Files to include, e.g. package.json"
                            class="ui-field-box ui-field-sm w-full min-w-0 pr-2 pl-7"
                            aria-label="Files to include"
                            v-tooltip.bottom="
                                'Files to include, comma-separated: a name (package.json, src) matches anywhere, ./ anchors it to the workspace root, and ! excludes'
                            "
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
                        <!-- What this list leaves out. Dark is the default set (the project alone: node_modules,
                             dist and .turbo out of the way, specs where their sources are); lit says a switch is
                             on, and the menu says which. -->
                        <button
                            type="button"
                            class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 transition-colors"
                            :class="filtersActive ? 'bg-primary-600/15 text-link' : 'text-muted hover:text-content'"
                            aria-haspopup="menu"
                            aria-label="Filter what the explorer lists"
                            v-tooltip.bottom="lensLine ?? 'Filter'"
                            @click="filterMenu?.show($event)"
                        >
                            <Icon name="filter" class="text-xs" />
                        </button>
                        <!-- The root repo's codebase health. Root IS a repo (ensureRootRepo versions the whole
                             workspace), but the tree draws no row for it, so this affordance can't ride a row the
                             way a nested repo's does: it belongs on the explorer's own root-scoped toolbar. Not
                             tree-scoped like Collapse All, so it stays in both search scopes. Root's git history
                             is reached the equivalent way, from the palette: see ext-git-history's command. -->
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
                            :class="ui.iconButton(`h-auto w-auto shrink-0 rounded-md px-1.5 py-0.5 hover:bg-transparent`)"
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
                <!-- Bottom padding belongs to the TREE, not this scrollport: the explorer's empty-folder line
                     pins itself to the bottom, and a scrollport that reserved space below it would leave a
                     sliver of scrolled rows showing under the pinned line. -->
                <div v-else-if="layout.sidebarPanel.value === 'files'" class="scrollbar-thin min-h-0 flex-1 overflow-auto pt-1">
                    <WorkspaceTree
                        :tree="tree"
                        :root-hidden="rootHidden"
                        :filter="filter"
                        :selected-path="openPath"
                        :manageable-dirs="manageableDirs"
                        :row-actions="rowActions"
                        @open-file="openFile"
                        @open-directory="openDirectory"
                    />
                </div>
                <!-- No seam on the drawer: its width is the pane's to decide, not the reader's to drag. -->
                <div
                    v-if="!narrowBody"
                    class="ws-resize"
                    @pointerdown="startResize"
                    @pointermove="onResize"
                    @pointerup="endResize"
                    @dblclick="layout.resetSidebarWidth()"
                    title="Drag to resize · double-click to reset"
                ></div>
                <!-- Root drop hint over the whole panel (files mode only: review/history aren't drop targets);
                     pointer-events-none so drops still reach the rows/aside. -->
                <div v-if="rootDragging && layout.sidebarPanel.value === 'files'" class="ws-dropzone pointer-events-none absolute inset-1 z-10"></div>
            </aside>

            <!-- Dismisses the drawer by clicking the file it is covering: the way every drawer works, and the
                 only affordance the toggle button does not already provide. -->
            <div v-if="narrowBody && sidebarOpen" class="absolute inset-0 z-10 bg-black/30" @click="drawerOpen = false"></div>

            <!-- THE EDITOR: one pane, or two with a seam between them (see EditorStrip). The panes are alike,
                 so they are one component rendered twice; what belongs to the WORKSPACE rather than to a pane,
                 the explorer toggle on the left, the tree's status and the scope chip on the right, is handed
                 to the main pane's bar as slots. -->
            <div class="relative flex min-h-0 min-w-0 flex-1">
                <EditorPane
                    pane="main"
                    :broken="scopeBroken"
                    :empty="!isLoading && tree.length === 0"
                    @select="selectTab"
                    @keep="keepTab"
                    @close="closeTab"
                    @contextmenu="openTabMenu"
                    @pick="fileInput?.click()"
                >
                    <template #lead>
                        <!-- The explorer's one control, and, while a split has stood the explorer aside, the one
                             thing on screen that says so: a dot, pulsing once as it happens. Without it a panel
                             that vanished on its own is indistinguishable from one that broke. -->
                        <button
                            type="button"
                            :class="ui.iconButton(`relative mx-1 h-7 w-7 self-center`)"
                            @click="toggleSidebar()"
                            v-tooltip.bottom="explorerTooltip"
                            aria-label="Toggle explorer"
                        >
                            <Icon name="bars" class="text-sm" />
                            <span v-if="autoHidden" class="ws-stashed" :class="{ 'ws-stashed-new': justHidden }" aria-hidden="true"></span>
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
                            <!-- The lone remaining status: one spinner for both a running file action and a tree
                                 (re)load: the Refresh button that used to spin is now only the command. -->
                            <Icon name="spinner" v-if="busy || isLoading" class="text-sm text-muted" spin aria-label="Working" />
                            <!-- Suppressed while the scope is what failed: the pane below is already saying it at
                                 full size, and the same sentence twice on one screen reads as two problems. -->
                            <span v-if="error && !scopeBroken" class="max-w-64 truncate text-2xs text-danger" v-tooltip.bottom.overflow="error">{{
                                error
                            }}</span>
                            <!-- Which copy of the workspace all of the above is about. Absent on the shared tree:
                                 the default needs no marker (see WorkspaceScopeChip). -->
                            <WorkspaceScopeChip />
                            <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                        </div>
                    </template>
                </EditorPane>
                <!-- The seam sizes the COMPANION, so it is dragged left to make the diff bigger; double-click
                     puts it back to the width the split opens at. -->
                <ResizeSeam
                    v-if="splitOpen && !scopeBroken"
                    v-model="seamWidth"
                    pane="after"
                    :min="toScreenPx(MIN_PANE_PX)"
                    :max="toScreenPx(maxSideWidth)"
                    :reset="toScreenPx(DEFAULT_SIDE_PANE_WIDTH)"
                />
                <div v-if="splitOpen && !scopeBroken" class="flex min-h-0 shrink-0 flex-col border-l border-line" :style="{ width: uiLength(sideWidth) }">
                    <EditorPane pane="side" @select="selectTab" @keep="keepTab" @close="closeTab" @contextmenu="openTabMenu" />
                </div>
                <!-- Drop-to-root hint over the editor, shown only for external file drags (an internal move is
                     guided by the row rings instead). pointer-events-none so the drop still reaches the body. -->
                <div
                    v-if="rootDragging && externalDrag"
                    class="ws-dropzone pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 text-primary-500"
                >
                    <Icon name="upload" class="text-2xl" />
                    <span class="text-xs font-medium">Drop files to add to workspace root</span>
                </div>
            </div>
        </div>

        <!-- Bottom terminal panel. v-if unmounts it when closed, but the tabs live in a module-level Map in
             useTerminal (each a tmux session): detach only removes the host element, so the shells and scrollback
             survive close, navigation, and page reload. -->

        <!-- Right-click tab menu + the confirm shown before a bulk close discards unsaved edits. -->
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :min-width="13" />
        <!-- The explorer toolbar's funnel, opened by a left click on it rather than by a right click on a row. -->
        <ContextMenu ref="filterMenu" :model="filterMenuItems" :min-width="11" />
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
        <!-- Opened by a directory row's person icon: who works in that folder, and the one field it takes to add
             somebody. Mounted here rather than in the tree because the tree draws icons and knows nothing about
             what they mean. -->
        <DirectoryPersonas v-model="personaDir" />
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
/* `.ws-scoped` (the tint that says this is not the shared tree) lives in styles.css beside .view-header: it has
 * to reach the bars inside child components, and the phone's workspace wears the same one. */

/* (The context seat's own rule travels with the markup, in EditorPane: there are two of those seats now.) */

/* SOMETHING OF YOURS IS PUT AWAY HERE. The dot on the explorer toggle while a split has the tree stood aside:
 * six pixels, the accent colour, on the control that brings it back, which is the only place it can be read as
 * an instruction rather than as an alert.
 *
 * It PULSES ONCE, at the moment of hiding, and then stops. A panel that disappears while the reader is looking
 * at the file they just opened is a change nobody sees happen, and a badge that keeps pulsing for as long as the
 * state lasts is a thing people learn to ignore. The ring is a separate element scaling out from under the dot,
 * so the dot itself never moves. `prefers-reduced-motion` keeps the dot and drops the ring: the information is
 * in the dot, the animation is only what draws the eye to it. */
.ws-stashed {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--color-primary-500);
}
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
/* Root drop-zone hint (a folder row shows its own inset ring instead). */
.ws-dropzone {
    border: 2px dashed color-mix(in srgb, var(--color-primary-500) 60%, transparent);
    background: color-mix(in srgb, var(--color-primary-500) 6%, transparent);
    border-radius: 0.375rem;
}
</style>
