<!-- The desk: the folder being looked at as large tiles, folders first and files by kind, with a quick look on hover. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { ConfirmDialog, ContextMenu, iconForEntry, useLoadingReveal } from "@intentic/ui";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, inject, onBeforeUnmount, onMounted, ref, type VNode, watch } from "vue";
import { variableRows } from "../../../lib/rowWindow";
import { useRowWindow } from "../../../lib/useRowWindow";
import { useLayout } from "../../../shell/window/useLayout";
import { type ExplorerFilters, explorerShows, technicalHidden } from "../explorer/explorerFilter";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { opensAsFolder } from "../files/archiveEntries";
import { withProvisionalEntries } from "../files/provisionalEntries";
import { workspaceDir } from "../health/workspaceScope";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { type GridKey, isGridKey, moveInGrid } from "./deskGrid";
import { bandOfIndex, deskLayout } from "./deskLayout";
import { deskGroups, deskOrder, labelsShown } from "./deskOrder";
import { contentMatches, nameMatches, RESULTS_CAP } from "./deskResults";
import { DESK_DIR_ACTIONS, DESK_SEARCH, useDesk } from "./useDesk";
import { useDeskActions } from "./useDeskActions";
import DeskPeek from "./DeskPeek.vue";
import DeskTile from "./DeskTile.vue";
import { useT } from "@intentic/ui/i18n";

// Drawn by EditorPane in place of the empty state while the desk preference is on. Reads the same tree the explorer
// draws, opens files into the same tabs, and does to its tiles what the tree does to its rows (useDeskActions). Owns
// which folder is open, arrow travel and the quick look.

const t = useT();

const { deskDir, openDir, selected } = useDesk();
const { tree, entriesByPath, lazyChildren, lazyHidden, lazyLoading, rootHidden, loadChildren, isLoading } = useWorkspaceTree();
const { openFile } = useWorkspaceTabs();
const layout = useLayout();
const dirActions = inject(DESK_DIR_ACTIONS, () => []);

// The same three switches as the tree, so the desk never lists what the tree hides.
const filters = computed<ExplorerFilters>(() => ({
    showIgnored: layout.showIgnored.value,
    hideTests: layout.hideTests.value,
    hideTechnical: layout.hideTechnical.value,
}));

// The open folder's entries: inline from the walk, or the lazy listing for a folder the walk skipped; undefined until
// that listing lands.
const children = computed<readonly WorkspaceTreeEntry[] | undefined>(() => {
    const dir = deskDir.value;
    return dir === `` ? tree.value : (entriesByPath.value.get(dir)?.children ?? lazyChildren.value.get(dir));
});
watch(
    () => [deskDir.value, children.value === undefined] as const,
    ([dir, unlisted]) => {
        if (dir !== `` && unlisted) {
            void loadChildren(dir);
        }
    },
    { immediate: true },
);

const shows = (entry: WorkspaceTreeEntry): boolean => explorerShows(entry, filters.value);

// --- The query: the sidebar's own (DESK_SEARCH), answered here under the open folder ---------------------------------
// Names the desk matches itself over the loaded tree; text and smart are the daemon's, and the desk draws the files
// its groups name. Typing on the desk writes the same query, so the tree narrows with it.
const search = inject(DESK_SEARCH, undefined);
const query = computed<string>({
    get: () => search?.filter.value ?? ``,
    set: (value) => {
        if (search !== undefined) {
            search.filter.value = value;
        }
    },
});
const querying = computed(() => query.value.trim() !== ``);
const searching = computed(() => search?.searching.value === true);
const entryAt = (path: string): WorkspaceTreeEntry | undefined =>
    entriesByPath.value.get(path) ?? lazyChildren.value.get(parentDir(path))?.find((entry) => entry.path === path);
const childrenOfEntry = (folder: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] | undefined =>
    folder.children ?? lazyChildren.value.get(folder.path);
const results = computed(() => {
    if (search === undefined || !querying.value) {
        return [];
    }
    return search.contentMode.value
        ? contentMatches(
              search.groups.value.map((group) => group.path),
              deskDir.value,
              entryAt,
          )
        : nameMatches(query.value, deskDir.value, children.value ?? [], childrenOfEntry, shows);
});
// The folder each result sits in, for the line under its name; "" (the open folder itself) draws nothing.
const whereByPath = computed(() => new Map(results.value.map((result) => [result.entry.path, result.where])));
const clearQuery = (): void => {
    search?.clear();
    desk.value?.focus({ preventScroll: true });
};
const placeholder = computed(() =>
    search?.scope.value === `text` ? `Search text` : search?.scope.value === `smart` ? `Smart search` : `Filter names`,
);
const queryField = ref<HTMLInputElement>();
// The field owns its keys; Escape hands the desk back, Enter lands on the first result so the next Enter opens it.
const onFieldKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        clearQuery();
        return;
    }
    if (event.key === `Enter`) {
        void focusTile(0);
    }
};

// The tiles: the query's results, or the open folder's entries as the explorer's switches leave them.
const listed = computed<readonly WorkspaceTreeEntry[]>(() =>
    querying.value ? results.value.map((result) => result.entry) : withProvisionalEntries(deskDir.value, children.value ?? []).filter(shows),
);
const groups = computed(() => deskGroups(listed.value));
const order = computed(() => deskOrder(groups.value));
const showLabels = computed(() => labelsShown(groups.value));

// --- The window -------------------------------------------------------------------------------------------------
// A folder can hold tens of thousands of entries, so the desk draws the bands crossing the viewport and no others. A
// tile per entry is what made a large directory unusable: the components cost more than the files, every tick re-diffed
// all of them, and each one held an IntersectionObserver of its own.
const desk = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const probeGrid = ref<HTMLElement>();
const probeTile = ref<HTMLElement>();
const probeLabel = ref<HTMLElement>();

// Measured off a hidden probe wearing the real classes, never computed from numbers written down here: the template's
// `auto-fill` track and the tile's height are the CSS's to say, and a copy of them here would drift the first time
// someone restyled a tile.
const probed = ref({ columns: 1, tileHeight: 1, labelHeight: 0 });
const measure = (): void => {
    const grid = probeGrid.value;
    const tile = probeTile.value;
    if (grid === undefined || tile === undefined) {
        return;
    }
    const style = getComputedStyle(grid);
    // The gap rides in the band height: bands are placed at an offset, so nothing else would space them apart.
    const gap = Number.parseFloat(style.rowGap) || 0;
    probed.value = {
        columns: style.gridTemplateColumns.split(` `).filter((track) => track !== ``).length,
        tileHeight: tile.offsetHeight + gap,
        labelHeight: probeLabel.value?.offsetHeight ?? 0,
    };
};
let probeSize: ResizeObserver | undefined;
onMounted(() => {
    probeSize = new ResizeObserver(measure);
    if (probeGrid.value !== undefined) {
        probeSize.observe(probeGrid.value);
    }
    measure();
});
onBeforeUnmount(() => probeSize?.disconnect());

const gridLayout = computed(() => deskLayout(groups.value, showLabels.value, probed.value));
const bands = useRowWindow(scroller, () => variableRows(gridLayout.value.heights));
// What to draw, each band carrying where it sits: they are placed, not stacked, so the ones left out cost no height.
const painted = computed(() =>
    gridLayout.value.bands
        .slice(bands.first.value, bands.last.value)
        .map((band, at) => ({ band, top: bands.rows.value.offsetOf(bands.first.value + at) })),
);
// The spacer's height, as its own top-level ref: a template unwraps those, but not a ref reached through an object,
// and `bands.total` there would interpolate as "[object Object]" and silently leave the folder unscrollable.
const deskHeight = computed(() => bands.total.value);
// Two quiet lines under the tiles, each only when it has a number to say.
const hiddenTooling = computed(() => technicalHidden(children.value ?? [], filters.value));
const hiddenByCap = computed(() => (deskDir.value === `` ? rootHidden.value : (lazyHidden.value.get(deskDir.value) ?? 0)));

const loading = computed(() => (deskDir.value === `` ? isLoading.value : children.value === undefined && lazyLoading.value.has(deskDir.value)));
const revealed = useLoadingReveal(loading, deskDir);

// --- Where you are -------------------------------------------------------------------------------------------------
const rootLabel = computed(() => (workspaceDir.value === `` ? `Workspace` : basename(workspaceDir.value)));
const crumbs = computed<readonly { readonly label: string; readonly path: string }[]>(() => {
    const root = workspaceDir.value;
    const relative = deskDir.value === root ? `` : root === `` ? deskDir.value : deskDir.value.slice(root.length + 1);
    const parts = relative === `` ? [] : relative.split(`/`);
    return [
        { label: rootLabel.value, path: root },
        ...parts.map((part, index) => ({ label: part, path: [root, ...parts.slice(0, index + 1)].filter((segment) => segment !== ``).join(`/`) })),
    ];
});
const here = computed(() => crumbs.value.at(-1)?.label ?? rootLabel.value);

// --- The verbs: the tree's file management over these tiles (useDeskActions) -----------------------------------------
const {
    marked,
    select,
    clear,
    editing,
    renaming,
    renameDraft,
    commitRename,
    cancelRename,
    creating,
    createDraft,
    createError,
    commitCreate,
    cancelCreate,
    confirmPaths,
    deleteTitle,
    confirmDelete,
    cancelDelete,
    onCopyEvent,
    onPasteEvent,
    dragging,
    dragPaths,
    over,
    dropDir,
    onPointerDown,
    consumeSuppressedClick,
    onDragOver,
    onDragLeave,
    onDrop,
    menu,
    menuItems,
    openMenu,
    handleKey,
    locked,
    noDrops,
    archiveHere,
    pending,
} = useDeskActions({
    dir: deskDir,
    order,
    lead: selected,
    host: desk,
    // Closures, not the functions: both are declared below, and are only ever called later.
    open: (entry) => open(entry),
    openCreated: (path) => {
        // A new file opens straight into edit mode; kept, not previewed, so a later peek can't close it mid-type.
        openFile(path, `keep`);
        layout.setEditMode(true);
    },
    dirActions,
});
// Focus and select the create field's text the moment it mounts.
const focusField = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};

// Forward slides the tiles in from the right, back from the left: the direction the breadcrumb reads in.
const direction = ref<"forward" | "back">(`forward`);
// `selected` is the shared current entry (useDesk): a tile click lands here, and so does a click in the tree.
const selectedEntry = computed(() => order.value.find((entry) => entry.path === selected.value));
const go = (dir: string, toward: "forward" | "back"): void => {
    closePeek();
    cancelRename();
    cancelCreate();
    // A query is about the folder it was typed in; going somewhere else starts fresh.
    if (querying.value) {
        search?.clear();
    }
    // The folder entered is the current entry: the tree marks and reveals it; nothing here is marked, since the desk
    // is now inside it.
    selected.value = dir === workspaceDir.value ? undefined : dir;
    direction.value = toward;
    openDir(dir);
    // The tile that had the keyboard is about to unmount; the desk itself keeps it, so the next key still lands here.
    if (desk.value?.contains(document.activeElement) === true) {
        desk.value.focus({ preventScroll: true });
    }
};
// Going up lands on the folder just left, so a wrong turn is one key to undo.
const up = (): void => {
    if (deskDir.value === workspaceDir.value) {
        return;
    }
    const from = deskDir.value;
    go(parentDir(from), `back`);
    selected.value = from;
};

// Whether the tree still knows a folder: walked, or listed by its parent's lazy load.
const known = (dir: string): boolean =>
    entriesByPath.value.has(dir) || (lazyChildren.value.get(parentDir(dir))?.some((entry) => entry.path === dir) ?? false);
// A folder deleted or renamed under the reader climbs to its nearest ancestor still there; never while the tree has
// yet to arrive, when nothing is known.
watch([children, () => tree.value.length], () => {
    if (tree.value.length === 0) {
        return;
    }
    let dir = deskDir.value;
    while (dir !== workspaceDir.value && !known(dir)) {
        dir = parentDir(dir);
    }
    if (dir !== deskDir.value) {
        go(dir, `back`);
    }
});

// --- Tiles ---------------------------------------------------------------------------------------------------------
const dimmed = (entry: WorkspaceTreeEntry): boolean => entry.ignored === true || entry.link?.state !== undefined;
// The tab stop: the marked tile, else the first, so Tab always enters somewhere.
const tabindexOf = (entry: WorkspaceTreeEntry): number =>
    selectedEntry.value === undefined ? (entry === order.value[0] ? 0 : -1) : selected.value === entry.path ? 0 : -1;
// A folder takes a drop itself; a file stands in for the folder holding it, as with paste.
const dropDirOf = (entry: WorkspaceTreeEntry): string => (entry.type === `dir` && entry.link?.state === undefined ? entry.path : deskDir.value);
// What a tile offers a move: that folder, unless the sandbox keeps it private or it is an archive's contents.
const dropTargetOf = (entry: WorkspaceTreeEntry): string | undefined => (noDrops(dropDirOf(entry)) ? undefined : dropDirOf(entry));
// A tile lights as a target for a move (useEntryDrag) or for OS files (dropDir); a file tile never does, its folder is the desk.
const targeted = (entry: WorkspaceTreeEntry): boolean => entry.type === `dir` && (dropDir.value === entry.path || over.value === entry.path);
// The release that ended a drag lands as a click on the tile it started on; it was a drop, not a pick.
const onTileSelect = (entry: WorkspaceTreeEntry, event: MouseEvent): void => {
    if (!consumeSuppressedClick()) {
        select(entry.path, event);
    }
};

const open = (entry: WorkspaceTreeEntry): void => {
    closePeek();
    // A locked folder opens its explanation like a locked file: there is nothing inside it to enter.
    if (locked(entry.path)) {
        openFile(entry.path, `keep`);
        return;
    }
    if (entry.type === `dir`) {
        if (entry.link?.state === undefined) {
            go(entry.path, `forward`);
        }
        return;
    }
    // A placeholder has no file behind it yet; opening one would read a path the daemon doesn't serve.
    if (pending(entry.path)) {
        return;
    }
    // A zip or tar is entered rather than opened: the daemon lists what is inside it as if it were this folder.
    if (opensAsFolder(entry)) {
        go(entry.path, `forward`);
        return;
    }
    openFile(entry.path, `keep`);
};

// --- The quick look ------------------------------------------------------------------------------------------------
// A short dwell before the first card, so a pointer crossing the desk raises nothing; once one is up, the next tile
// shows at once, and that readiness outlives a close by a moment, as tooltips do.
const OPEN_DELAY_MS = 160;
const CLOSE_DELAY_MS = 150;
const WARM_MS = 300;
const peekEntry = ref<WorkspaceTreeEntry>();
const peekAnchor = ref<HTMLElement>();
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
let warm = false;

const clearTimers = (): void => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
};
const showPeek = (entry: WorkspaceTreeEntry, el: HTMLElement): void => {
    clearTimeout(warmTimer);
    warm = true;
    peekEntry.value = entry;
    peekAnchor.value = el;
};
const closePeek = (): void => {
    clearTimers();
    if (peekEntry.value === undefined) {
        return;
    }
    peekEntry.value = undefined;
    peekAnchor.value = undefined;
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
        warm = false;
    }, WARM_MS);
};
const onTileEnter = (entry: WorkspaceTreeEntry, el: HTMLElement): void => {
    clearTimers();
    // Nothing to look into: the padlock and the placeholder say all there is; a drag or a rename is not a look.
    if (locked(entry.path) || pending(entry.path) || dragging.value || editing.value) {
        closePeek();
        return;
    }
    if (warm || peekEntry.value !== undefined) {
        showPeek(entry, el);
        return;
    }
    openTimer = setTimeout(() => showPeek(entry, el), OPEN_DELAY_MS);
};
const onTileLeave = (): void => {
    clearTimeout(openTimer);
    if (peekEntry.value !== undefined) {
        closeTimer = setTimeout(closePeek, CLOSE_DELAY_MS);
    }
};
onBeforeUnmount(() => {
    clearTimers();
    clearTimeout(warmTimer);
});

// --- Keyboard ------------------------------------------------------------------------------------------------------
// Only the drawn tiles are here to find, which is a screenful rather than the folder; a tile outside the window has no
// element until `bands.show` has brought its band in.
const tileEl = (path: string): HTMLElement | undefined =>
    [...(scroller.value?.querySelectorAll<HTMLElement>(`[data-desk-tile]`) ?? [])].find((el) => el.dataset[`deskTile`] === path);

// Lands on a tile by its place in desk order: scrolls its band in, waits for it to mount, then takes focus there.
// The wait is the whole point — focus() on a tile the window has not drawn would go nowhere.
const focusTile = async (index: number): Promise<void> => {
    const entry = order.value[index];
    if (entry === undefined) {
        return;
    }
    select(entry.path);
    await bands.show(bandOfIndex(gridLayout.value, index));
    tileEl(entry.path)?.focus({ preventScroll: true });
};

// Arrow travel lands the selection, the focus and the quick look on the same tile.
const moveSelection = async (key: GridKey): Promise<void> => {
    const index = order.value.findIndex((entry) => entry.path === selected.value);
    const at = moveInGrid(gridLayout.value, index, key);
    const next = order.value[at];
    if (next === undefined) {
        return;
    }
    await focusTile(at);
    const el = tileEl(next.path);
    if (el !== undefined) {
        onTileEnter(next, el);
    }
};
// Keys that leave the folder, drop the selection or open the tile; false for any other key.
const onNavigationKey = (event: KeyboardEvent): boolean => {
    if (event.key === `Backspace` || (event.altKey && event.key === `ArrowLeft`)) {
        event.preventDefault();
        up();
        return true;
    }
    if (event.key === `Escape`) {
        clear();
        closePeek();
        return true;
    }
    if (event.key === `Enter`) {
        if (selectedEntry.value !== undefined) {
            event.preventDefault();
            open(selectedEntry.value);
        }
        return true;
    }
    return false;
};
// A printable key with no chord held is typing, and on a file browser typing is filtering.
const typesIntoFilter = (event: KeyboardEvent): boolean =>
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && search !== undefined;
const onKeydown = (event: KeyboardEvent): void => {
    // The verbs first (Delete, F2, select all); while a name is being typed, every key is the field's.
    if (handleKey(event) || onNavigationKey(event)) {
        return;
    }
    if (isGridKey(event.key)) {
        event.preventDefault();
        void moveSelection(event.key);
        return;
    }
    if (typesIntoFilter(event)) {
        event.preventDefault();
        query.value += event.key;
        queryField.value?.focus();
    }
};
const onTile = (event: Event): boolean => event.target instanceof Element && event.target.closest(`[data-desk-tile]`) !== null;
// A click on the desk itself, not a tile, drops the selection, like clicking a desktop's wallpaper; it also parks
// focus here, so cut, copy and paste work right after clicking in.
const onBackgroundClick = (event: MouseEvent): void => {
    if (!onTile(event)) {
        clear();
        desk.value?.focus({ preventScroll: true });
    }
};
// A tile's own right-click reached its handler first; the background's menu is for the folder itself.
const onBackgroundMenu = (event: MouseEvent): void => {
    if (!onTile(event)) {
        openMenu(event, undefined);
    }
};
</script>

<template>
    <!-- The pane's own drop zone sits behind this one, so a drag that enters here is stopped from reaching it. -->
    <div
        ref="desk"
        class="relative flex h-full min-h-0 flex-col bg-canvas focus:outline-none"
        tabindex="-1"
        @keydown="onKeydown"
        @pointerdown="closePeek"
        @pointerleave="onTileLeave"
        @click="onBackgroundClick"
        @contextmenu="onBackgroundMenu"
        @copy="onCopyEvent($event, 'copy')"
        @cut="onCopyEvent($event, 'cut')"
        @paste="onPasteEvent"
        :data-drop-dir="noDrops(deskDir) ? undefined : deskDir"
        @dragenter.stop.prevent
        @dragover="onDragOver($event, deskDir)"
        @dragleave="onDragLeave($event, deskDir)"
        @drop="onDrop($event, deskDir)"
    >
        <!-- Where you are; the root wears the scope's own name. Outside the scrolling area, so a long folder keeps its way
             back in view without the tiles having to scroll under it. A crumb also takes a drop, which is how a tile moves
             up a level or two. -->
        <nav
            class="z-10 flex shrink-0 items-center gap-1 bg-canvas px-5 pt-4 pb-2 text-xs"
            :aria-label="t(`workspace.deskView.folderPath`)"
        >
            <template v-for="(crumb, index) in crumbs" :key="crumb.path">
                <Icon v-if="index > 0" name="chevron-right" class="text-[0.55rem] text-subtle" aria-hidden="true" />
                <span v-if="index === crumbs.length - 1" class="font-medium text-content" aria-current="location">{{ crumb.label }}</span>
                <button
                    v-else
                    type="button"
                    class="-mx-1 rounded px-1 text-muted transition-colors hover:text-content"
                    :class="{ 'ui-row-select-drop': dropDir === crumb.path || over === crumb.path }"
                    :data-drop-dir="noDrops(crumb.path) ? undefined : crumb.path"
                    @click="go(crumb.path, 'back')"
                    @dragover="onDragOver($event, crumb.path)"
                    @dragleave="onDragLeave($event, crumb.path)"
                    @drop="onDrop($event, crumb.path)"
                >
                    {{ crumb.label }}
                </button>
            </template>
            <!-- Says why there is no New File here and why a drop bounces; the menu's own note only shows on a right-click. -->
            <span v-if="archiveHere" class="ui-chip ml-2 h-5 shrink-0 gap-1 px-1.5 text-2xs text-muted">
                <Icon name="box" aria-hidden="true" />
                {{ t(`workspace.deskView.readOnly`) }}
            </span>
            <!-- The sidebar's query, here too; the placeholder names the scope the sidebar set, since it may be closed. -->
            <div v-if="search !== undefined" class="ml-auto flex items-center gap-2 pl-4">
                <span v-if="querying && !searching" class="text-2xs tabular-nums text-subtle"
                    >{{ results.length.toLocaleString() }}{{ results.length >= RESULTS_CAP ? "+" : "" }}</span
                >
                <div class="relative">
                    <Icon
                        class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-2xs text-subtle"
                        aria-hidden="true"
                        :name="searching ? `spinner` : `search`"
                        :spin="searching"
                    />
                    <input
                        ref="queryField"
                        v-model="query"
                        type="text"
                        :placeholder="placeholder"
                        :aria-label="placeholder"
                        class="ui-field-box ui-field-sm w-44 min-w-0 pr-6 pl-7"
                        @keydown.stop="onFieldKey"
                        @click.stop
                        @contextmenu.stop
                    />
                    <button
                        v-if="query"
                        type="button"
                        class="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                        :aria-label="t(`workspace.deskView.clearFilter`)"
                        @click.stop="clearQuery"
                    >
                        <Icon name="times" />
                    </button>
                </div>
            </div>
        </nav>

        <!-- The tiles scroll under the breadcrumb rather than with it, so the window measures this element alone. -->
        <div ref="scroller" class="relative min-h-0 flex-1 overflow-auto" @scroll.passive="bands.onScroll(); closePeek()">
            <!-- The measure: one tile and one label wearing the real classes, laid out but not painted. Outside the
                 Transition, so a folder change cannot swap the element out from under the observer, and the column count
                 and band heights stay the stylesheet's to decide rather than constants kept in the script. -->
            <div class="pointer-events-none invisible absolute inset-x-0 top-0 px-4" aria-hidden="true">
                <div ref="probeGrid" class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5">
                    <div class="flex w-full flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2 text-center" ref="probeTile">
                        <span class="flex h-14 w-full items-center justify-center"></span>
                        <span class="h-[2.75em] w-full text-xs leading-snug"></span>
                        <span v-if="querying" class="w-full text-2xs">&nbsp;</span>
                    </div>
                </div>
                <h3 ref="probeLabel" class="px-2 pt-3 pb-1 text-2xs text-muted">&nbsp;</h3>
            </div>

            <!-- Keyed on the folder: a change slides the old tiles out and the new ones in, a step in the direction travelled. -->
            <Transition
                mode="out-in"
                enter-active-class="ui-desk-move"
                :enter-from-class="direction === 'forward' ? 'opacity-0 translate-x-3' : 'opacity-0 -translate-x-3'"
                leave-active-class="ui-desk-move"
                :leave-to-class="direction === 'forward' ? 'opacity-0 -translate-x-2' : 'opacity-0 translate-x-2'"
                @after-leave="bands.toTop()"
            >
                <div :key="deskDir" class="px-4 pb-6" role="listbox" aria-multiselectable="true" :aria-label="t(`workspace.deskView.contents`, { here })">
                <!-- A wait long enough to show: tile-shaped placeholders, still. -->
                <div v-if="revealed" class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5" aria-hidden="true">
                    <div v-for="index in 8" :key="index" class="flex flex-col items-center gap-2 px-2 pt-3 pb-2">
                        <div class="skeleton h-9 w-9 rounded-lg"></div>
                        <div class="skeleton h-3 w-14"></div>
                    </div>
                </div>
                <template v-else>
                    <!-- The entry being named, drawn first in the open folder before it exists; the field owns its keys. -->
                    <div v-if="creating !== undefined" class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5 pt-3">
                        <div class="flex flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2">
                            <span class="flex h-14 items-center justify-center">
                                <Icon :name="creating === 'dir' ? 'folder' : 'file'" class="text-[2.125rem] text-muted" />
                            </span>
                            <input
                                v-model="createDraft"
                                type="text"
                                :aria-label="creating === 'dir' ? t(`workspace.deskView.newFolderName`) : t(`workspace.deskView.newFileName`)"
                                class="ui-field-box ui-field-inline w-full min-w-0 px-1 text-center text-xs"
                                :class="createError !== undefined ? 'ui-field-error-box' : ''"
                                @click.stop
                                @keydown.stop
                                @keydown.enter.prevent="commitCreate"
                                @keydown.esc.prevent="cancelCreate"
                                @blur="createError !== undefined ? cancelCreate() : commitCreate()"
                                @vue:mounted="focusField"
                            />
                            <p v-if="createError !== undefined" class="text-center text-2xs text-danger">{{ createError }}</p>
                        </div>
                    </div>
                    <p v-if="order.length === 0 && !loading && !searching && creating === undefined" class="py-12 text-center text-xs text-subtle">
                        {{ querying ? t(`workspace.deskView.nothingMatchesIn`, { trim: query.trim(), here }) : t(`workspace.deskView.nothingHere`) }}
                    </p>
                    <!-- Only the bands crossing the viewport are drawn; the spacer carries the rest of the folder's height,
                         so the scrollbar still measures all of it. A label band is a group's heading, a tile band one row. -->
                    <div class="relative" :style="{ height: `${deskHeight}px` }">
                        <template v-for="{ band, top } in painted" :key="band.key">
                            <!-- Named only when there is a second kind to tell apart; a folder of one kind reads without a label. -->
                            <h3 v-if="band.kind === 'label'" class="absolute inset-x-0 px-2 pt-3 pb-1 text-2xs text-muted" :style="{ top: `${top}px` }">
                                {{ band.label }}
                            </h3>
                            <div
                                v-else
                                class="absolute inset-x-0 grid gap-0.5"
                                :style="{ top: `${top}px`, gridTemplateColumns: `repeat(${gridLayout.columns}, minmax(0, 1fr))` }"
                            >
                                <DeskTile
                                    v-for="(entry, column) in band.entries"
                                    :key="entry.path"
                                    v-model:draft="renameDraft"
                                    :entry="entry"
                                    :where="querying ? (whereByPath.get(entry.path) ?? '') : undefined"
                                    :aria-setsize="gridLayout.count"
                                    :aria-posinset="band.start + column + 1"
                                    :selected="marked.has(entry.path)"
                                :locked="locked(entry.path)"
                                :pending="pending(entry.path)"
                                :dimmed="dimmed(entry)"
                                :tabindex="tabindexOf(entry)"
                                :renaming="renaming === entry.path"
                                :drop-dir="dropTargetOf(entry)"
                                :drop-target="targeted(entry)"
                                :dragging="dragging && dragPaths.includes(entry.path)"
                                @select="(event) => onTileSelect(entry, event)"
                                @open="open(entry)"
                                @enter="(el) => onTileEnter(entry, el)"
                                @leave="onTileLeave"
                                @contextmenu="(event) => openMenu(event, entry)"
                                @commit="commitRename"
                                @cancel="cancelRename"
                                @pointerdown="(event) => onPointerDown(event, entry)"
                                @dragover="(event) => onDragOver(event, dropDirOf(entry))"
                                @dragleave="(event) => onDragLeave(event, dropDirOf(entry))"
                                    @drop="(event) => onDrop(event, dropDirOf(entry))"
                                />
                            </div>
                        </template>
                    </div>
                </template>
                    <p v-if="hiddenTooling > 0 && !querying" class="px-2 pt-4 text-2xs text-subtle">
                        {{ t(`workspace.deskView.toolingHidden`, { count: hiddenTooling.toLocaleString() }, hiddenTooling) }}
                    </p>
                    <p v-if="hiddenByCap > 0 && !querying" class="px-2 pt-4 text-2xs text-subtle">
                        {{ t(`workspace.deskView.moreEntries`, { count: hiddenByCap.toLocaleString() }, hiddenByCap) }}
                    </p>
                </div>
            </Transition>
        </div>

        <!-- A drop on the desk itself lands in the open folder; the pill says so while a drag is over it and no tile has it. -->
        <div
            v-if="dropDir === deskDir || (dragging && over === deskDir)"
            class="pointer-events-none sticky inset-x-0 bottom-0 z-10 flex justify-center pb-3"
            aria-hidden="true"
        >
            <span class="rounded-full border border-primary-500/60 bg-canvas/90 px-3 py-1 text-2xs font-medium text-primary-500 backdrop-blur">
                {{ dragging ? t(`workspace.deskView.moveInto`, { here }) : t(`workspace.deskView.dropToAddTo`, { here }) }}
            </span>
        </div>

        <DeskPeek :entry="peekEntry" :anchor="peekAnchor" />
        <ContextMenu ref="menu" :model="menuItems" :min-width="10" />
        <ConfirmDialog
            :open="confirmPaths !== undefined"
            :header="deleteTitle"
            :confirm-label="t(`ui.action.delete`)"
            confirm-icon="trash"
            :items="confirmPaths ?? []"
            @cancel="cancelDelete"
            @confirm="confirmDelete"
        >
            <template #item="{ item }">
                <Icon :name="iconForEntry(basename(item), entriesByPath.get(item)?.type ?? 'file')" class="shrink-0 text-xs text-muted" />
                <span class="truncate text-content">{{ basename(item) }}</span>
                <span v-if="parentDir(item) !== ''" class="min-w-0 truncate text-xs text-subtle">{{ parentDir(item) }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">{{ t(`workspace.deskView.cantUndone`) }}</p>
        </ConfirmDialog>
    </div>
</template>
