<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { BottomSheet, clipboardOf, ConfirmDialog, Modal, type NoticeModel, NoticeStack, PullToRefresh, SegmentedControl } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLoadingReveal } from "@intentic/ui";
import { type SidebarPanel, useLayout } from "../../composables/useLayout";
import { reportOpenPath } from "../../composables/usePresence";
import { outgoingMark, outgoingSummary } from "../../composables/workspace/outgoingWork";
import { useDiffStat } from "../../composables/workspace/useDiffStat";
import { useChanges } from "../../composables/workspace/useChanges";
import { useMonaco } from "../../composables/workspace/useMonaco";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { MATCH_TOGGLES, useSearchOptions } from "../../composables/workspace/useSearchOptions";
import { useWorkspaceRoute } from "../../composables/workspace/useWorkspaceRoute";
import { type SearchScope, useWorkspaceSearch } from "../../composables/workspace/useWorkspaceSearch";
import { useWorkspaceTabs } from "../../composables/workspace/useWorkspaceTabs";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { useReceipts } from "../../composables/receipts";
import BinaryDiffView from "./viewers/BinaryDiffView.vue";
import DiffToolbar from "./viewers/DiffToolbar.vue";
import DiffSkeleton from "./viewers/DiffSkeleton.vue";
import DiffView from "./viewers/DiffView.vue";
import { rendersAsBytes } from "./fileType";
import type { DiffPayload } from "@intentic/extension-api";
import type { OpenMode } from "./workspaceTabs";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { filesToEntries } from "./dropEntries";
import { explorerShows } from "./explorerFilter";
import { iconForEntry } from "@intentic/ui";
import FileViewer from "./viewers/FileViewer.vue";
import HistoryPanel from "./HistoryPanel.vue";
import ReviewPanel from "./ReviewPanel.vue";
import UploadProgress from "./UploadProgress.vue";
import WorkspaceScopeBanner from "./WorkspaceScopeBanner.vue";
import WorkspaceSearchResults from "./WorkspaceSearchResults.vue";
import { parentDir } from "@intentic/ui/path";

/* The mobile Workspace: a drill-down file browser — one directory per screen — plus the Changes / Restore Points
 * panels, with a full-screen read-only viewer. All navigation state (segment aside) lives in the ROUTE
 * (`?dir=`, `?file=`, `?diff=`), so the OS back gesture is the up/close navigation and deep links work.
 * Desktop affordances (drag-drop, multi-select, tab strip, edit mode) have no mobile equivalents: uploads go
 * through a picker FAB, row actions through a long-press bottom sheet, and files open read-only — editing
 * happens through the agent in chat or on desktop. Same singletons as WorkspaceDesktop underneath. */

const route = useRoute();
const router = useRouter();
const layout = useLayout();
const changes = useChanges();
const {
    tree,
    rootHidden,
    entriesByPath,
    entry,
    error,
    isLoading,
    refetch,
    readBlob,
    moveEntry,
    removeEntries,
    run,
    busy,
    actionError,
    loadChildren,
    lazyChildren,
    lazyHidden,
    lazyLoading,
} = useWorkspaceTree();
// The tree query reports a raw message; this view knows the user was trying to see their files.
const treeNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't load your files.`, detail: error.value },
);
const { files: uploadFiles, scanning: uploadScanning, skippedNotice: uploadSkipped, enqueue } = useUploadQueue();
const { say } = useReceipts();
// The open file lives in the URL path (`/workspace/<path>`), synced to the tabs singleton by useWorkspaceRoute;
// this component keeps only the mobile-specific query state (`?dir=` browse location, `?diff=` diff view).
const { tabs, activeId, activeTab, openLine, openFile, openAtLine, openDiff, fillDiff } = useWorkspaceTabs();
useWorkspaceRoute();

// --- Route-driven navigation -------------------------------------------------------------------
const dir = computed(() => (typeof route.query[`dir`] === `string` ? route.query[`dir`] : ``));
const openPath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
const diffId = computed(() => (typeof route.query[`diff`] === `string` ? route.query[`diff`] : undefined));

const openDir = (path: string): void => {
    // Browsing a folder leaves any open file — clear the path segment along with the query.
    void router.push({ name: `workspace`, params: { path: [] }, query: path === `` ? {} : { dir: path } });
};
const openDiffNav = (payload: DiffPayload, mode: OpenMode): void => {
    openDiff(payload, mode);
    void router.push({ name: `workspace`, params: { path: [] }, query: { ...route.query, diff: activeId.value ?? undefined } });
};

// A diff is content held in the tabs singleton, not addressable state — a reload lands with `?diff=` and no
// tab to show, so drop the param instead of painting an empty pane.
const diffTab = computed(() => {
    const tab = tabs.value.find((candidate) => candidate.id === diffId.value);
    return tab?.kind === `diff` ? tab : undefined;
});
// What the open diff is showing once its comments are out, for the bar above it — see useDiffStat.
const { stat: diffStat, onStat: setDiffStat } = useDiffStat(diffId);
watch(
    [diffId, diffTab],
    ([id, tab]) => {
        if (id !== undefined && tab === undefined) {
            void router.replace({ query: { ...route.query, diff: undefined } });
        }
    },
    { immediate: true },
);

// The gap between clicking a changed file and its content arriving — see the desktop workspace for why it is
// gated rather than drawn at once.
const diffOutline = useLoadingReveal(
    computed(() => diffTab.value?.pending === true),
    computed(() => diffTab.value?.id ?? ``),
);

// Presence: announce which file this tab has open, like the desktop workspace does.
watch(openPath, (path) => reportOpenPath(path), { immediate: true });
onBeforeUnmount(() => reportOpenPath(undefined));
// Load Monaco (+ Shiki bridge) up front so the first file open isn't cold.
onMounted(() => void useMonaco().ensureMonaco());

const openMeta = computed(() => entry(openPath.value));
const fileName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// --- The current directory's listing -----------------------------------------------------------
/* WHICH PANEL IS SHOWING IS PART OF THE ADDRESS, like `?dir=` and `?diff=` above it. It used to be the
 * persisted preference alone, which cost two things a phone cannot afford: the tab bar had no way to send
 * anybody to Changes (so its Review tab fell back to the same bare `/workspace` the Files tab already owned,
 * and both lit up at once), and the OS back gesture walked past a segment switch as if it had not happened.
 *
 * Still WRITTEN to the persisted preference, so the choice survives to the next visit and desktop keeps
 * reading one setting — the query is the address of this visit, not a second source of truth. */
const PANELS = [`files`, `changes`, `history`] as const;
const segment = computed<SidebarPanel>({
    get: () => {
        const asked = route.query[`panel`];
        return typeof asked === `string` && PANELS.includes(asked as SidebarPanel) ? (asked as SidebarPanel) : layout.sidebarPanel.value;
    },
    set: (value) => {
        layout.setSidebarPanel(value);
        // `files` is the bare address — a query naming the default would show up in every shared link.
        void router.replace({ query: { ...route.query, panel: value === `files` ? undefined : value } });
    },
});
// The Changes tab's chip, on the desktop explorer's terms (WorkspaceDesktop documents the gating): the count
// while there is work to review, then the outgoing mark, so a clean tree with commits still to push does not
// read as an empty tab.
const changesMark = computed(() => {
    const work = changes.outgoing.value;
    return changes.count.value > 0 || work === undefined ? {} : { mark: outgoingMark(work), markTitle: outgoingSummary(work) };
});
const segmentOptions = computed(() => [
    // Files and Changes are the everyday views; restore history is the quieter icon beside this control. Touch
    // has no hover, so no hint here says anything a finger can reach — see the desktop twin. The mark spread
    // stays: `markTitle` is inert on this form factor, but the CHIP is what the tab is here for.
    { label: `Files`, value: `files` as const },
    { label: `Changes`, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
]);

const filter = ref(``);
/* Same three scopes as the desktop explorer (WorkspaceDesktop.vue documents what each one means), and the same
 * match switches — they are PERSISTED and shared, so a phone that applied them without showing them was running
 * a regex search the reader had no way to see, let alone turn off. Their own row rather than inside the field:
 * there is vertical room here and none beside a 16px input, and a row is a touch target. */
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

const clearFilter = (): void => {
    filter.value = ``;
    searchScope.value = `name`;
};

// Entering a dir the walk left unlisted (ignored, or below its entry budget) — or any path not in the eager
// tree at all (deep inside a lazy subtree) — fetches its children on demand; the listing repaints on arrival.
watch(
    dir,
    (path) => {
        if (path === ``) {
            return;
        }
        const node = entriesByPath.value.get(path);
        if (node === undefined || node.children === undefined) {
            void loadChildren(path);
        }
    },
    { immediate: true },
);
const listing = computed<readonly WorkspaceTreeEntry[]>(() => {
    // A walked dir carries its children inline; an unlisted one's arrive via loadChildren (keyed by path).
    const children = dir.value === `` ? tree.value : (entriesByPath.value.get(dir.value)?.children ?? lazyChildren.value.get(dir.value) ?? []);
    // The explorer's filter switches are shared with desktop (one browser, one set of preferences), so a phone
    // drilling into a folder shows the same set of entries the tree would.
    const shown = children.filter((node) => explorerShows(node, layout.showIgnored.value, layout.hideTests.value));
    const query = filter.value.trim().toLowerCase();
    return query === `` ? shown : shown.filter((node) => node.name.toLowerCase().includes(query));
});
const dirLoading = computed(() => dir.value !== `` && lazyLoading.value.has(dir.value));
// How many entries the daemon's cap cut from the open dir's listing — 0 (the common case) shows nothing.
const dirHidden = computed(() => (dir.value === `` ? rootHidden.value : (lazyHidden.value.get(dir.value) ?? 0)));

// The toolbar funnel's sheet — the desktop filter menu's two rows, thumb-sized. Stays open across a tap: both
// switches repaint the listing behind it, so the answer to "did that do what I wanted" is already on screen.
const filterSheet = ref(false);

// A symlink that goes nowhere, or that leaves the workspace: dimmed, and it offers no drill-in — there is
// nothing behind it the sandbox will list.
const deadLink = (node: WorkspaceTreeEntry): boolean => node.link?.state !== undefined;

// --- Long-press row actions (the ContextMenu equivalents) --------------------------------------
// This view's root — the element a clipboard write is reached through, so it lands in the window the user is
// looking at rather than the opener's (see clipboardOf).
const rootEl = ref<HTMLElement>();
const sheetEntry = ref<WorkspaceTreeEntry | undefined>(undefined);
const renameTarget = ref<WorkspaceTreeEntry | undefined>(undefined);
const renameValue = ref(``);
const deleteTarget = ref<WorkspaceTreeEntry | undefined>(undefined);

const startRename = (target: WorkspaceTreeEntry): void => {
    sheetEntry.value = undefined;
    renameValue.value = target.name;
    renameTarget.value = target;
};
const confirmRename = (): void => {
    const target = renameTarget.value;
    renameTarget.value = undefined;
    const name = renameValue.value.trim();
    if (target === undefined || name === `` || name === target.name) {
        return;
    }
    const parent = parentDir(target.path);
    void run(() => moveEntry(target.path, parent === `` ? name : `${parent}/${name}`), `Couldn't rename that.`);
};
const confirmDelete = (): void => {
    const target = deleteTarget.value;
    deleteTarget.value = undefined;
    if (target !== undefined) {
        void run(() => removeEntries([target.path]), `Couldn't delete that.`);
    }
};
const copyPath = (target: WorkspaceTreeEntry): void => {
    sheetEntry.value = undefined;
    // Reached through this view's root so a popped-out panel writes to the focused window (see clipboardOf).
    // Clipboard may still be unavailable (insecure context) — swallow, matching CopyButton.
    void clipboardOf(rootEl.value)
        .writeText(target.path)
        .then(() => say(`Path copied`))
        .catch(() => undefined);
};
const download = (target: WorkspaceTreeEntry): void => {
    sheetEntry.value = undefined;
    void run(async () => {
        const blob = await readBlob(target.path);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement(`a`);
        anchor.href = url;
        anchor.download = target.name;
        anchor.click();
        URL.revokeObjectURL(url);
    }, `Couldn't download that file.`);
};

// --- Upload (the drag-drop replacement): a picker FAB targeting the current directory ----------
const fileInput = ref<HTMLInputElement>();
const onPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.files !== null && input.files.length > 0) {
        void enqueue(dir.value, filesToEntries(input.files));
    }
    input.value = ``;
};
</script>

<template>
    <div ref="rootEl" class="relative flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Whose copy of the workspace this is, whenever it isn't the shared one (see WorkspaceScopeBanner).
             Above the viewer as well as the list: a phone shows one at a time, and both need the answer. -->
        <WorkspaceScopeBanner />
        <!-- Full-screen viewer: `?file=` (any kind) or `?diff=` (from Changes/History). Back = OS gesture. -->
        <template v-if="openPath !== undefined || diffTab !== undefined">
            <!-- A diff gets the SAME bar the desktop tab and the agent review get, with the phone's back arrow
                 in its lead slot — one bar, not the generic header plus a second one. It already names the
                 file and marks its status, so the "diff" label this replaces had nothing left to add. -->
            <DiffToolbar
                v-if="diffTab"
                :path="diffTab.label"
                :status="diffTab.status"
                :code="diffStat"
                :additions="diffTab.additions"
                :deletions="diffTab.deletions"
                class="bg-card"
            >
                <template #lead>
                    <button
                        type="button"
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors active:bg-overlay"
                        aria-label="Back"
                        @click="router.back()"
                    >
                        <Icon name="arrow-left" class="text-lg" />
                    </button>
                </template>
            </DiffToolbar>
            <div v-else class="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-card px-1">
                <button
                    type="button"
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors active:bg-overlay"
                    aria-label="Back"
                    @click="router.back()"
                >
                    <Icon name="arrow-left" class="text-lg" />
                </button>
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ fileName(openPath ?? "") }}</span>
            </div>
            <div class="min-h-0 flex-1">
                <template v-if="diffTab">
                    <!-- Still being read. Nothing below it can be decided yet — whether the file is binary is part
                         of the answer — so this branch comes first, and the viewer mounts once, with content. -->
                    <template v-if="diffTab.pending"><DiffSkeleton v-if="diffOutline" /></template>
                    <!-- No text to diff is not the same as nothing to see: an image renders as its two sides
                         (stacked here — two panes don't fit a phone). -->
                    <BinaryDiffView
                        v-else-if="rendersAsBytes(diffTab.path, diffTab.binary)"
                        :key="diffTab.id"
                        :path="diffTab.path"
                        :before="diffTab.beforeRaw"
                        :after="diffTab.afterRaw"
                    />
                    <p v-else-if="diffTab.truncated" class="p-4 text-xs text-subtle">File too large to diff in the browser.</p>
                    <DiffView v-else :key="diffTab.id" :before="diffTab.before" :after="diffTab.after" :path="diffTab.path" @stat="setDiffStat" />
                </template>
                <FileViewer
                    v-else-if="openPath"
                    :path="openPath"
                    :meta="openMeta"
                    :line="openLine"
                    @gone="router.replace({ name: `workspace`, params: { path: [] }, query: route.query })"
                />
            </div>
        </template>

        <template v-else>
            <div class="flex shrink-0 items-center gap-2 border-b border-line bg-card px-2 py-1.5">
                <SegmentedControl v-model="segment" size="sm" :options="segmentOptions" />
                <span class="flex-1"></span>
                <button
                    type="button"
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors active:bg-overlay"
                    :class="segment === 'history' ? 'bg-overlay text-content' : 'text-muted'"
                    :aria-pressed="segment === 'history'"
                    aria-label="Restore points"
                    @click="segment = 'history'"
                >
                    <Icon name="history" class="text-base" />
                </button>
                <!-- What the listing leaves out — the desktop toolbar's funnel, thumb-sized, opening a sheet
                     instead of a menu. Drill-down only: during a content search the row under the field carries
                     its own Ignored chip, and two controls for one idea on one screen is one too many. -->
                <button
                    v-if="segment === 'files' && !contentMode"
                    type="button"
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors active:bg-overlay"
                    :class="layout.showIgnored.value || layout.hideTests.value ? 'text-link' : 'text-muted'"
                    aria-label="Filter what the explorer lists"
                    @click="filterSheet = true"
                >
                    <Icon name="filter" class="text-base" />
                </button>
                <!-- One refresh for the row, refetching whichever segment is showing — the Changes panel below
                     no longer carries a header row (and its own refresh) of its own. -->
                <button
                    type="button"
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors active:bg-overlay"
                    @click="segment === 'changes' ? changes.refresh() : refetch()"
                    aria-label="Refresh"
                    :disabled="segment === 'changes' ? changes.actionBusy.value || changes.loading.value : busy || isLoading"
                >
                    <Icon
                        name="refresh"
                        class="text-base"
                        :spin="segment === 'changes' ? changes.loading.value || changes.actionBusy.value : isLoading || busy"
                    />
                </button>
            </div>
            <NoticeStack :of="[actionError, treeNotice]" class="shrink-0 px-3 py-1.5" />

            <ReviewPanel v-if="segment === 'changes'" @open-diff="openDiffNav" @fill-diff="fillDiff" />
            <HistoryPanel v-else-if="segment === 'history'" @open-diff="openDiffNav" @fill-diff="fillDiff" />

            <template v-else>
                <!-- Search: name filters the current directory instantly; content searches the daemon. -->
                <div class="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
                    <div class="relative min-w-0 flex-1">
                        <Icon
                            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                            aria-hidden="true"
                            :name="contentMode && (searching || searchPending) ? `spinner` : `search`"
                            :spin="contentMode && (searching || searchPending)"
                        />
                        <input
                            v-model="filter"
                            type="search"
                            :placeholder="contentMode ? `Search in files…` : `Filter…`"
                            class="h-10 w-full min-w-0 rounded-lg border border-line bg-canvas pl-8 pr-3 text-base text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                            @keydown.esc="clearFilter"
                        />
                    </div>
                    <SegmentedControl
                        v-model="searchScope"
                        size="xs"
                        :options="[
                            { label: `Name`, value: `name` },
                            { label: `Text`, value: `text` },
                            { label: `Smart`, value: `smart` },
                        ]"
                    />
                </div>
                <!-- Which files to ask, VSCode's files-to-include grammar — the desktop field's twin, full width
                     because a glob is typed and a phone's row is the only place with room for it. -->
                <div v-if="contentMode" class="shrink-0 px-2 pb-1.5">
                    <div class="relative">
                        <Icon
                            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                            aria-hidden="true"
                            name="folder"
                        />
                        <input
                            v-model="search.include.value"
                            type="search"
                            placeholder="Files to include, e.g. package.json"
                            aria-label="Files to include"
                            class="h-10 w-full min-w-0 rounded-lg border border-line bg-canvas pl-8 pr-3 text-base text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                        />
                    </div>
                </div>
                <!-- Aa / ab / .* + Ignored — the same switches the desktop field carries, and the same rule for
                     which scope sees which: the three change what a PATTERN means, Ignored changes what is
                     searched at all. -->
                <div v-if="contentMode" class="flex shrink-0 items-center gap-1.5 px-2 pb-1.5">
                    <template v-if="textMode">
                        <button
                            v-for="toggle in MATCH_TOGGLES"
                            :key="toggle.label"
                            type="button"
                            class="flex h-8 w-9 items-center justify-center rounded-lg font-mono text-xs leading-none text-muted transition-colors active:bg-overlay"
                            :class="{ 'bg-primary-600/20 text-link': toggle.state.value }"
                            :aria-pressed="toggle.state.value"
                            :aria-label="toggle.title"
                            @click="toggle.state.value = !toggle.state.value"
                        >
                            {{ toggle.label }}
                        </button>
                    </template>
                    <span class="flex-1"></span>
                    <button
                        type="button"
                        class="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-2xs font-medium text-muted transition-colors active:bg-overlay"
                        :class="{ 'bg-primary-600/15 text-link': search.includeIgnored.value }"
                        :aria-pressed="search.includeIgnored.value"
                        @click="search.includeIgnored.value = !search.includeIgnored.value"
                    >
                        <Icon :name="search.includeIgnored.value ? `eye` : `eye-slash`" class="text-2xs" />
                        Ignored
                    </button>
                </div>

                <!-- Drill-down header: where we are + one-tap up. The OS back gesture also goes up (history). -->
                <div v-if="dir !== '' && !contentMode" class="flex h-11 shrink-0 items-center gap-1 border-b border-line px-1">
                    <button
                        type="button"
                        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors active:bg-overlay"
                        aria-label="Up one directory"
                        @click="openDir(parentDir(dir))"
                    >
                        <Icon name="arrow-left" class="text-base" />
                    </button>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ dir }}</span>
                </div>

                <!-- The match list scrolls itself (it virtualizes against its own viewport) and pulling on it
                     would refetch the directory tree, which is not what it shows. The directory listing keeps
                     pull-to-refresh. -->
                <div v-if="contentMode" class="min-h-0 flex-1">
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
                <!-- NO WRAPPER ELEMENT AROUND THESE ROWS. A `<template>` carrying no structural directive is
                     not compiled away — Vue passes it through as a real HTML `<template>`, which the browser
                     renders `display: none`. One sat here, and it took the entire listing with it: the rows,
                     the empty state, the loading line and the elided-entry notice all had the data they
                     needed and none of them ever painted. The `v-for` belongs on the row itself. -->
                <PullToRefresh v-else :on-refresh="refetch">
                    <div class="pb-24">
                        <button
                            v-for="node in listing"
                            :key="node.path"
                            type="button"
                            class="flex min-h-12 w-full items-center gap-3 px-3 text-left transition-colors active:bg-overlay"
                            v-longpress="() => (sheetEntry = node)"
                            @click="
                                node.type === 'dir' && !isLockedWorkspacePath(node.path) && !deadLink(node) ? openDir(node.path) : openFile(node.path)
                            "
                        >
                            <!-- A row the sandbox keeps to itself: padlock, dimmed, and a tap opens the tab
                                 that explains it rather than walking into a folder with nothing in it. -->
                            <Icon
                                :name="isLockedWorkspacePath(node.path) ? 'lock' : iconForEntry(node.name, node.type)"
                                class="shrink-0 text-base"
                                :class="node.ignored || isLockedWorkspacePath(node.path) ? 'text-subtle' : 'text-muted'"
                            />
                            <span
                                class="min-w-0 flex-1 truncate text-sm"
                                :class="{ 'text-subtle': node.ignored || isLockedWorkspacePath(node.path) || node.link?.state !== undefined }"
                                >{{ node.name }}</span
                            >
                            <!-- A symlink. The row wears its TARGET's icon, so this marker is what says the
                                 name is a pointer. No hover on touch, so where it points can't be shown
                                 here — the long-press sheet is where a row explains itself. -->
                            <Icon
                                v-if="node.link !== undefined"
                                :name="node.link.state === undefined ? 'link' : 'link-broken'"
                                class="shrink-0 text-xs"
                                :class="node.link.state === undefined ? 'text-subtle' : 'text-warning'"
                            />
                            <!-- The reference shelf must not read as junk — no hover on touch, so the badge alone names it. -->
                            <span
                                v-if="node.path === REFERENCE_DIR"
                                class="shrink-0 rounded-full bg-subtle/10 px-1.5 text-2xs font-medium text-subtle"
                                >reference</span
                            >
                            <!-- The outbox: a warning, not a label — everything under it is on the internet. -->
                            <span v-if="node.path === PUBLIC_DIR" class="shrink-0 rounded-full bg-warning/10 px-1.5 text-2xs font-medium text-warning"
                                >public</span
                            >
                            <Icon
                                v-if="node.type === 'dir' && !isLockedWorkspacePath(node.path) && !deadLink(node)"
                                name="chevron-right"
                                class="shrink-0 text-xs text-subtle"
                            />
                        </button>
                        <p v-if="dirLoading && listing.length === 0" class="px-4 py-8 text-center text-xs text-subtle">Loading…</p>
                        <p v-else-if="listing.length === 0" class="px-4 py-8 text-center text-xs text-subtle">
                            {{ filter ? "No matching entries." : "This directory is empty." }}
                        </p>
                        <p v-if="dirHidden > 0" class="px-4 py-2 text-center text-2xs text-subtle">
                            {{ dirHidden.toLocaleString() }} more {{ dirHidden === 1 ? "entry" : "entries" }} in this folder — search to reach them.
                        </p>
                    </div>
                </PullToRefresh>

                <!-- Upload FAB: the picker replacement for desktop's drag-drop; lands in the open directory —
                     so it is gone while a search is showing, which has no open directory to land in and whose
                     rows it would otherwise sit on top of.

                     THE POSITIONING LIVES ON A WRAPPER, not on the button. PrimeVue's `.p-button` sets
                     `position: relative` in its own base layer, which beats the `absolute` utility — so
                     `bottom-4 right-4` were inert and the button laid out in normal flow instead, landing
                     18px off the LEFT edge of the screen at the one corner a right hand never reaches.
                     A plain positioned div can't be overridden by the button's own styling. -->
                <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                <div v-if="!contentMode" class="absolute bottom-4 right-4 z-10">
                    <Button rounded class="h-14 w-14 px-0 py-0 shadow-lg" aria-label="Upload files here" @click="fileInput?.click()">
                        <Icon name="upload" class="text-xl" />
                    </Button>
                </div>
            </template>

            <UploadProgress v-if="uploadScanning || uploadFiles.length > 0 || uploadSkipped !== undefined" />
        </template>

        <!-- The toolbar funnel's rows. A checked row draws its mark; the gutter holds the space either way, so
             the label cannot shift as the switch flips. -->
        <BottomSheet v-model="filterSheet" header="Filter">
            <div class="flex flex-col gap-0.5">
                <button
                    type="button"
                    class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                    :aria-pressed="layout.showIgnored.value"
                    @click="layout.toggleShowIgnored()"
                >
                    <span class="flex w-4 shrink-0 justify-center">
                        <Icon v-show="layout.showIgnored.value" name="check" class="text-base text-muted" />
                    </span>
                    Show ignored files
                </button>
                <button
                    type="button"
                    class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                    :aria-pressed="layout.hideTests.value"
                    @click="layout.toggleHideTests()"
                >
                    <span class="flex w-4 shrink-0 justify-center">
                        <Icon v-show="layout.hideTests.value" name="check" class="text-base text-muted" />
                    </span>
                    Hide tests
                </button>
            </div>
        </BottomSheet>

        <!-- Long-press row actions — the desktop tree's context menu, thumb-sized. -->
        <BottomSheet :model-value="sheetEntry !== undefined" @update:model-value="sheetEntry = undefined" :header="sheetEntry?.name">
            <div v-if="sheetEntry" class="flex flex-col gap-0.5">
                <button
                    type="button"
                    class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                    @click="copyPath(sheetEntry)"
                >
                    <Icon name="copy" class="text-base text-muted" /> Copy path
                </button>
                <!-- Where a link points. There is no hover on a phone, so this sheet is the only place the row
                     can say it — and it is the whole reason to tap a link in the first place. -->
                <p v-if="sheetEntry.link" class="flex min-h-12 items-start gap-3 px-3 py-3 text-sm text-muted">
                    <Icon :name="sheetEntry.link.state === undefined ? 'link' : 'link-broken'" class="mt-0.5 shrink-0 text-base text-subtle" />
                    <span class="min-w-0 break-all"
                        >Link to {{ sheetEntry.link.to }}<template v-if="sheetEntry.link.state === 'broken'"> — there is nothing there</template
                        ><template v-else-if="sheetEntry.link.state === 'outside'"> — outside the workspace, so the sandbox won't open it</template>
                    </span>
                </p>
                <!-- Everything below Copy path is something the sandbox refuses on a locked entry, so a locked
                     one is offered the explanation instead of four actions that would each fail. -->
                <p v-if="isLockedWorkspacePath(sheetEntry.path)" class="flex h-12 items-center gap-3 px-3 text-sm text-muted">
                    <Icon name="lock" class="text-base text-subtle" /> Kept private by the sandbox
                </p>
                <template v-else>
                    <button
                        v-if="sheetEntry.type === 'file'"
                        type="button"
                        class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                        @click="download(sheetEntry)"
                    >
                        <Icon name="download" class="text-base text-muted" /> Download
                    </button>
                    <button
                        type="button"
                        class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                        @click="startRename(sheetEntry)"
                    >
                        <Icon name="pencil" class="text-base text-muted" /> Rename
                    </button>
                    <button
                        type="button"
                        class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm text-danger active:bg-danger/10"
                        @click="((deleteTarget = sheetEntry), (sheetEntry = undefined))"
                    >
                        <Icon name="trash" class="text-base" /> Delete
                    </button>
                </template>
            </div>
        </BottomSheet>

        <Modal :open="renameTarget !== undefined" size="sm" header="Rename" @update:open="renameTarget = undefined">
            <input
                v-model="renameValue"
                type="text"
                class="h-11 w-full rounded-lg border border-line bg-canvas px-3 text-base text-content focus:border-line-strong focus:outline-none"
                @keydown.enter="confirmRename"
            />
            <template #footer>
                <Button label="Cancel" severity="secondary" :text="true" @click="renameTarget = undefined" />
                <Button label="Rename" autofocus @click="confirmRename" />
            </template>
        </Modal>

        <ConfirmDialog
            :open="deleteTarget !== undefined"
            header="Delete?"
            confirm-label="Delete"
            confirm-icon="trash"
            @cancel="deleteTarget = undefined"
            @confirm="confirmDelete"
        >
            <p class="text-sm text-content">
                Delete <span class="font-medium">{{ deleteTarget?.path }}</span
                >{{ deleteTarget?.type === "dir" ? " and everything inside it" : "" }}? This can't be undone.
            </p>
        </ConfirmDialog>
    </div>
</template>
