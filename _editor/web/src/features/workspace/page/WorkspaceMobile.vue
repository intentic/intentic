<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import {
    BottomSheet,
    Button,
    clipboardOf,
    ConfirmDialog,
    Modal,
    type NoticeModel,
    NoticeStack,
    PullToRefresh,
    SegmentedControl,
    useLoadingReveal,
    iconForEntry,
    ui,
} from "@intentic/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type SidebarPanel, useLayout } from "../../../shell/window/useLayout";
import { reportOpenPath } from "../../../shell/presence/usePresence";
import { outgoingMark, outgoingSummary } from "../push/outgoingWork";
import { useDiffStat } from "../changes/useDiffStat";
import { useChanges } from "../changes/useChanges";
import { useMonaco } from "../files/useMonaco";
import { useUploadQueue } from "../files/useUploadQueue";
import { useExplorerSearch } from "../search/useExplorerSearch";
import { MATCH_TOGGLES } from "../search/useSearchOptions";
import { useWorkspaceRoute } from "../health/useWorkspaceRoute";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { useNotifications } from "../../../shell/notifications/notifications";
import DiffToolbar from "../viewers/DiffToolbar.vue";
import DiffSkeleton from "../viewers/DiffSkeleton.vue";
import FileDiffPane from "../viewers/FileDiffPane.vue";
import type { DiffPayload } from "@intentic/extension-api";
import type { OpenMode } from "../tabs/workspaceTabs";
import { specialChip } from "../explorer/specialPaths";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { filesToEntries } from "../explorer/transfer/dropEntries";
import { explorerShows } from "../explorer/explorerFilter";
import FileViewer from "../viewers/FileViewer.vue";
import HistoryPanel from "../changes/HistoryPanel.vue";
import ReviewPanel from "../changes/ReviewPanel.vue";
import WorkspaceScopeChip from "../explorer/WorkspaceScopeChip.vue";
import { workspaceAgent } from "../health/workspaceScope";
import WorkspaceSearchResults from "../search/WorkspaceSearchResults.vue";
import { parentDir } from "@intentic/ui/path";

// Drill-down file browser (one directory per screen) plus Changes/Restore Points panels and a full-screen
// read-only viewer. Navigation state lives in the route (`?dir=`, `?file=`, `?diff=`), so OS back is up/close
// and deep links work. Desktop affordances (drag-drop, tab strip, edit) become a picker FAB, a long-press sheet, and
// read-only files.

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
    canEditFiles,
    loadChildren,
    lazyChildren,
    lazyHidden,
    lazyLoading,
} = useWorkspaceTree();
// The tree query reports a raw message; this view knows the user was trying to see their files.
const treeNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't load your files.`, detail: error.value },
);
const { enqueue } = useUploadQueue();
const { say } = useNotifications();
// Open file lives in the URL, synced by useWorkspaceRoute; this view keeps only its own state (dir, diff).
const { tabs, activeId, activeTab, openLine, openFile, openAtLine, openDiff, fillDiff } = useWorkspaceTabs();
useWorkspaceRoute();

// Route-driven navigation.
const dir = computed(() => (typeof route.query[`dir`] === `string` ? route.query[`dir`] : ``));
const openPath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
const diffId = computed(() => (typeof route.query[`diff`] === `string` ? route.query[`diff`] : undefined));

const openDir = (path: string): void => {
    // Browsing a folder leaves any open file; clear the path segment along with the query.
    void router.push({ name: `workspace`, params: { path: [] }, query: path === `` ? {} : { dir: path } });
};
const openDiffNav = (payload: DiffPayload, mode: OpenMode): void => {
    openDiff(payload, mode);
    void router.push({ name: `workspace`, params: { path: [] }, query: { ...route.query, diff: activeId.value ?? undefined } });
};

// A reload can leave `?diff=` with no matching tab, since a diff lives only in the tabs singleton; that case
// drops the param.
const diffTab = computed(() => {
    const tab = tabs.value.find((candidate) => candidate.id === diffId.value);
    return tab?.kind === `diff` ? tab : undefined;
});
// What the open diff shows once its comments are out, for the bar above it (see useDiffStat).
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

// The gap between clicking a changed file and its content arriving, gated rather than drawn at once.
const diffOutline = useLoadingReveal(
    computed(() => diffTab.value?.pending === true),
    computed(() => diffTab.value?.id ?? ``),
);

// Presence: announces which file this tab has open.
watch(openPath, (path) => reportOpenPath(path), { immediate: true });
onBeforeUnmount(() => reportOpenPath(undefined));
// Loads Monaco (+ Shiki bridge) up front so the first file open isn't cold.
onMounted(() => void useMonaco().ensureMonaco());

const openMeta = computed(() => entry(openPath.value));
const fileName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// The current directory's listing.
// Which panel shows is part of the address (`?panel=`), like `?dir=`/`?diff=` above it, so back and deep links
// reach it too. Still written to the persisted preference, so the choice survives to the next visit.
const PANELS = [`files`, `changes`, `history`] as const;
const segment = computed<SidebarPanel>({
    get: () => {
        const asked = route.query[`panel`];
        return typeof asked === `string` && PANELS.includes(asked as SidebarPanel) ? (asked as SidebarPanel) : layout.sidebarPanel.value;
    },
    set: (value) => {
        layout.setSidebarPanel(value);
        // `files` is the bare address: naming the default would show up in every shared link.
        void router.replace({ query: { ...route.query, panel: value === `files` ? undefined : value } });
    },
});
// The Changes tab's chip: the count while there's work to review, then the outgoing mark, so a clean tree
// with commits to push doesn't read as empty.
const changesMark = computed(() => {
    const work = changes.outgoing.value;
    return changes.count.value > 0 || work === undefined ? {} : { mark: outgoingMark(work), markTitle: outgoingSummary(work) };
});
const segmentOptions = computed(() => [
    // Touch has no hover; `markTitle` reaches the reader via the pill's accessible name (nameOf), not a tooltip.
    { label: `Files`, value: `files` as const },
    { label: `Changes`, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
]);

// Same search state as desktop; match switches get their own row here, since a row is a better touch target.
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

// Fetches an unlisted dir's children on demand (ignored, past budget, or a lazy subtree); repaints on arrival.
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
    // A walked dir carries children inline; an unlisted one's arrive via loadChildren, keyed by path.
    const children = dir.value === `` ? tree.value : (entriesByPath.value.get(dir.value)?.children ?? lazyChildren.value.get(dir.value) ?? []);
    // Filter switches are shared with desktop, so a drilled-into folder shows the same entries the tree would.
    const shown = children.filter((node) => explorerShows(node, layout.showIgnored.value, layout.hideTests.value));
    const query = filter.value.trim().toLowerCase();
    return query === `` ? shown : shown.filter((node) => node.name.toLowerCase().includes(query));
});
const dirLoading = computed(() => dir.value !== `` && lazyLoading.value.has(dir.value));
// Entries the daemon's cap cut from the open dir's listing; 0, the common case, shows nothing.
const dirHidden = computed(() => (dir.value === `` ? rootHidden.value : (lazyHidden.value.get(dir.value) ?? 0)));

// The funnel's sheet (the desktop menu's rows), thumb-sized; stays open, since both repaint the list behind it.
const filterSheet = ref(false);

// A symlink that goes nowhere or leaves the workspace: dimmed, with no drill-in, since the sandbox has nothing
// to list behind it.
const deadLink = (node: WorkspaceTreeEntry): boolean => node.link?.state !== undefined;

// Long-press row actions (the ContextMenu equivalents). `rootEl` is where a clipboard write targets the
// visible window, not the opener's.
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
    // Reached through this view's root so a floating panel writes the focused window; unavailability is swallowed.
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

// Upload (the drag-drop replacement): a picker FAB targeting the current directory.
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
    <!-- Whose copy of the workspace this is; same tint the desktop wears, a fact about the view, not the form factor. -->
    <div ref="rootEl" class="relative flex h-full min-h-0 flex-col bg-canvas text-content" :class="{ 'ws-scoped': workspaceAgent !== undefined }">
        <!-- Full-screen viewer: `?file=` (any kind) or `?diff=` (from Changes/History). Back is the OS gesture. -->
        <template v-if="openPath !== undefined || diffTab !== undefined">
            <!-- Same bar the desktop tab and agent review use, with the phone's back arrow in the lead slot. -->
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
                    <button type="button" :class="ui.iconButton(`h-11 w-11 rounded-lg active:bg-overlay`)" aria-label="Back" @click="router.back()">
                        <Icon name="arrow-left" class="text-lg" />
                    </button>
                </template>
            </DiffToolbar>
            <div v-else class="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-card px-1">
                <button type="button" :class="ui.iconButton(`h-11 w-11 rounded-lg active:bg-overlay`)" aria-label="Back" @click="router.back()">
                    <Icon name="arrow-left" class="text-lg" />
                </button>
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ fileName(openPath ?? "") }}</span>
                <WorkspaceScopeChip />
            </div>
            <div class="min-h-0 flex-1">
                <template v-if="diffTab">
                    <!-- Still being read; whether the file is binary is part of the answer, so the viewer mounts once, with content. -->
                    <template v-if="diffTab.pending"><DiffSkeleton v-if="diffOutline" /></template>
                    <!-- Bytes, a patch, or two sides: FileDiffPane decides, as on desktop; an image stacks its sides on a phone. -->
                    <FileDiffPane
                        v-else
                        :key="diffTab.id"
                        :path="diffTab.path"
                        :before="diffTab.before"
                        :after="diffTab.after"
                        :binary="diffTab.binary"
                        :partial="diffTab.partial"
                        :before-raw="diffTab.beforeRaw"
                        :after-raw="diffTab.afterRaw"
                        @stat="setDiffStat"
                    />
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
                <WorkspaceScopeChip />
                <button
                    type="button"
                    :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`, segment === `history` ? `bg-overlay text-content` : ``)"
                    :aria-pressed="segment === 'history'"
                    aria-label="Restore points"
                    @click="segment = 'history'"
                >
                    <Icon name="history" class="text-base" />
                </button>
                <!-- The desktop funnel, thumb-sized, as a sheet not a menu; drill-down only, content search has its own chip. -->
                <button
                    v-if="segment === 'files' && !contentMode"
                    type="button"
                    :class="
                        ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`, layout.showIgnored.value || layout.hideTests.value ? `text-link` : ``)
                    "
                    aria-label="Filter what the explorer lists"
                    @click="filterSheet = true"
                >
                    <Icon name="filter" class="text-base" />
                </button>
                <!-- One refresh for the row, refetching whichever segment shows; Changes no longer carries its own header row. -->
                <button
                    type="button"
                    :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`)"
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
                            class="ui-field-box w-full min-w-0 pl-8 pr-3"
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
                <!-- Files-to-include glob (VSCode grammar), the desktop field's twin, full width: a phone row is the only room. -->
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
                            class="ui-field-box w-full min-w-0 pl-8 pr-3"
                        />
                    </div>
                </div>
                <!-- Same switches as the desktop field: the three change what a pattern means, Ignored changes what's searched. -->
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
                        class="ui-chip h-8 shrink-0 gap-1 px-2 font-medium"
                        :class="search.includeIgnored.value ? `ui-chip-on` : ``"
                        :aria-pressed="search.includeIgnored.value"
                        @click="search.includeIgnored.value = !search.includeIgnored.value"
                    >
                        <Icon :name="search.includeIgnored.value ? `eye` : `eye-slash`" class="text-2xs" />
                        Ignored
                    </button>
                </div>

                <!-- Drill-down header: where we are, plus one-tap up; the OS back gesture also goes up. -->
                <div v-if="dir !== '' && !contentMode" class="flex h-11 shrink-0 items-center gap-1 border-b border-line px-1">
                    <button
                        type="button"
                        :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`)"
                        aria-label="Up one directory"
                        @click="openDir(parentDir(dir))"
                    >
                        <Icon name="arrow-left" class="text-base" />
                    </button>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ dir }}</span>
                </div>

                <!-- The match list scrolls itself; pulling it would refetch the tree, so pull-to-refresh stays on the listing. -->
                <!-- `open-match` reports peek vs keep; this view drops it, since there's no tab strip here to hold or promote a peek. -->
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
                        @open-match="(path, line) => openAtLine(path, line)"
                        @load-more="searchLoadMore"
                    />
                </div>
                <!--
                    No wrapper element around these rows: a bare `<template>` (no v-for/v-if) compiles to a real HTML element
                    the browser hides entirely. `v-for` belongs on the row itself.
                -->
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
                            <!-- A row the sandbox keeps to itself: padlock, dimmed; a tap opens the explanatory tab instead of an empty folder. -->
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
                            <!-- A symlink wears its target's icon; this marker shows it's a pointer. No hover, so the sheet says where. -->
                            <Icon
                                v-if="node.link !== undefined"
                                :name="node.link.state === undefined ? 'link' : 'link-broken'"
                                class="shrink-0 text-xs"
                                :class="node.link.state === undefined ? 'text-subtle' : 'text-warning'"
                            />
                            <!-- What the sandbox does with this entry (specialPaths.ts). No hover on touch, so the chip alone names it. -->
                            <span
                                v-if="specialChip(node.path)"
                                class="ui-status-pill shrink-0 text-2xs font-medium"
                                :class="specialChip(node.path)?.tone === 'warning' ? 'bg-warning/10 text-warning' : 'bg-subtle/10 text-subtle'"
                                >{{ specialChip(node.path)?.label }}</span
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
                            {{ dirHidden.toLocaleString() }} more {{ dirHidden === 1 ? "entry" : "entries" }} in this folder, search to reach them.
                        </p>
                    </div>
                </PullToRefresh>

                <!--
                    Upload FAB: hidden during search, which has no directory to land in. Positioned on a wrapper div, not the
                    button: PrimeVue's `.p-button` sets its own `position: relative`, beating an `absolute` utility on the button.
                -->
                <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                <div v-if="!contentMode" class="absolute bottom-4 right-4 z-10">
                    <Button rounded class="h-14 w-14 px-0 py-0 shadow-lg" aria-label="Upload files here" @click="fileInput?.click()">
                        <Icon name="upload" class="text-xl" />
                    </Button>
                </div>
            </template>
        </template>

        <!-- A checked row draws its mark; the gutter holds the space either way, so the label can't shift on flip. -->
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

        <!-- Long-press row actions: the desktop tree's context menu, thumb-sized. -->
        <BottomSheet :model-value="sheetEntry !== undefined" @update:model-value="sheetEntry = undefined" :header="sheetEntry?.name">
            <div v-if="sheetEntry" class="flex flex-col gap-0.5">
                <button
                    type="button"
                    class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                    @click="copyPath(sheetEntry)"
                >
                    <Icon name="copy" class="text-base text-muted" /> Copy path
                </button>
                <!-- Where a link points; no hover on a phone, so this sheet is the only place a row can say it. -->
                <p v-if="sheetEntry.link" class="flex min-h-12 items-start gap-3 px-3 py-3 text-sm text-muted">
                    <Icon :name="sheetEntry.link.state === undefined ? 'link' : 'link-broken'" class="mt-0.5 shrink-0 text-base text-subtle" />
                    <span class="min-w-0 break-all"
                        >Link to {{ sheetEntry.link.to }}<template v-if="sheetEntry.link.state === 'broken'">: there is nothing there</template
                        ><template v-else-if="sheetEntry.link.state === 'outside'">: outside the workspace, so the sandbox won't open it</template>
                    </span>
                </p>
                <!-- Everything below Copy path is refused by the sandbox on a locked entry, so it gets the explanation instead. -->
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
                    <!--
                        Rename and Delete are writes, withheld below the operating tier like the padlock above; Download and Copy
                        path stay.
                    -->
                    <template v-if="canEditFiles">
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
                    <p v-else class="flex h-12 items-center gap-3 px-3 text-sm text-subtle">
                        <Icon name="lock" class="text-base text-subtle" /> Read-only: changing files needs maintainer access
                    </p>
                </template>
            </div>
        </BottomSheet>

        <Modal :open="renameTarget !== undefined" size="sm" header="Rename" @update:open="renameTarget = undefined">
            <input v-model="renameValue" type="text" class="ui-field-box w-full" @keydown.enter="confirmRename" />
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
