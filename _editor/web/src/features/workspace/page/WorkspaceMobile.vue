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
    usePageBack,
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
import { useUploadQueue } from "../files/upload/useUploadQueue";
import { useExplorerSearch } from "../search/useExplorerSearch";
import { matchToggles } from "../search/useSearchOptions";
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
import { useAudience } from "../../../app/useAudience";
import { useVocabulary } from "../../../core-views/vocabulary";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { filesToEntries } from "../explorer/transfer/dropEntries";
import { isArchiveContent, opensAsFolder } from "../files/archiveEntries";
import { type Provisional, provisionalAt, withProvisionalEntries } from "../files/provisionalEntries";
import { type ExplorerFilters, explorerShows, technicalHidden } from "../explorer/explorerFilter";
import FileViewer from "../viewers/FileViewer.vue";
import HistoryPanel from "../changes/history/HistoryPanel.vue";
import ReviewPanel from "../changes/ReviewPanel.vue";
import SaveActions from "../changes/save/SaveActions.vue";
import SavePanel from "../changes/save/SavePanel.vue";
import WorkspaceDirChip from "../explorer/WorkspaceDirChip.vue";
import WorkspaceScopeChip from "../explorer/WorkspaceScopeChip.vue";
import { workspaceAgent, workspaceDir } from "../health/workspaceScope";
import { withinScope } from "../../../app/projectScope";
import WorkspaceSearchResults from "../search/WorkspaceSearchResults.vue";
import { parentDir } from "@intentic/ui/path";
import { useT } from "@intentic/ui/i18n";

// Drill-down file browser (one directory per screen) plus Changes/Restore Points panels and a full-screen
// read-only viewer. Navigation state lives in the route (`?dir=`, `?file=`, `?diff=`), so OS back is up/close
// and deep links work. Desktop affordances (drag-drop, tab strip, edit) become a picker FAB, a long-press sheet, and
// read-only files.

const t = useT();

const route = useRoute();
const router = useRouter();
const layout = useLayout();
// Published by the shell off the Menu (Files is not a tab); undefined on Review's own Changes panel.
const back = usePageBack();
const words = useVocabulary();
const { maker } = useAudience();
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
    error.value === undefined ? undefined : { tone: `danger`, title: t(`workspace.workspaceMobile.couldntLoadFiles`), detail: error.value },
);
const { enqueue } = useUploadQueue();
const { say } = useNotifications();
// Open file lives in the URL, synced by useWorkspaceRoute; this view keeps only its own state (dir, diff).
const { tabs, activeId, activeTab, openLine, openFile, openAtLine, openDiff } = useWorkspaceTabs();
useWorkspaceRoute();

// Route-driven navigation. The browser's floor is the open project when there is one (workspaceDir), the way the
// desktop tree roots at it: a `?dir=` outside it names nothing this screen may show, so it reads as the root instead.
const dir = computed(() => {
    const asked = route.query[`dir`];
    return typeof asked === `string` && withinScope(asked) ? asked : workspaceDir.value;
});
const openPath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
const diffId = computed(() => (typeof route.query[`diff`] === `string` ? route.query[`diff`] : undefined));

const openDir = (path: string): void => {
    // Browsing a folder leaves any open file; clear the path segment along with the query. The root carries no `?dir=`,
    // whatever it is called, so the address of "where this screen starts" doesn't change when the project does.
    void router.push({ name: `workspace`, params: { path: [] }, query: path === workspaceDir.value ? {} : { dir: path } });
};
// A folder path means nothing under a different project root, so opening or clearing a project starts at its floor.
watch(workspaceDir, () => {
    if (typeof route.query[`dir`] === `string`) {
        void router.replace({ name: `workspace`, params: { path: [] }, query: {} });
    }
});
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
    { label: t(`workspace.workspaceMobile.files`), value: `files` as const },
    { label: words.value.changes, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
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
// Filter switches are shared with desktop, so a drilled-into folder shows the same entries the tree would.
const filters = computed<ExplorerFilters>(() => ({
    showIgnored: layout.showIgnored.value,
    hideTests: layout.hideTests.value,
    hideTechnical: layout.hideTechnical.value,
}));
// A walked dir carries children inline; an unlisted one's arrive via loadChildren, keyed by path.
const children = computed<readonly WorkspaceTreeEntry[]>(() =>
    dir.value === `` ? tree.value : (entriesByPath.value.get(dir.value)?.children ?? lazyChildren.value.get(dir.value) ?? []),
);
const listing = computed<readonly WorkspaceTreeEntry[]>(() => {
    // Entries on their way into this folder are listed and ones on their way out are not, so every file gesture shows
    // in the list at the gesture rather than a round trip later.
    const shown = withProvisionalEntries(dir.value, children.value).filter((node) => explorerShows(node, filters.value));
    const query = filter.value.trim().toLowerCase();
    return query === `` ? shown : shown.filter((node) => node.name.toLowerCase().includes(query));
});
// Tooling entries the technical switch took out of this level, said on a chip so the list never reads as the folder.
const technicalCount = computed(() => technicalHidden(children.value, filters.value));
const dirLoading = computed(() => dir.value !== `` && lazyLoading.value.has(dir.value));
// Entries the daemon's cap cut from the open dir's listing; 0, the common case, shows nothing.
const dirHidden = computed(() => (dir.value === `` ? rootHidden.value : (lazyHidden.value.get(dir.value) ?? 0)));

// The funnel's sheet (the desktop menu's rows), thumb-sized; stays open, since both repaint the list behind it.
const filterSheet = ref(false);

// A symlink that goes nowhere or leaves the workspace: dimmed, with no drill-in, since the sandbox has nothing
// to list behind it.
const deadLink = (node: WorkspaceTreeEntry): boolean => node.link?.state !== undefined;

// A row for a file still arriving: drawn so an upload is visible where it lands, but there is nothing at that path to
// open or act on until the workspace listing has it. A folder still arriving drills in — its own rows are placeholders.
// Only for a path the listing doesn't have: a folder an upload is landing in usually exists already.
const pendingRow = (path: string): Provisional | undefined => (entriesByPath.value.has(path) ? undefined : provisionalAt(path));
const pending = (path: string): boolean => pendingRow(path) !== undefined;
// An archive's contents are read-only: what a row there names is a copy the daemon keeps out of sight, and nothing
// repacks a zip. The archive FILE itself is ordinary workspace content.
const archivedEntry = (node: WorkspaceTreeEntry): boolean => isArchiveContent(node.path, (path) => entriesByPath.value.get(path));
const openEntry = (node: WorkspaceTreeEntry): void => {
    if (node.type === `dir` && !isLockedWorkspacePath(node.path) && !deadLink(node)) {
        openDir(node.path);
        return;
    }
    if (pending(node.path)) {
        return;
    }
    // A zip or tar drills in like the folder it holds; the daemon lists its contents on demand.
    if (opensAsFolder(node)) {
        openDir(node.path);
        return;
    }
    openFile(node.path);
};

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
    // Said only once the move lands, and named: on a phone the list is the only feedback there is, and a row changing
    // its own name is easy to miss with a thumb over it.
    void run(async () => {
        await moveEntry(target.path, parent === `` ? name : `${parent}/${name}`);
        say(`Renamed to ${name}`);
    }, `Couldn't rename that.`);
};
const confirmDelete = (): void => {
    const target = deleteTarget.value;
    deleteTarget.value = undefined;
    if (target !== undefined) {
        void run(async () => {
            await removeEntries([target.path]);
            say(`${target.name} deleted`);
        }, `Couldn't delete that.`);
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
                    <button
                        type="button"
                        :class="ui.iconButton(`h-11 w-11 rounded-lg active:bg-overlay`)"
                        :aria-label="t(`ui.action.back`)"
                        @click="router.back()"
                    >
                        <Icon name="arrow-left" class="text-lg" />
                    </button>
                </template>
            </DiffToolbar>
            <div v-else class="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-card px-1">
                <button
                    type="button"
                    :class="ui.iconButton(`h-11 w-11 rounded-lg active:bg-overlay`)"
                    :aria-label="t(`ui.action.back`)"
                    @click="router.back()"
                >
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
                <button
                    v-if="back"
                    type="button"
                    :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`)"
                    :aria-label="back.label"
                    @click="back.go()"
                >
                    <Icon name="arrow-left" class="text-lg" />
                </button>
                <SegmentedControl v-model="segment" size="sm" :options="segmentOptions" />
                <span class="flex-1"></span>
                <WorkspaceScopeChip />
                <!-- The maker's whole-tree presses ride this row rather than a bar along the panel's floor, and lead the
                     icons: what acts on the work sits left of what only changes what is shown. -->
                <SaveActions v-if="maker && segment === 'changes'" />
                <button
                    type="button"
                    :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`, segment === `history` ? `bg-overlay text-content` : ``)"
                    :aria-pressed="segment === 'history'"
                    :aria-label="t(`workspace.workspaceMobile.restorePoints`)"
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
                    :aria-label="t(`workspace.workspaceMobile.filterWhatExplorerLists`)"
                    @click="filterSheet = true"
                >
                    <Icon name="filter" class="text-base" />
                </button>
                <!-- One refresh for the row, refetching whichever segment shows; Changes no longer carries its own header row. -->
                <button
                    type="button"
                    :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`)"
                    @click="segment === 'changes' ? changes.refresh() : refetch()"
                    :aria-label="t(`ui.action.refresh`)"
                    :disabled="
                        segment === 'changes'
                            ? changes.actionBusy.value || changes.fetching.value || changes.landing.value !== undefined
                            : busy || isLoading
                    "
                >
                    <Icon
                        name="refresh"
                        class="text-base"
                        :spin="segment === 'changes' ? changes.fetching.value || changes.actionBusy.value : isLoading || busy"
                    />
                </button>
            </div>
            <NoticeStack :of="[actionError, treeNotice]" class="shrink-0 px-3 py-1.5" />

            <template v-if="segment === 'changes'">
                <SavePanel v-if="maker" @open-diff="openDiffNav" />
                <ReviewPanel v-else @open-diff="openDiffNav" />
            </template>
            <HistoryPanel v-else-if="segment === 'history'" @open-diff="openDiffNav" />

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
                            :placeholder="contentMode ? t(`workspace.workspaceMobile.searchInFiles`) : t(`workspace.workspaceMobile.filter`)"
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
                            :placeholder="t(`workspace.workspaceMobile.filesToIncludeE`)"
                            :aria-label="t(`workspace.workspaceMobile.filesToInclude`)"
                            class="ui-field-box w-full min-w-0 pl-8 pr-3"
                        />
                    </div>
                </div>
                <!-- Same switches as the desktop field: the three change what a pattern means, Ignored changes what's searched. -->
                <div v-if="contentMode" class="flex shrink-0 items-center gap-1.5 px-2 pb-1.5">
                    <template v-if="textMode">
                        <button
                            v-for="toggle in matchToggles()"
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
                        {{ t(`workspace.workspaceMobile.ignored`) }}
                    </button>
                </div>

                <!-- Where we are, plus one-tap up; the OS back gesture also goes up. Up is absent at this screen's own
                     floor, since there is nothing above it to go to — but under a project the row stays, because the
                     chip naming the project and clearing it belongs on a bar with room for the name rather than in the
                     crowded row above, where a phone has no hover to read a truncated one from. -->
                <div
                    v-if="(dir !== workspaceDir || workspaceDir !== '') && !contentMode"
                    class="flex h-11 shrink-0 items-center gap-1 border-b border-line px-1 pr-2"
                >
                    <button
                        v-if="dir !== workspaceDir"
                        type="button"
                        :class="ui.iconButton(`h-10 w-10 rounded-lg active:bg-overlay`)"
                        :aria-label="t(`workspace.workspaceMobile.upOneDirectory`)"
                        @click="openDir(parentDir(dir))"
                    >
                        <Icon name="arrow-left" class="text-base" />
                    </button>
                    <span class="min-w-0 flex-1 truncate px-1 text-sm font-medium">{{ dir === workspaceDir ? "" : dir }}</span>
                    <!-- Which project this screen is rooted at, and the way back to everything; absent on the whole tree. -->
                    <WorkspaceDirChip :compact="false" />
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
                <!-- Bare templates cannot wrap these rows; `v-for` belongs on the row itself. -->
                <PullToRefresh v-else :on-refresh="refetch">
                    <div class="pb-24">
                        <button
                            v-for="node in listing"
                            :key="node.path"
                            type="button"
                            class="flex min-h-12 w-full items-center gap-3 px-3 text-left transition-colors active:bg-overlay"
                            v-longpress="() => (sheetEntry = pending(node.path) ? undefined : node)"
                            @click="openEntry(node)"
                        >
                            <!-- Private rows are dimmed and open their explanatory tab. -->
                            <Icon
                                :name="isLockedWorkspacePath(node.path) ? 'lock' : iconForEntry(node.name, node.type)"
                                class="shrink-0 text-base"
                                :class="node.ignored || isLockedWorkspacePath(node.path) ? 'text-subtle' : 'text-muted'"
                            />
                            <span
                                class="min-w-0 flex-1 truncate text-sm"
                                :class="{
                                    'text-subtle':
                                        node.ignored || isLockedWorkspacePath(node.path) || node.link?.state !== undefined || pending(node.path),
                                }"
                                >{{ node.name }}</span
                            >
                            <!-- Still on its way in: sending, or on disk with the workspace listing yet to catch up. -->
                            <Icon
                                v-if="pendingRow(node.path)?.state === 'failed'"
                                name="exclamation-triangle"
                                aria-hidden="true"
                                class="shrink-0 text-xs text-danger"
                            />
                            <Icon
                                v-else-if="pending(node.path)"
                                name="spinner"
                                :spin="true"
                                aria-hidden="true"
                                class="shrink-0 text-xs text-subtle"
                            />
                            <!-- A symlink wears its target's icon; this marker shows it's a pointer. No hover, so the sheet says where. -->
                            <Icon
                                v-if="node.link !== undefined"
                                :name="node.link.state === undefined ? 'link' : 'link-broken'"
                                class="shrink-0 text-xs"
                                :class="node.link.state === undefined ? 'text-subtle' : 'text-warning'"
                            />
                            <!-- What the sandbox does with this entry (specialPaths.ts). No hover on touch, so the chip alone names it. -->
                            <span
                                v-if="specialChip(node.path, words)"
                                class="ui-status-pill shrink-0 text-2xs font-medium"
                                :class="specialChip(node.path, words)?.tone === 'warning' ? 'bg-warning/10 text-warning' : 'bg-subtle/10 text-subtle'"
                                >{{ specialChip(node.path, words)?.label }}</span
                            >
                            <Icon
                                v-if="node.type === 'dir' && !isLockedWorkspacePath(node.path) && !deadLink(node)"
                                name="chevron-right"
                                class="shrink-0 text-xs text-subtle"
                            />
                        </button>
                        <p v-if="dirLoading && listing.length === 0" class="px-4 py-8 text-center text-xs text-subtle">
                            {{ t(`workspace.workspaceMobile.loading`) }}
                        </p>
                        <p v-else-if="listing.length === 0" class="px-4 py-8 text-center text-xs text-subtle">
                            {{ filter ? t(`workspace.workspaceMobile.noMatchingEntries`) : t(`workspace.workspaceMobile.directoryEmpty`) }}
                        </p>
                        <p v-if="dirHidden > 0" class="px-4 py-2 text-center text-2xs text-subtle">
                            {{ t(`workspace.workspaceMobile.moreEntries`, { count: dirHidden.toLocaleString() }, dirHidden) }}
                        </p>
                        <!-- The technical switch's own receipt; a tap is the way back. -->
                        <button
                            v-if="technicalCount > 0 && !filter.trim()"
                            type="button"
                            class="w-full px-4 py-2 text-center text-2xs text-subtle active:text-content"
                            @click="layout.toggleHideTechnical()"
                        >
                            {{ t(`workspace.workspaceMobile.technicalHidden`, { count: technicalCount }, technicalCount) }}
                        </button>
                    </div>
                </PullToRefresh>

                <!-- The upload FAB stays on a wrapper so PrimeVue cannot override its absolute position. -->
                <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                <div v-if="!contentMode" class="absolute bottom-4 right-4 z-10">
                    <Button
                        rounded
                        class="h-14 w-14 px-0 py-0 shadow-lg"
                        :aria-label="t(`workspace.workspaceMobile.uploadFilesHere`)"
                        @click="fileInput?.click()"
                    >
                        <Icon name="upload" class="text-xl" />
                    </Button>
                </div>
            </template>
        </template>

        <!-- A checked row draws its mark; the gutter holds the space either way, so the label can't shift on flip. -->
        <BottomSheet v-model="filterSheet" :header="t(`workspace.workspaceMobile.filter2`)">
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
                    {{ t(`workspace.workspaceMobile.showIgnoredFiles`) }}
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
                    {{ t(`workspace.workspaceMobile.hideTests`) }}
                </button>
                <button
                    type="button"
                    class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                    :aria-pressed="layout.hideTechnical.value"
                    @click="layout.toggleHideTechnical()"
                >
                    <span class="flex w-4 shrink-0 justify-center">
                        <Icon v-show="layout.hideTechnical.value" name="check" class="text-base text-muted" />
                    </span>
                    {{ t(`workspace.workspaceMobile.hideTechnicalFiles`) }}
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
                    <Icon name="copy" class="text-base text-muted" /> {{ t(`workspace.workspaceMobile.copyPath`) }}
                </button>
                <!-- Where a link points; no hover on a phone, so this sheet is the only place a row can say it. -->
                <p v-if="sheetEntry.link" class="flex min-h-12 items-start gap-3 px-3 py-3 text-sm text-muted">
                    <Icon :name="sheetEntry.link.state === undefined ? 'link' : 'link-broken'" class="mt-0.5 shrink-0 text-base text-subtle" />
                    <span class="min-w-0 break-all"
                        >{{ t(`workspace.workspaceMobile.linkTo`) }} {{ sheetEntry.link.to
                        }}<template v-if="sheetEntry.link.state === 'broken'">{{ t(`workspace.workspaceMobile.nothing`) }}</template
                        ><template v-else-if="sheetEntry.link.state === 'outside'">{{
                            t(`workspace.workspaceMobile.outsideWorkspaceSandboxWont`)
                        }}</template>
                    </span>
                </p>
                <!-- Everything below Copy path is refused by the sandbox on a locked entry, so it gets the explanation instead. -->
                <p v-if="isLockedWorkspacePath(sheetEntry.path)" class="flex h-12 items-center gap-3 px-3 text-sm text-muted">
                    <Icon name="lock" class="text-base text-subtle" /> {{ t(`workspace.workspaceMobile.keptPrivateBySandbox`) }}
                </p>
                <template v-else>
                    <button
                        v-if="sheetEntry.type === 'file'"
                        type="button"
                        class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                        @click="download(sheetEntry)"
                    >
                        <Icon name="download" class="text-base text-muted" /> {{ t(`ui.action.download`) }}
                    </button>
                    <!-- Rename and Delete stay gated; Download and Copy path remain available. -->
                    <template v-if="canEditFiles && !archivedEntry(sheetEntry)">
                        <button
                            type="button"
                            class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm active:bg-overlay"
                            @click="startRename(sheetEntry)"
                        >
                            <Icon name="pencil" class="text-base text-muted" /> {{ t(`ui.action.rename`) }}
                        </button>
                        <button
                            type="button"
                            class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm text-danger active:bg-danger/10"
                            @click="((deleteTarget = sheetEntry), (sheetEntry = undefined))"
                        >
                            <Icon name="trash" class="text-base" /> {{ t(`ui.action.delete`) }}
                        </button>
                    </template>
                    <p v-else-if="archivedEntry(sheetEntry)" class="flex h-12 items-center gap-3 px-3 text-sm text-subtle">
                        <Icon name="box" class="text-base text-subtle" /> {{ t(`workspace.workspaceMobile.insideArchiveExtractTo`) }}
                    </p>
                    <p v-else class="flex h-12 items-center gap-3 px-3 text-sm text-subtle">
                        <Icon name="lock" class="text-base text-subtle" /> {{ t(`workspace.workspaceMobile.readOnlyChangingFiles`) }}
                    </p>
                </template>
            </div>
        </BottomSheet>

        <Modal :open="renameTarget !== undefined" size="sm" :header="t(`ui.action.rename`)" @update:open="renameTarget = undefined">
            <input v-model="renameValue" type="text" class="ui-field-box w-full" @keydown.enter="confirmRename" />
            <template #footer>
                <Button :label="t(`ui.action.cancel`)" severity="secondary" :text="true" @click="renameTarget = undefined" />
                <Button :label="t(`ui.action.rename`)" autofocus @click="confirmRename" />
            </template>
        </Modal>

        <ConfirmDialog
            :open="deleteTarget !== undefined"
            :header="t(`workspace.workspaceMobile.delete`)"
            :confirm-label="t(`ui.action.delete`)"
            confirm-icon="trash"
            @cancel="deleteTarget = undefined"
            @confirm="confirmDelete"
        >
            <p class="text-sm text-content">
                {{ t(`ui.action.delete`) }} <span class="font-medium">{{ deleteTarget?.path }}</span
                >{{ deleteTarget?.type === "dir" ? t(`workspace.workspaceMobile.everythingInside`) : ""
                }}{{ t(`workspace.workspaceMobile.cantUndone`) }}
            </p>
        </ConfirmDialog>
    </div>
</template>
