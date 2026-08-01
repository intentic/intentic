<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { BottomSheet, cmp, ConfirmDialog, PullToRefresh, Segmented } from "@intentic-app/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type SidebarPanel, useLayout } from "../../composables/useLayout";
import { reportOpenPath } from "../../composables/usePresence";
import { outgoingMark, outgoingSummary } from "../../composables/workspace/outgoingWork";
import { useChanges } from "../../composables/workspace/useChanges";
import { useMonaco } from "../../composables/workspace/useMonaco";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { useSearchOptions } from "../../composables/workspace/useSearchOptions";
import { useWorkspaceRoute } from "../../composables/workspace/useWorkspaceRoute";
import { type SearchScope, useWorkspaceSearch } from "../../composables/workspace/useWorkspaceSearch";
import { useWorkspaceTabs } from "../../composables/workspace/useWorkspaceTabs";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import BinaryDiffView from "./viewers/BinaryDiffView.vue";
import DiffToolbar from "./viewers/DiffToolbar.vue";
import DiffView from "./viewers/DiffView.vue";
import { rendersAsBytes } from "./fileType";
import type { DiffTabPayload } from "./workspaceTabs";
import { REFERENCE_DIR } from "@intentic/workspace-ignore/constants";
import { filesToEntries } from "./dropEntries";
import { iconForEntry } from "@intentic-app/ui";
import FileViewer from "./viewers/FileViewer.vue";
import HistoryPanel from "./HistoryPanel.vue";
import ReviewPanel from "./ReviewPanel.vue";
import UploadProgress from "./UploadProgress.vue";
import WorkspaceSearchResults from "./WorkspaceSearchResults.vue";
import { parentDir } from "@intentic-app/ui/path";

/* The mobile Workspace: a drill-down file browser — one directory per screen — plus the Changes / History
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
const { files: uploadFiles, scanning: uploadScanning, skippedNotice: uploadSkipped, enqueue } = useUploadQueue();
// The open file lives in the URL path (`/workspace/<path>`), synced to the tabs singleton by useWorkspaceRoute;
// this component keeps only the mobile-specific query state (`?dir=` browse location, `?diff=` diff view).
const { tabs, activeId, activeTab, openLine, openFile, openAtLine, openDiff } = useWorkspaceTabs();
useWorkspaceRoute();

// --- Route-driven navigation -------------------------------------------------------------------
const dir = computed(() => (typeof route.query[`dir`] === `string` ? route.query[`dir`] : ``));
const openPath = computed(() => (activeTab.value?.kind === `file` ? activeTab.value.path : undefined));
const diffId = computed(() => (typeof route.query[`diff`] === `string` ? route.query[`diff`] : undefined));

const openDir = (path: string): void => {
    // Browsing a folder leaves any open file — clear the path segment along with the query.
    void router.push({ name: `workspace`, params: { path: [] }, query: path === `` ? {} : { dir: path } });
};
const openDiffNav = (payload: DiffTabPayload): void => {
    openDiff(payload);
    void router.push({ name: `workspace`, params: { path: [] }, query: { ...route.query, diff: activeId.value ?? undefined } });
};

// A diff is content held in the tabs singleton, not addressable state — a reload lands with `?diff=` and no
// tab to show, so drop the param instead of painting an empty pane.
const diffTab = computed(() => {
    const tab = tabs.value.find((candidate) => candidate.id === diffId.value);
    return tab?.kind === `diff` ? tab : undefined;
});
watch(
    [diffId, diffTab],
    ([id, tab]) => {
        if (id !== undefined && tab === undefined) {
            void router.replace({ query: { ...route.query, diff: undefined } });
        }
    },
    { immediate: true },
);

// Presence: announce which file this tab has open, like the desktop workspace does.
watch(openPath, (path) => reportOpenPath(path), { immediate: true });
onBeforeUnmount(() => reportOpenPath(undefined));
// Load Monaco (+ Shiki bridge) up front so the first file open isn't cold.
onMounted(() => void useMonaco().ensureMonaco());

const openMeta = computed(() => entry(openPath.value));
const fileName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

// --- The current directory's listing -----------------------------------------------------------
const segment = computed<SidebarPanel>({ get: () => layout.sidebarPanel.value, set: (value) => layout.setSidebarPanel(value) });
// The Changes tab's chip, on the desktop explorer's terms (WorkspaceDesktop documents the gating): the count
// while there is work to review, then the outgoing mark, so a clean tree with commits still to push does not
// read as an empty tab.
const changesMark = computed(() => {
    const work = changes.outgoing.value;
    return changes.count.value > 0 || work === undefined ? {} : { mark: outgoingMark(work), markTitle: outgoingSummary(work) };
});
const segmentOptions = computed(() => [
    // Touch has no hover, so no hint here says anything a finger can reach — see the desktop twin. The mark
    // spread stays: `markTitle` is inert on this form factor, but the CHIP is what the tab is here for.
    { label: `Files`, value: `files` as const },
    { label: `Changes`, value: `changes` as const, badge: changes.count.value, ...changesMark.value },
    { label: `Checkpoints`, value: `history` as const },
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
    // The explorer's ignored-entry switch is shared with desktop (one browser, one preference), so a phone
    // drilling into a folder shows the same set of entries the tree would.
    const shown = layout.hideIgnored.value ? children.filter((node) => node.ignored !== true) : children;
    const query = filter.value.trim().toLowerCase();
    return query === `` ? shown : shown.filter((node) => node.name.toLowerCase().includes(query));
});
const dirLoading = computed(() => dir.value !== `` && lazyLoading.value.has(dir.value));
// How many entries the daemon's cap cut from the open dir's listing — 0 (the common case) shows nothing.
const dirHidden = computed(() => (dir.value === `` ? rootHidden.value : (lazyHidden.value.get(dir.value) ?? 0)));

// --- Long-press row actions (the ContextMenu equivalents) --------------------------------------
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
    void run(() => moveEntry(target.path, parent === `` ? name : `${parent}/${name}`));
};
const confirmDelete = (): void => {
    const target = deleteTarget.value;
    deleteTarget.value = undefined;
    if (target !== undefined) {
        void run(() => removeEntries([target.path]));
    }
};
const copyPath = (target: WorkspaceTreeEntry): void => {
    sheetEntry.value = undefined;
    // Clipboard may be unavailable (insecure context) — swallow, matching CopyButton.
    void navigator.clipboard.writeText(target.path).catch(() => undefined);
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
    });
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
    <div class="relative flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Full-screen viewer: `?file=` (any kind) or `?diff=` (from Changes/History). Back = OS gesture. -->
        <template v-if="openPath !== undefined || diffTab !== undefined">
            <!-- A diff gets the SAME bar the desktop tab and the agent review get, with the phone's back arrow
                 in its lead slot — one bar, not the generic header plus a second one. It already names the
                 file and marks its status, so the "diff" label this replaces had nothing left to add. -->
            <DiffToolbar
                v-if="diffTab"
                :path="diffTab.label"
                :status="diffTab.status"
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
                    <!-- No text to diff is not the same as nothing to see: an image renders as its two sides
                         (stacked here — two panes don't fit a phone). -->
                    <BinaryDiffView
                        v-if="rendersAsBytes(diffTab.path, diffTab.binary)"
                        :key="diffTab.id"
                        :path="diffTab.path"
                        :before="diffTab.beforeRaw"
                        :after="diffTab.afterRaw"
                    />
                    <p v-else-if="diffTab.truncated" class="p-4 text-xs text-subtle">File too large to diff in the browser.</p>
                    <DiffView v-else :key="diffTab.id" :before="diffTab.before" :after="diffTab.after" :path="diffTab.path" />
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
                <Segmented v-model="segment" size="sm" :options="segmentOptions" />
                <span class="flex-1"></span>
                <!-- Ignored entries in or out of the listing (node_modules, dist, gitignored paths, refs/) — the
                     desktop toolbar's chip, thumb-sized. Files segment only, since that's all it changes; no
                     tooltip to lean on here, so the icon carries the state and the label spells it out. -->
                <button
                    v-if="segment === 'files'"
                    type="button"
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors active:bg-overlay"
                    :class="layout.hideIgnored.value ? 'text-link' : 'text-muted'"
                    :aria-pressed="layout.hideIgnored.value"
                    :aria-label="layout.hideIgnored.value ? 'Show ignored files' : 'Hide ignored files'"
                    @click="layout.toggleHideIgnored()"
                >
                    <Icon :name="layout.hideIgnored.value ? `eye-slash` : `eye`" class="text-base" />
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
            <p v-if="actionError ?? error" class="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
                {{ actionError ?? error }}
            </p>

            <ReviewPanel v-if="segment === 'changes'" @open-diff="openDiffNav" />
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
                            :placeholder="contentMode ? `Search in files…` : `Filter…`"
                            class="h-10 w-full min-w-0 rounded-lg border border-line bg-canvas pl-8 pr-3 text-base text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                            @keydown.esc="clearFilter"
                        />
                    </div>
                    <Segmented
                        v-model="searchScope"
                        size="xs"
                        :options="[
                            { label: `Name`, value: `name` },
                            { label: `Text`, value: `text` },
                            { label: `Smart`, value: `smart` },
                        ]"
                    />
                </div>
                <!-- Aa / ab / .* + Ignored — the same switches the desktop field carries, and the same rule for
                     which scope sees which: the three change what a PATTERN means, Ignored changes what is
                     searched at all. -->
                <div v-if="contentMode" class="flex shrink-0 items-center gap-1.5 px-2 pb-1.5">
                    <template v-if="textMode">
                        <button
                            v-for="toggle in matchToggles"
                            :key="toggle.label"
                            type="button"
                            class="flex h-8 w-9 items-center justify-center rounded-lg font-mono text-xs leading-none text-muted transition-colors active:bg-overlay"
                            :class="{ 'bg-primary-600/20 text-link': toggle.on }"
                            :aria-pressed="toggle.on"
                            :aria-label="toggle.title"
                            @click="toggle.flip()"
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
                        @click="search.toggleIncludeIgnored()"
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
                <PullToRefresh v-else :on-refresh="refetch">
                    <div class="pb-24">
                        <template>
                            <button
                                v-for="node in listing"
                                :key="node.path"
                                type="button"
                                class="flex h-11 w-full items-center gap-3 px-3 text-left transition-colors active:bg-overlay"
                                v-longpress="() => (sheetEntry = node)"
                                @click="node.type === 'dir' ? openDir(node.path) : openFile(node.path)"
                            >
                                <Icon
                                    :name="iconForEntry(node.name, node.type)"
                                    class="shrink-0 text-base"
                                    :class="node.ignored ? 'text-subtle' : 'text-muted'"
                                />
                                <span class="min-w-0 flex-1 truncate text-sm" :class="{ 'text-subtle': node.ignored }">{{ node.name }}</span>
                                <!-- The reference shelf must not read as junk — no hover on touch, so the badge alone names it. -->
                                <span
                                    v-if="node.path === REFERENCE_DIR"
                                    class="shrink-0 rounded-full bg-subtle/10 px-1.5 text-2xs font-medium text-subtle"
                                    >reference</span
                                >
                                <Icon v-if="node.type === 'dir'" name="chevron-right" class="shrink-0 text-xs text-subtle" />
                            </button>
                            <p v-if="dirLoading && listing.length === 0" class="px-4 py-8 text-center text-xs text-subtle">Loading…</p>
                            <p v-else-if="listing.length === 0" class="px-4 py-8 text-center text-xs text-subtle">
                                {{ filter ? "No matching entries." : "This directory is empty." }}
                            </p>
                            <p v-if="dirHidden > 0" class="px-4 py-2 text-center text-2xs text-subtle">
                                {{ dirHidden.toLocaleString() }} more {{ dirHidden === 1 ? "entry" : "entries" }} in this folder — search to reach
                                them.
                            </p>
                        </template>
                    </div>
                </PullToRefresh>

                <!-- Upload FAB: the picker replacement for desktop's drag-drop; lands in the open directory —
                     so it is gone while a search is showing, which has no open directory to land in and whose
                     rows it would otherwise sit on top of. -->
                <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
                <button
                    v-if="!contentMode"
                    type="button"
                    :class="cmp.buttonPrimary('absolute bottom-4 right-4 z-10 h-13 w-13 rounded-full px-0 py-0 shadow-lg')"
                    aria-label="Upload files here"
                    @click="fileInput?.click()"
                >
                    <Icon name="upload" class="text-xl" />
                </button>
            </template>

            <UploadProgress v-if="uploadScanning || uploadFiles.length > 0 || uploadSkipped !== undefined" />
        </template>

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
            </div>
        </BottomSheet>

        <Dialog
            :visible="renameTarget !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: 'min(26rem, calc(100vw - 2rem))' }"
            header="Rename"
            @update:visible="renameTarget = undefined"
        >
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
        </Dialog>

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
