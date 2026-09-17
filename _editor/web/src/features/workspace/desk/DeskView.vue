<!-- The desk: the folder being looked at as large tiles, folders first and files by kind, with a quick look on hover. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { useLoadingReveal } from "@intentic/ui";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useLayout } from "../../../shell/window/useLayout";
import { type ExplorerFilters, explorerShows, technicalHidden } from "../explorer/explorerFilter";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { provisionalAt, withProvisionalEntries } from "../files/provisionalEntries";
import { workspaceDir } from "../health/workspaceScope";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { isGridKey, moveInGrid, type TileBox } from "./deskGrid";
import { deskGroups, deskOrder, labelsShown } from "./deskOrder";
import { useDesk } from "./useDesk";
import DeskPeek from "./DeskPeek.vue";
import DeskTile from "./DeskTile.vue";

// Drawn by EditorPane in place of the empty state while the desk preference is on. Reads the same tree the explorer
// draws, opens files into the same tabs; owns only which folder is open, the selection and the quick look.

const { deskDir, openDir } = useDesk();
const { tree, entriesByPath, lazyChildren, lazyHidden, lazyLoading, rootHidden, loadChildren, isLoading } = useWorkspaceTree();
const { openFile } = useWorkspaceTabs();
const layout = useLayout();

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

const shown = computed(() => withProvisionalEntries(deskDir.value, children.value ?? []).filter((entry) => explorerShows(entry, filters.value)));
const groups = computed(() => deskGroups(shown.value));
const order = computed(() => deskOrder(groups.value));
const showLabels = computed(() => labelsShown(groups.value));
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

// Forward slides the tiles in from the right, back from the left: the direction the breadcrumb reads in.
const direction = ref<"forward" | "back">(`forward`);
const selected = ref<string>();
const selectedEntry = computed(() => order.value.find((entry) => entry.path === selected.value));
const scroller = ref<HTMLElement>();
const go = (dir: string, toward: "forward" | "back"): void => {
    closePeek();
    selected.value = undefined;
    direction.value = toward;
    openDir(dir);
    // The tile that had the keyboard is about to unmount; the desk itself keeps it, so the next key still lands here.
    if (scroller.value?.contains(document.activeElement) === true) {
        scroller.value.focus({ preventScroll: true });
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
const locked = (path: string): boolean => isLockedWorkspacePath(path);
const pending = (path: string): boolean => !entriesByPath.value.has(path) && provisionalAt(path) !== undefined;
const dimmed = (entry: WorkspaceTreeEntry): boolean => entry.ignored === true || entry.link?.state !== undefined;
const tabindexOf = (entry: WorkspaceTreeEntry): number => (selected.value === undefined ? (entry === order.value[0] ? 0 : -1) : selected.value === entry.path ? 0 : -1);

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
    if (!pending(entry.path)) {
        openFile(entry.path, `keep`);
    }
};

// --- The quick look ------------------------------------------------------------------------------------------------
// A dwell before the first card, so a pointer crossing the desk raises nothing; once one is up, the next tile shows
// at once, and that readiness outlives a close by a moment, as tooltips do.
const OPEN_DELAY_MS = 450;
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
    // Nothing to look into: the padlock and the placeholder say all there is.
    if (locked(entry.path) || pending(entry.path)) {
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
const tileEls = (): HTMLElement[] => [...(scroller.value?.querySelectorAll<HTMLElement>(`[data-desk-tile]`) ?? [])];
const tileBoxes = (): TileBox[] => tileEls().map((el) => el.getBoundingClientRect());
const tileEl = (path: string): HTMLElement | undefined => tileEls().find((el) => el.dataset[`deskTile`] === path);

// Arrow travel lands the selection, the focus and the quick look on the same tile.
const moveSelection = (key: Parameters<typeof moveInGrid>[2]): void => {
    const index = order.value.findIndex((entry) => entry.path === selected.value);
    const next = order.value[moveInGrid(tileBoxes(), index, key)];
    if (next === undefined) {
        return;
    }
    selected.value = next.path;
    const el = tileEl(next.path);
    if (el === undefined) {
        return;
    }
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: `nearest` });
    onTileEnter(next, el);
};
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Backspace` || (event.altKey && event.key === `ArrowLeft`)) {
        event.preventDefault();
        up();
        return;
    }
    if (event.key === `Escape`) {
        selected.value = undefined;
        closePeek();
        return;
    }
    if (event.key === `Enter` && selectedEntry.value !== undefined) {
        event.preventDefault();
        open(selectedEntry.value);
        return;
    }
    if (isGridKey(event.key)) {
        event.preventDefault();
        moveSelection(event.key);
    }
};
// A click on the desk itself, not a tile, drops the selection, like clicking a desktop's wallpaper.
const onBackgroundClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || event.target.closest(`[data-desk-tile]`) === null) {
        selected.value = undefined;
    }
};
</script>

<template>
    <div
        ref="scroller"
        class="relative h-full min-h-0 overflow-auto bg-canvas"
        tabindex="-1"
        @keydown="onKeydown"
        @pointerdown="closePeek"
        @pointerleave="onTileLeave"
        @scroll.passive="closePeek"
        @click="onBackgroundClick"
    >
        <!-- Where you are; the root wears the scope's own name. Sticky, so a long folder keeps its way back in view. -->
        <nav class="sticky top-0 z-10 flex items-center gap-1 bg-canvas/85 px-5 pt-4 pb-2 text-xs backdrop-blur" aria-label="Folder path">
            <template v-for="(crumb, index) in crumbs" :key="crumb.path">
                <Icon v-if="index > 0" name="chevron-right" class="text-[0.55rem] text-subtle" aria-hidden="true" />
                <span v-if="index === crumbs.length - 1" class="font-medium text-content" aria-current="location">{{ crumb.label }}</span>
                <button v-else type="button" class="-mx-1 rounded px-1 text-muted transition-colors hover:text-content" @click="go(crumb.path, 'back')">
                    {{ crumb.label }}
                </button>
            </template>
        </nav>

        <!-- Keyed on the folder: a change slides the old tiles out and the new ones in, a step in the direction travelled. -->
        <Transition
            mode="out-in"
            enter-active-class="ui-desk-move"
            :enter-from-class="direction === 'forward' ? 'opacity-0 translate-x-3' : 'opacity-0 -translate-x-3'"
            leave-active-class="ui-desk-move"
            :leave-to-class="direction === 'forward' ? 'opacity-0 -translate-x-2' : 'opacity-0 translate-x-2'"
            @after-leave="scroller?.scrollTo(0, 0)"
        >
            <div :key="deskDir" class="px-4 pb-6" role="listbox" :aria-label="`Contents of ${here}`">
                <!-- A wait long enough to show: tile-shaped placeholders, still. -->
                <div v-if="revealed" class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5" aria-hidden="true">
                    <div v-for="index in 8" :key="index" class="flex flex-col items-center gap-2 px-2 pt-3 pb-2">
                        <div class="skeleton h-9 w-9 rounded-lg"></div>
                        <div class="skeleton h-3 w-14"></div>
                    </div>
                </div>
                <p v-else-if="order.length === 0 && !loading" class="py-12 text-center text-xs text-subtle">Nothing here.</p>
                <template v-else>
                    <section v-for="group in groups" :key="group.key">
                        <!-- Named only when there is a second kind to tell apart; a folder of one kind reads without a label. -->
                        <h3 v-if="showLabels" class="px-2 pt-3 pb-1 text-2xs text-muted">
                            {{ group.label }} <span class="text-subtle">{{ group.entries.length }}</span>
                        </h3>
                        <div class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5">
                            <DeskTile
                                v-for="entry in group.entries"
                                :key="entry.path"
                                :entry="entry"
                                :selected="selected === entry.path"
                                :locked="locked(entry.path)"
                                :pending="pending(entry.path)"
                                :dimmed="dimmed(entry)"
                                :tabindex="tabindexOf(entry)"
                                @select="selected = entry.path"
                                @open="open(entry)"
                                @enter="(el) => onTileEnter(entry, el)"
                                @leave="onTileLeave"
                            />
                        </div>
                    </section>
                </template>
                <p v-if="hiddenTooling > 0" class="px-2 pt-4 text-2xs text-subtle">
                    {{ hiddenTooling.toLocaleString() }} tooling {{ hiddenTooling === 1 ? "file" : "files" }} hidden
                </p>
                <p v-if="hiddenByCap > 0" class="px-2 pt-4 text-2xs text-subtle">
                    {{ hiddenByCap.toLocaleString() }} more {{ hiddenByCap === 1 ? "entry" : "entries" }} in this folder, search to reach them
                </p>
            </div>
        </Transition>

        <DeskPeek :entry="peekEntry" :anchor="peekAnchor" />
    </div>
</template>
