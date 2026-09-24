<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import {
    ConfirmDialog,
    ContextMenu,
    type ExplorerTreatment,
    explorerTreatment,
    iconForEntry,
    type IconName,
    useExplorerStyle,
    vAction,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { nextTick } from "vue";
import { useVocabulary } from "../../../core-views/vocabulary";
import { useNotifications } from "../../../shell/notifications/notifications";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import { viewersOfPath } from "../../../shell/presence/usePresence";
import { useLayout } from "../../../shell/window/useLayout";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { isRecentlyChanged } from "../changes/live/useWorkspaceLive";
import { lensRefuses } from "../directory-ui/personaReach";
import { useUploadQueue } from "../files/upload/useUploadQueue";
import type { OpenMode } from "../tabs/workspaceTabs";
import { ancestorDirs } from "./revealPath";
import type { RowAction } from "./rowActions";
import { specialChip } from "./specialPaths";
import { deadLink, dropDirOf, linkTooltip, provisionalTooltip, type Row } from "./tree/treeRows";
import { useTreeDelete } from "./tree/useTreeDelete";
import { focusField, useInlineEdit, useTreeEdits } from "./tree/useTreeEdits";
import { useTreeGestures } from "./tree/useTreeGestures";
import { useTreeMenu } from "./tree/useTreeMenu";
import { useTreeReveal } from "./tree/useTreeReveal";
import { useTreeRows } from "./tree/useTreeRows";
import { useTreeRules } from "./tree/useTreeRules";
import { useTreeSelection } from "./tree/useTreeSelection";
import { useTreeTransfer } from "./tree/useTreeTransfer";
import { useTreeWindow } from "./tree/useTreeWindow";
import { useEmptyDirs } from "./useEmptyDirs";
import { useFileNesting } from "./useFileNesting";
import { useWorkspaceTree } from "./useWorkspaceTree";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";

// Recursive file tree and file-management surface: verbs act on the whole selection via useWorkspaceTree, with a file
// standing in for its parent directory as a target. Template and wiring: what the tree draws and what every gesture
// means are the headless modules in `tree/`.

const t = useT();

const {
    tree,
    rootDir = ``,
    rootHidden = 0,
    barren = [],
    filter = ``,
    selectedPath,
    manageableDirs = new Set<string>(),
    rowActions,
} = defineProps<{
    tree: readonly WorkspaceTreeEntry[];
    // The folder `tree` is the contents of, "" for the workspace root: where a create or a drop with no target lands.
    rootDir?: string;
    // How many of the root's own entries the daemon's entry budget cut (0 = the root listing is complete).
    rootHidden?: number;
    // Complete for the whole workspace, unlike `tree`, which stops at the daemon's listing budget.
    barren?: readonly string[];
    filter?: string;
    selectedPath?: string | null;
    // Dirs with a management surface; keyboard activation also opens the operator tab via the row's cog action.
    manageableDirs?: ReadonlySet<string>;
    // Per-directory actions from extensions; a function, not a map, since rows load lazily and can't be enumerated.
    rowActions?: (dir: string) => readonly RowAction[];
}>();
// `openFile`'s `mode` is the gesture (a click previews, a double-click keeps); `pick` is the click or Enter itself.
const emit = defineEmits<{ openFile: [path: string, mode: OpenMode]; openDirectory: [path: string]; pick: [entry: WorkspaceTreeEntry]; clear: [] }>();

const store = useWorkspaceTree();
const { clipboard, lazyLoading } = store;
const layout = useLayout();
const words = useVocabulary();
const uploads = useUploadQueue();
const { say } = useNotifications();
const { fileNesting } = useFileNesting();
// Settled folders holding only empty folders; tracked by path since `tree`'s listing may not reach every branch here.
const emptyDirs = useEmptyDirs(() => barren);

const { byPath, childrenOf, visibleRows, orderedPaths, technicalCount, targetDir, expandable, toggleExpand, openAll, openNest, openLanding } =
    useTreeRows({
        tree: () => tree,
        rootDir: () => rootDir,
        rootHidden: () => rootHidden,
        filter: () => filter,
        filters: layout.explorerFilters,
        nesting: fileNesting,
        store,
        emptyDirs,
    });
const rules = useTreeRules({ byPath, store });
const { pendingRow, pending, dropTargetOf } = rules;
// An arriving row holding nothing a press can reach: a pending file, not a pending folder, which still expands.
const notYetOpenable = (row: Row): boolean => pending(row.entry.path) && !expandable(row);
const { personas } = usePersonas();
// Only dims the rows the read-as persona's fence refuses: a lens must not restrict the actual user.
const refused = (path: string): boolean => lensRefuses(personas.value, path);
const selecting = useTreeSelection({ selectedPath: () => selectedPath, order: orderedPaths });
const { selection, lead, tabbablePath } = selecting;
const inline = useInlineEdit((path) => byPath.value.has(path));
const { edit, draft, createError, editing } = inline;
const { scroller, treeEl, preamble, probeRow, rowHeight, createBlock, painted, treeHeight, onScroll, setRowEl, showRow, focusLead, focusRow } =
    useTreeWindow({
        rows: visibleRows,
        lead,
        edit,
        createError,
    });
useTreeReveal({ selectedPath: () => selectedPath, rows: visibleRows, tree: () => tree, byPath, childrenOf, nesting: fileNesting, openAll, showRow });

const { beginRename, beginCreate, endEdit } = useTreeEdits({
    inline,
    byPath,
    rules,
    targetDir,
    openLanding,
    selectSingle: selecting.selectSingle,
    focusLead,
    store,
    openCreated: (path) => {
        emit(`openFile`, path, `keep`);
        layout.setEditMode(true);
    },
});
const { confirmPaths, deleteTitle, requestDelete, confirmDelete, keepFolder, sweepOpen, pointedBarren, barrenBranches, soleBarren, sweepAll } =
    useTreeDelete({
        byPath,
        targetDir,
        rules,
        emptyDirs,
        selecting,
        store,
        say,
    });
// Opens the way down to an empty folder, selects it and brings its row on screen; the keyboard stays with the sweep line.
const revealBarren = async (path: string): Promise<void> => {
    openAll(ancestorDirs(path));
    selecting.selectSingle(path);
    await nextTick();
    await showRow(path);
};
// Reads `soleBarren` here, since a template closure would read it outside the `v-if` proving it.
const revealSoleBarren = (): Promise<void> => (soleBarren.value === undefined ? Promise.resolve() : revealBarren(soleBarren.value.path));
const { stage, paste, extract, onCopyEvent, onPasteEvent, onPointerDown, carried, dropLit, onDragOver, onDragLeave, onDrop } = useTreeTransfer({
    tree: () => tree,
    rootDir: () => rootDir,
    byPath,
    childrenOf,
    targetDir,
    openLanding,
    openNest,
    rules,
    selecting,
    inline,
    el: treeEl,
    store,
    uploads,
    say,
});
const { onRowClick, onRowDblClick, onChevronClick, onBackgroundClick, onKeydown } = useTreeGestures({
    rows: visibleRows,
    order: orderedPaths,
    byPath,
    manageableDirs: () => manageableDirs,
    selecting,
    pending,
    toggleExpand,
    editing,
    beginRename,
    requestDelete,
    focusRow,
    focusLead,
    openFile: (path, mode) => emit(`openFile`, path, mode),
    openDirectory: (path) => emit(`openDirectory`, path),
    pick: (entry) => emit(`pick`, entry),
    cleared: () => emit(`clear`),
});

// A row's own affordances, or none when the parent supplied no source (the mobile listing, a test).
const actionsFor = (path: string): readonly RowAction[] => rowActions?.(path) ?? [];
const terminalPanel = useTerminalPanel();
const { menu, menuItems, openMenu, runAction } = useTreeMenu({
    rootDir: () => rootDir,
    rowActions: actionsFor,
    isBarren: emptyDirs.isBarren,
    rules,
    selecting,
    store,
    beginCreate,
    beginRename,
    extract,
    keepFolder,
    requestDelete,
    stage,
    paste,
    openTerminal: (dir) => terminalPanel.spawnShell(dir),
    frame: () => ({
        tail:
            store.expanded.value.size > 0
                ? [{ label: t(`workspace.workspaceTree.collapseFolders`), icon: `collapse-all`, command: store.collapseAll }]
                : [],
    }),
});

// The active file-tree setup (minimal/colorful/vivid): size, colour and folder emphasis for every row.
const { explorerStyle } = useExplorerStyle();
// A barren row dims like an ignored one: nothing is at risk, so it reads as a fact, not an alarm. A locked row wears a
// padlock instead of its own icon.
const treat = (row: Row): ExplorerTreatment => {
    const treatment = explorerTreatment(
        explorerStyle.value,
        row.entry.name,
        row.entry.type,
        row.isExpanded,
        row.entry.ignored === true || row.barren === true,
    );
    return isLockedWorkspacePath(row.entry.path) ? { ...treatment, icon: `lock` satisfies IconName, colorClass: `text-subtle` } : treatment;
};
// Icon resting opacity: hidden for an action, dimmed for evidence there's a page, full for the selected row.
const restingClass = (action: RowAction, path: string): string =>
    selection.value.has(path) ? `opacity-100` : action.standing ? `opacity-40` : `pointer-events-none opacity-0`;
</script>

<template>
    <!-- Sweep line is a sibling of the `role="tree"` element, not nested inside it, so it isn't read as a stray treeitem.
         This element is the scrollport: the window measures against it, and the sweep line sticks to its bottom edge. -->
    <div ref="scroller" class="flex h-full min-h-0 flex-col overflow-auto" @scroll.passive="onScroll()">
        <div
            ref="treeEl"
            class="flex-1 pb-1 focus:outline-none"
            role="tree"
            aria-multiselectable="true"
            tabindex="-1"
            :data-drop-dir="rootDir"
            @keydown="onKeydown"
            @mousedown.self="treeEl?.focus()"
            @click.self="onBackgroundClick"
            @copy="onCopyEvent($event, 'copy')"
            @cut="onCopyEvent($event, 'cut')"
            @paste="onPasteEvent"
            @contextmenu.self.prevent="openMenu($event, undefined)"
        >
            <!-- Everything above the first row, in one element the window measures so it knows where the rows start. -->
            <div ref="preamble">
                <div class="h-1"></div>
                <!-- Phantom create row at the tree's own root, the open project's folder when one is (also covers an empty
                     workspace). The root draws no row of its own, so this is the only place its input can sit. -->
                <div v-if="edit.kind === 'creating' && edit.dir === rootDir" class="flex flex-col" style="padding-left: 0.5rem">
                    <div class="flex items-center gap-1.5 py-1 pr-2">
                        <span class="w-[0.7rem] shrink-0"></span>
                        <Icon class="shrink-0 text-2xs text-muted" :name="edit.type === 'dir' ? 'folder' : 'file'" />
                        <input
                            v-model="draft"
                            type="text"
                            :aria-label="edit.type === 'dir' ? t(`shared.newFolderName`) : t(`shared.newFileName`)"
                            class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-[0.8125rem]"
                            :class="createError !== undefined ? 'ui-field-error-box' : ''"
                            @click.stop
                            @keydown.enter.prevent="endEdit('commit')"
                            @keydown.esc.prevent="endEdit('cancel')"
                            @blur="endEdit('blur')"
                            @vue:mounted="focusField"
                        />
                    </div>
                    <p v-if="createError !== undefined" class="pb-1 pl-[1.35rem] text-2xs text-danger">{{ createError }}</p>
                </div>
            </div>

            <!-- One row wearing the real classes, laid out but not painted: what a row's height is, asked of the
                 stylesheet rather than written down here, so a text-size change moves the window with it. -->
            <div class="pointer-events-none invisible absolute" aria-hidden="true">
                <div ref="probeRow" class="flex items-center gap-1.5 py-0.5 pr-2 text-[0.8125rem]">
                    <span class="w-[0.7rem] shrink-0"></span>
                    <span>&nbsp;</span>
                </div>
            </div>

            <!-- Only the rows crossing the viewport are built; the spacer carries the rest of the height, so the
                 scrollbar still measures the whole tree. -->
            <div class="relative" :style="{ height: `${treeHeight}px` }">
                <template v-for="{ row, top } in painted" :key="'more' in row ? row.key : row.entry.path">
                    <div
                        v-if="'more' in row"
                        class="absolute inset-x-0 flex items-center gap-1.5 pr-2 text-2xs italic text-subtle select-none"
                        :style="{ top: `${top}px`, height: `${rowHeight}px`, paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
                        v-tooltip.top="t(`workspace.workspaceTree.searchCtrlP`)"
                    >
                        <span class="w-[0.7rem] shrink-0"></span>
                        <span class="min-w-0 flex-1 truncate">{{
                            t(`workspace.workspaceTree.moreItems`, { count: row.more.toLocaleString() }, row.more)
                        }}</span>
                    </div>
                    <template v-else>
                        <button
                            :ref="(el) => setRowEl(row.entry.path, el)"
                            type="button"
                            role="treeitem"
                            :aria-selected="selection.has(row.entry.path)"
                            :aria-expanded="expandable(row) ? row.isExpanded : undefined"
                            :aria-disabled="notYetOpenable(row) || undefined"
                            :tabindex="tabbablePath === row.entry.path ? 0 : -1"
                            :data-drop-dir="dropTargetOf(row)"
                            class="ui-row-select group absolute inset-x-0 flex items-center gap-1.5 pr-2 text-left text-[0.8125rem]"
                            :class="{
                                'ui-row-select-on': selection.has(row.entry.path),
                                'ui-row-select-pointed': row.entry.path === pointedBarren,
                                'ui-row-select-drop': dropLit(row.entry.path),
                                'ui-row-select-changed': isRecentlyChanged(row.entry.path),
                                'opacity-50': clipboard?.mode === 'cut' && clipboard.paths.includes(row.entry.path),
                                'opacity-40': carried(row.entry.path),
                                'ui-row-select-arriving': pending(row.entry.path),
                            }"
                            v-tooltip.right="provisionalTooltip(pendingRow(row.entry.path))"
                            :style="{ top: `${top}px`, height: `${rowHeight}px`, paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
                            @click="onRowClick($event, row)"
                            @dblclick="onRowDblClick(row)"
                            @contextmenu.prevent.stop="openMenu($event, row.entry)"
                            @pointerdown="onPointerDown($event, row.entry.path)"
                            @dragstart.prevent
                            @dragover="onDragOver($event, dropDirOf(row))"
                            @dragleave="onDragLeave($event, dropDirOf(row))"
                            @drop="onDrop($event, dropDirOf(row))"
                        >
                            <!-- Locked and empty folders have no expandable child. -->
                            <span
                                v-if="expandable(row)"
                                class="tree-chevron relative flex w-[0.7rem] shrink-0 items-center justify-center self-stretch"
                                @click="onChevronClick($event, row)"
                            >
                                <Icon class="text-[0.6rem] text-subtle" :name="row.isExpanded ? 'chevron-down' : 'chevron-right'" />
                            </span>
                            <span v-else class="w-[0.7rem] shrink-0"></span>
                            <!-- Row icons use explorer sizing; locked rows show a padlock. -->
                            <span
                                class="flex shrink-0 items-center justify-center"
                                :class="treat(row).slotClass"
                                v-tooltip.right="isLockedWorkspacePath(row.entry.path) ? t(`shared.keptPrivateBySandbox`) : undefined"
                            >
                                <Icon :name="treat(row).icon" :class="[treat(row).sizeClass, treat(row).colorClass]" />
                            </span>
                            <input
                                v-if="edit.kind === 'renaming' && edit.path === row.entry.path"
                                v-model="draft"
                                type="text"
                                class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-[0.8125rem]"
                                @click.stop
                                @keydown.enter.prevent="endEdit('commit')"
                                @keydown.esc.prevent="endEdit('cancel')"
                                @blur="endEdit('blur')"
                                @vue:mounted="focusField"
                            />
                            <!-- Collapsed barren chains act as one selectable path. -->
                            <span
                                v-else
                                class="min-w-0 flex-1 truncate"
                                :class="[
                                    row.entry.ignored ||
                                    row.barren ||
                                    isLockedWorkspacePath(row.entry.path) ||
                                    deadLink(row.entry) ||
                                    pending(row.entry.path)
                                        ? 'text-subtle'
                                        : 'text-content/90',
                                    // Out of the persona being read as: dimmed FURTHER, and only while a lens is on.
                                    // Opacity rather than a colour, so it stacks on whatever the row already was:
                                    // an ignored row outside the fence should read as both, not as one of the two.
                                    refused(row.entry.path) ? 'opacity-40' : '',
                                ]"
                                >{{ row.chain !== undefined ? row.chain.join(" / ") : row.entry.name }}</span
                            >
                            <!-- Symlink badge after the name, since the row already wears the target's icon; hover shows where it points. -->
                            <Icon
                                v-if="row.entry.link !== undefined"
                                :name="deadLink(row.entry) ? 'link-broken' : 'link'"
                                aria-hidden="true"
                                class="shrink-0 text-2xs"
                                :class="deadLink(row.entry) ? 'text-warning' : 'text-subtle'"
                                v-tooltip.right="linkTooltip(row.entry.link)"
                            />
                            <!-- What the sandbox does with this entry, which its name doesn't say (specialPaths.ts); hover gives the rule. -->
                            <span
                                v-if="specialChip(row.entry.path, words)"
                                class="ui-status-pill shrink-0 text-2xs font-medium"
                                :class="
                                    specialChip(row.entry.path, words)?.tone === `warning` ? `bg-warning/10 text-warning` : `bg-subtle/10 text-subtle`
                                "
                                v-tooltip.right="specialChip(row.entry.path, words)?.tooltip"
                                >{{ specialChip(row.entry.path, words)?.label }}</span
                            >
                            <!-- A dir fetching its children lazily on expand (ignored, or below the walk's budget). -->
                            <Icon
                                v-if="row.entry.type === 'dir' && lazyLoading.has(row.entry.path)"
                                name="spinner"
                                :spin="true"
                                aria-hidden="true"
                                class="shrink-0 text-2xs text-subtle"
                            />
                            <!-- Still on its way in: sending, or on disk with the workspace listing yet to catch up. -->
                            <Icon
                                v-if="pendingRow(row.entry.path)?.state === 'failed'"
                                name="exclamation-triangle"
                                aria-hidden="true"
                                class="shrink-0 text-2xs text-danger"
                            />
                            <Icon
                                v-else-if="pending(row.entry.path)"
                                name="spinner"
                                :spin="true"
                                aria-hidden="true"
                                class="shrink-0 text-2xs text-subtle"
                            />
                            <!-- Row actions appear on hover or selection and use the row handlers. -->
                            <Icon
                                v-for="action in row.entry.type === 'dir' ? actionsFor(row.entry.path) : []"
                                :key="action.id"
                                :name="action.icon"
                                aria-hidden="true"
                                class="shrink-0 cursor-pointer text-2xs text-subtle transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100 group-focus:pointer-events-auto group-focus:opacity-100"
                                :class="restingClass(action, row.entry.path)"
                                v-tooltip.right="action.tooltip"
                                @click.stop="runAction(row.entry, action)"
                            />
                            <!-- Other members with this file open right now: live co-presence on the row. -->
                            <PresenceAvatars
                                v-if="row.entry.type === 'file'"
                                :members="viewersOfPath(row.entry.path)"
                                :label="t(`workspace.workspaceTree.viewingFile`)"
                            />
                            <!-- Transient "just changed" dot (a shape cue, not color-only) alongside the row tint. -->
                            <Icon
                                name="circle-fill"
                                v-if="isRecentlyChanged(row.entry.path)"
                                aria-hidden="true"
                                class="shrink-0 text-[0.4rem] text-warning"
                            />
                        </button>
                        <!-- Phantom create row as the first child of the target dir (sorted position lands on refetch).
                         Sits in the height its anchor row was given for it, so the rows below stay where they are. -->
                        <div
                            v-if="edit.kind === 'creating' && edit.dir === row.entry.path"
                            class="absolute inset-x-0 flex flex-col"
                            :style="{
                                top: `${top + rowHeight}px`,
                                height: `${createBlock}px`,
                                paddingLeft: `${0.5 + (row.depth + 1) * 0.75}rem`,
                            }"
                        >
                            <div class="flex items-center gap-1.5 py-1 pr-2">
                                <span class="w-[0.7rem] shrink-0"></span>
                                <span
                                    class="flex shrink-0 items-center justify-center"
                                    :class="explorerTreatment(explorerStyle, '', edit.type, false, false).slotClass"
                                >
                                    <Icon
                                        :name="edit.type === 'dir' ? 'folder' : 'file'"
                                        :class="[explorerTreatment(explorerStyle, '', edit.type, false, false).sizeClass, 'text-muted']"
                                    />
                                </span>
                                <input
                                    v-model="draft"
                                    type="text"
                                    :aria-label="edit.type === 'dir' ? t(`shared.newFolderName`) : t(`shared.newFileName`)"
                                    class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-[0.8125rem]"
                                    :class="createError !== undefined ? 'ui-field-error-box' : ''"
                                    @click.stop
                                    @keydown.enter.prevent="endEdit('commit')"
                                    @keydown.esc.prevent="endEdit('cancel')"
                                    @blur="endEdit('blur')"
                                    @vue:mounted="focusField"
                                />
                            </div>
                            <p v-if="createError !== undefined" class="pb-1 pl-[1.35rem] text-2xs text-danger">{{ createError }}</p>
                        </div>
                    </template>
                </template>
            </div>
            <p v-if="visibleRows.length === 0 && edit.kind !== 'creating'" class="px-3 py-3 text-center text-2xs text-subtle">
                {{ filter.trim() ? t(`workspace.workspaceTree.noMatchingFiles`) : t(`workspace.workspaceTree.emptyWorkspace`) }}
            </p>
            <!-- The technical switch's own receipt: a press here is the way back, so the hidden files are never a mystery. -->
            <button
                v-if="technicalCount > 0 && filter.trim() === ''"
                type="button"
                class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs italic text-subtle transition-colors hover:text-content"
                v-tooltip.top="t(`workspace.workspaceTree.lockfilesConfigurationDotFiles`)"
                @click="layout.toggleHideTechnical()"
            >
                <span class="w-[0.7rem] shrink-0"></span>
                <span class="min-w-0 flex-1 truncate">{{
                    t(`workspace.workspaceTree.technicalHidden`, { count: technicalCount }, technicalCount)
                }}</span>
            </button>
        </div>
        <!-- Shown only while barren branches exist, pinned to the bottom; names what it counts, since Undo reverses the delete exactly. -->
        <div v-if="barrenBranches.length > 0 && filter.trim() === ''" class="sticky bottom-0 z-10 border-t border-line bg-card">
            <!-- Every branch is named, and each can be kept individually rather than all-or-nothing. -->
            <!-- Space between entries, since each is up to two lines and adjacent ones would otherwise blur together. -->
            <ul v-if="sweepOpen && barrenBranches.length > 1" class="max-h-40 space-y-1.5 overflow-auto border-b border-line py-1.5">
                <li v-for="branch in barrenBranches" :key="branch.path" class="flex items-start gap-2 pr-2 pl-3">
                    <button
                        type="button"
                        class="min-w-0 flex-1 cursor-pointer py-0.5 text-left text-2xs text-subtle hover:text-content"
                        v-action="() => revealBarren(branch.path)"
                        @mouseenter="pointedBarren = branch.path"
                        @mouseleave="pointedBarren = undefined"
                        @focus="pointedBarren = branch.path"
                        @blur="pointedBarren = undefined"
                    >
                        <!-- Two lines, not one path: a path in a 16rem column truncates from the right, where the deleted name sits. -->
                        <span class="block truncate">{{ branch.label }}</span>
                        <span v-if="branch.where !== ''" class="block truncate text-muted/70">{{ branch.where }}</span>
                    </button>
                    <button
                        type="button"
                        class="shrink-0 cursor-pointer py-0.5 text-2xs text-subtle underline-offset-2 hover:text-content hover:underline"
                        v-tooltip.top="t(`workspace.workspaceTree.keepFolderStopsCounting`)"
                        @click="keepFolder(branch.path)"
                    >
                        {{ t(`workspace.workspaceTree.keep`) }}
                    </button>
                </li>
            </ul>
            <div class="flex items-start gap-2 py-1.5 pr-2 pl-3 text-2xs text-subtle">
                <!-- One folder: say which, in the same two lines the list uses. Several: the count opens. -->
                <button
                    v-if="soleBarren !== undefined"
                    type="button"
                    class="min-w-0 flex-1 cursor-pointer text-left hover:text-content"
                    v-action="revealSoleBarren"
                    @mouseenter="pointedBarren = soleBarren?.path"
                    @mouseleave="pointedBarren = undefined"
                    @focus="pointedBarren = soleBarren?.path"
                    @blur="pointedBarren = undefined"
                >
                    <span class="block truncate">{{ t(`workspace.workspaceTree.empty`, { label: soleBarren.label }) }}</span>
                    <span v-if="soleBarren.where !== ''" class="block truncate text-muted/70">{{ soleBarren.where }}</span>
                </button>
                <button
                    v-else
                    type="button"
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left hover:text-content"
                    :aria-expanded="sweepOpen"
                    @click="sweepOpen = !sweepOpen"
                >
                    <span class="truncate">{{ t(`workspace.workspaceTree.emptyFolders`, { count: barrenBranches.length }) }}</span>
                    <Icon :name="sweepOpen ? 'chevron-down' : 'chevron-right'" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    class="shrink-0 cursor-pointer font-medium text-content/70 underline-offset-2 hover:text-content hover:underline"
                    @click="sweepAll"
                >
                    {{ t(`workspace.workspaceTree.cleanUp`) }}
                </button>
            </div>
        </div>
        <ContextMenu ref="menu" :model="menuItems" :min-width="10" />
        <ConfirmDialog
            :open="confirmPaths !== undefined"
            :header="deleteTitle"
            :confirm-label="t(`ui.action.delete`)"
            confirm-icon="trash"
            :items="confirmPaths ?? []"
            @cancel="confirmPaths = undefined"
            @confirm="confirmDelete"
            @hide="focusLead"
        >
            <!-- Delete-confirm list stays calm/monochrome, but tracks the setup's icon size. -->
            <template #item="{ item }">
                <Icon
                    :name="iconForEntry(basename(item), byPath.get(item)?.type ?? 'file', false)"
                    class="shrink-0 text-muted"
                    :class="explorerTreatment(explorerStyle, basename(item), byPath.get(item)?.type ?? 'file', false, false).sizeClass"
                />
                <span class="truncate text-content">{{ basename(item) }}</span>
                <span v-if="parentDir(item) !== ''" class="min-w-0 truncate text-xs text-subtle">{{ parentDir(item) }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">{{ t(`shared.cantUndone`) }}</p>
        </ConfirmDialog>
    </div>
</template>

<style scoped>
/* States `.ui-row-select` doesn't cover: a changed-on-disk row, and one the sweep line points at. The drop tint sits in
   utilities.css beside `.ui-row-select-on`, since the home's tiles and crumbs wear it too. */

/* The chevron glyph is ~10px inside a 22px row, small enough that a trackpad press misses it and the row toggles
   instead. The press target is the row's full height and a quarter rem either side of the glyph, taken from the row's
   own padding and the gap that follows, so it reaches nothing else interactive and no row moves. */
.tree-chevron::after {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline: -0.25rem;
}

/* Pointed at from the sweep line, not hovered; an outline, not a fill, keeps it distinct from hover and selection. */
.ui-row-select-pointed {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary-500) 55%, transparent);
}
/* Flags a row changed on disk for ~2s; static, not animated, since DevTools rebuilds under a live CSS animation. */
.ui-row-select-changed {
    background: color-mix(in srgb, var(--color-warning) 16%, transparent);
}
/* A file on its way in, drawn before the workspace listing has it: a tint under the row, which the spinner and the
   dimmed name complete. A band rather than a dashed box on purpose — a dropped folder lands as a run of these rows, and
   boxes stack into a ladder of doubled borders. Nothing here changes the row's height, so the real row replaces it
   without moving. */
.ui-row-select-arriving {
    background: color-mix(in srgb, var(--color-primary-500) 7%, transparent);
}
/* `.ui-row-select` promises a press with `cursor: pointer`; a row with nothing behind it yet takes that promise back
   rather than accepting the click and doing nothing. */
.ui-row-select-arriving[aria-disabled="true"] {
    cursor: default;
}
</style>
