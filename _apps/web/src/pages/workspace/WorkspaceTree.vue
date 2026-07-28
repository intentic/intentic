<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { type IconName, useExplorerStyle } from "@intentic-app/ui";
import Button from "primevue/button";
import ContextMenu from "primevue/contextmenu";
import Dialog from "primevue/dialog";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, type VNode, watch } from "vue";
import { useLayout } from "../../composables/useLayout";
import { viewersOfPath } from "../../composables/usePresence";
import { useFileNesting } from "../../composables/workspace/useFileNesting";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { isRecentlyChanged } from "../../composables/workspace/useWorkspaceLive";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import PresenceAvatars from "../../presence/PresenceAvatars.vue";
import { explorerTreatment, iconForEntry } from "@intentic-app/ui";
import { nestSiblings, type NestedEntry } from "./fileNesting";
import { selectRange, stepLead } from "./treeSelect";

interface Row {
    readonly entry: WorkspaceTreeEntry;
    readonly depth: number;
    readonly isExpanded: boolean;
    // A file row that folds sibling files under it (a dir's package.json, see fileNesting.ts): draws a
    // chevron and expands/collapses like a dir, while clicking the row still opens the file itself.
    readonly nest?: boolean;
}
// A non-interactive "N more items" marker, rendered ONLY under a dir the daemon actually cut (or at the root),
// and only ever with the real count it reported — a directory that merely hasn't been loaded yet lazy-loads on
// expand instead of claiming things are missing. Kept out of the selection/keyboard axis: it's a fact, not a row.
interface MoreRow {
    readonly more: number;
    readonly depth: number;
    readonly key: string;
}

/* The file explorer: a custom recursive tree (dense, VSCode-like rows) that is also the file-management surface.
 * VSCode-style multi-selection (plain click = one, Ctrl/Cmd+click = toggle, Shift+click = range) drives mass
 * actions — delete, cut/copy/paste, and drag-move all act on the whole selection. Arrow keys move a focus "lead"
 * (roving tabindex); Shift/Ctrl+↑↓ extend/move it. All ops route through useWorkspaceTree's mutations. Paths are
 * root-relative; a dir is the drop/create target, a file's parent stands in for it. */

const {
    tree,
    rootHidden = 0,
    filter = ``,
    selectedPath,
    manageableDirs = new Set<string>(),
    repoDirs = new Set<string>(),
} = defineProps<{
    tree: readonly WorkspaceTreeEntry[];
    // How many of the root's own entries the daemon's entry budget cut (0 = the root listing is complete).
    rootHidden?: number;
    filter?: string;
    selectedPath?: string | null;
    // Directory paths that have a management surface (a directory-surface extension serves the repo). Activating
    // such a row also opens its operator tab, and the row shows a cog affordance.
    manageableDirs?: ReadonlySet<string>;
    // Directory paths that are git repos (nested under /work). Each shows two affordances — its commit graph
    // and its codebase-health report — which open as tabs (root has no row, so its own icons sit on the
    // explorer toolbar). This is where the multi-repo axis surfaces: a repo nested in the workspace gets its
    // own history and its own health right here.
    repoDirs?: ReadonlySet<string>;
}>();
const emit = defineEmits<{ openFile: [path: string]; openDirectory: [path: string]; openGraph: [path: string]; openHealth: [path: string] }>();

const {
    saveText,
    createDir,
    moveEntry,
    removeEntries,
    copyEntries,
    moveIntoMany,
    run,
    loadChildren,
    expanded,
    collapseAll,
    lazyChildren,
    lazyHidden,
    lazyLoading,
} = useWorkspaceTree();
const layout = useLayout();
const { enqueueFromDataTransfer } = useUploadQueue();
const { fileNesting } = useFileNesting();

// Expanded directory paths live in useWorkspaceTree (shared with the explorer toolbar's Collapse All), consulted
// here only when not filtering — a filter force-expands matched branches.
// Multi-selection: the set of selected paths, plus an `anchor` (Shift-range pivot) and a `lead` (keyboard focus
// cursor). Ops act on the whole `selection`; opening a file collapses it back to that one (the watch below).
const selection = ref<Set<string>>(new Set(selectedPath ? [selectedPath] : []));
const anchor = ref<string | null>(selectedPath ?? null);
const lead = ref<string | null>(selectedPath ?? null);
const clipboard = ref<{ mode: "copy" | "cut"; paths: readonly string[] } | undefined>(undefined);
const renamingPath = ref<string | undefined>(undefined);
const renameDraft = ref(``);
// Inline create (VSCode-style): a phantom input row rendered inside the target dir; `` = the root.
const creating = ref<{ dir: string; type: "file" | "dir" } | undefined>(undefined);
const createDraft = ref(``);
// Paths pending delete confirmation — also drives the confirm dialog's visibility.
const confirmPaths = ref<readonly string[] | undefined>(undefined);
const dragOverPath = ref<string | undefined>(undefined);
// The paths being dragged WITHIN the tree (an internal move), set on dragstart. Lets dragover validate the target
// before the drop (the dragged payload isn't readable from dataTransfer until the drop fires).
const dragPaths = ref<readonly string[]>([]);
const menu = ref<{ show: (event: Event) => void } | undefined>(undefined);
const menuEntry = ref<WorkspaceTreeEntry | undefined>(undefined);
// Row elements by path (roving-tabindex focus) — plain Map, kept in sync by the :ref callback on each button.
const rowEls = new Map<string, HTMLElement>();

// Opening a file (parent → selectedPath) collapses the selection to it; Ctrl/Shift-click never emit openFile, so
// an in-progress multi-select is never clobbered by this.
watch(
    () => selectedPath,
    (path) => {
        selection.value = new Set(path ? [path] : []);
        anchor.value = path ?? null;
        lead.value = path ?? null;
    },
);

const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);
const canMoveInto = (source: string, dir: string): boolean => !(dir === source || dir === parentDir(source) || dir.startsWith(`${source}/`));

// Children to render under a dir: the inline `children` from the eager walk when it descended there, otherwise
// the lazily-fetched ones (keyed by path). A dir with NO `children` was never listed — ignored, or below the
// walk's breadth-first budget — so it fetches on expand; `children: []` is a genuinely empty dir.
const isUnlisted = (entry: WorkspaceTreeEntry): boolean => entry.type === `dir` && entry.children === undefined;
const childrenOf = (entry: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] => entry.children ?? lazyChildren.value.get(entry.path) ?? [];

// Flatten the tree to a path → entry map so keyboard ops can read a row's type in O(1). Spans lazily-loaded
// subtrees too (via childrenOf), so a lazily-shown row is selectable/actionable like any other.
const byPath = computed(() => {
    const map = new Map<string, WorkspaceTreeEntry>();
    const walk = (nodes: readonly WorkspaceTreeEntry[]): void => {
        for (const node of nodes) {
            map.set(node.path, node);
            const kids = childrenOf(node);
            if (kids.length > 0) {
                walk(kids);
            }
        }
    };
    walk(tree);
    return map;
});
const leadEntry = computed(() => (lead.value === null ? undefined : byPath.value.get(lead.value)));
// The directory an op targets: a dir itself, else the file's parent, else the /work root.
const targetDir = (path: string | null): string => {
    if (path === null) {
        return ``;
    }
    return byPath.value.get(path)?.type === `dir` ? path : parentDir(path);
};

// Flattened, ordered list of the rows to render (single-pass filter/expand). A "N more items" marker is injected
// under a dir the daemon reported a nonzero cut for (and at the root), only when NOT filtering — a filter can't
// reveal server-hidden items anyway. A dir that is merely unlisted gets no marker: expanding it loads it.
const visibleRows = computed<(Row | MoreRow)[]>(() => {
    const needle = filter.trim().toLowerCase();
    const open = expanded.value;
    // Nesting only applies unfiltered — a filter flattens every level so it can match folded names directly.
    const level = (nodes: readonly WorkspaceTreeEntry[]): readonly NestedEntry[] =>
        fileNesting.value && needle === `` ? nestSiblings(nodes) : nodes.map((entry) => ({ entry }));

    const walk = (nodes: readonly WorkspaceTreeEntry[], depth: number): (Row | MoreRow)[] => {
        const out: (Row | MoreRow)[] = [];
        for (const { entry, nested } of level(nodes)) {
            if (entry.type === `dir`) {
                if (needle === ``) {
                    const isExpanded = open.has(entry.path);
                    out.push({ entry, depth, isExpanded });
                    if (isExpanded) {
                        out.push(...walk(childrenOf(entry), depth + 1));
                        const cut = lazyHidden.value.get(entry.path) ?? 0;
                        if (cut > 0) {
                            out.push({ more: cut, depth: depth + 1, key: `${entry.path}#more` });
                        }
                    }
                } else {
                    const childRows = walk(childrenOf(entry), depth + 1);
                    if (!entry.name.toLowerCase().includes(needle) && childRows.length === 0) {
                        continue;
                    }
                    out.push({ entry, depth, isExpanded: true });
                    out.push(...childRows);
                }
            } else if (nested !== undefined) {
                const isExpanded = open.has(entry.path);
                out.push({ entry, depth, isExpanded, nest: true });
                if (isExpanded) {
                    out.push(...nested.map((child): Row => ({ entry: child, depth: depth + 1, isExpanded: false })));
                }
            } else if (needle === `` || entry.name.toLowerCase().includes(needle)) {
                out.push({ entry, depth, isExpanded: false });
            }
        }
        return out;
    };

    const rows = walk(tree, 0);
    if (rootHidden > 0 && needle === ``) {
        rows.push({ more: rootHidden, depth: 0, key: `#root-more` });
    }
    return rows;
});
// Visible order = the axis for Shift-range and arrow steps; markers are excluded so they can't be selected/focused.
const orderedPaths = computed<string[]>(() => visibleRows.value.filter((row): row is Row => !(`more` in row)).map((row) => row.entry.path));
// The single tab stop: the lead when it's visible, else the first row (so Tab can always enter the tree even when
// a filter has hidden the previous lead).
const tabbablePath = computed<string | null>(() =>
    lead.value !== null && orderedPaths.value.includes(lead.value) ? lead.value : (orderedPaths.value[0] ?? null),
);

// The lead's visible row + index — expand/collapse and parent jumps work on rows, not raw entries, so a
// nest parent (package.json) behaves like a dir on the keyboard.
const leadRowAt = (): { row: Row; index: number } | undefined => {
    const index = visibleRows.value.findIndex((row) => !(`more` in row) && row.entry.path === lead.value);
    return index === -1 ? undefined : { row: visibleRows.value[index] as Row, index };
};

// The active file-tree setup (minimal/colorful/vivid) — size, colour and folder emphasis for every row.
const { explorerStyle } = useExplorerStyle();
const treatEntry = (name: string, type: "file" | "dir", isExpanded: boolean, ignored: boolean | undefined) =>
    explorerTreatment(explorerStyle.value, name, type, isExpanded, ignored);
const treat = (row: Row) => treatEntry(row.entry.name, row.entry.type, row.isExpanded, row.entry.ignored);

const toggleExpand = (path: string): void => {
    const next = new Set(expanded.value);
    if (next.has(path)) {
        next.delete(path);
    } else {
        next.add(path);
        // Expanding a dir the walk never listed (ignored, or below its entry budget) fetches its children now.
        const entry = byPath.value.get(path);
        if (entry !== undefined && isUnlisted(entry)) {
            void loadChildren(path);
        }
    }
    expanded.value = next;
};

const activate = (entry: WorkspaceTreeEntry, revealManagedDir: boolean): void => {
    if (entry.type === `dir`) {
        toggleExpand(entry.path);
        // Keyboard activation (Enter) also reveals a managed dir's operator tab; a plain click just expands.
        if (revealManagedDir && manageableDirs.has(entry.path)) {
            emit(`openDirectory`, entry.path);
        }
        return;
    }
    emit(`openFile`, entry.path);
};

// ---- focus (roving tabindex) ----
const setRowEl = (path: string, el: unknown): void => {
    if (el) {
        rowEls.set(path, el as HTMLElement);
    } else {
        rowEls.delete(path);
    }
};
const focusLead = async (): Promise<void> => {
    await nextTick();
    const el = lead.value === null ? undefined : rowEls.get(lead.value);
    el?.focus();
    el?.scrollIntoView({ block: `nearest` });
};

// ---- selection primitives ----
const selectSingle = (path: string): void => {
    selection.value = new Set([path]);
    anchor.value = path;
    lead.value = path;
};
const extendTo = (path: string): void => {
    selection.value = new Set(selectRange(orderedPaths.value, anchor.value ?? path, path));
    lead.value = path;
};
const toggleAt = (path: string): void => {
    const next = new Set(selection.value);
    if (next.has(path)) {
        next.delete(path);
    } else {
        next.add(path);
    }
    selection.value = next;
    anchor.value = path;
    lead.value = path;
};
const clipPaths = (): string[] => (selection.value.size > 0 ? [...selection.value] : lead.value !== null ? [lead.value] : []);

// The cog affordance on a managed dir row: open its operator tab (and select the row so the highlight tracks it).
const onCogClick = (entry: WorkspaceTreeEntry): void => {
    selectSingle(entry.path);
    emit(`openDirectory`, entry.path);
};

// The git-history affordance on a repo dir row: open that repo's commit graph as a tab — the same shape as the
// cog (select the row, open the surface), one level over at the sibling per-repo action.
const onGraphClick = (entry: WorkspaceTreeEntry): void => {
    selectSingle(entry.path);
    emit(`openGraph`, entry.path);
};

// The codebase-health affordance, the third of the same family: this repo's hotspots and key modules as a tab.
const onHealthClick = (entry: WorkspaceTreeEntry): void => {
    selectSingle(entry.path);
    emit(`openHealth`, entry.path);
};

const onRowClick = (event: MouseEvent, row: Row): void => {
    const path = row.entry.path;
    if (event.shiftKey && anchor.value !== null) {
        extendTo(path); // range select, no activate
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        toggleAt(path); // toggle, no activate
        return;
    }
    selectSingle(path);
    activate(row.entry, false);
};

// A nest parent's chevron owns the expand/collapse (its row click opens the file); a dir's chevron just
// falls through to the row click, which already toggles.
const onChevronClick = (event: MouseEvent, row: Row): void => {
    if (row.nest === true) {
        event.stopPropagation();
        toggleExpand(row.entry.path);
    }
};

// ---- rename (inline) ----
const beginRename = (path: string): void => {
    renamingPath.value = path;
    renameDraft.value = basename(path);
};
const commitRename = (): void => {
    const path = renamingPath.value;
    renamingPath.value = undefined;
    if (path === undefined) {
        return;
    }
    const name = renameDraft.value.trim();
    if (name === `` || name === basename(path)) {
        return;
    }
    void run(() => moveEntry(path, joinPath(parentDir(path), name)));
};
const cancelRename = (): void => {
    renamingPath.value = undefined;
};
// Focus + select the inline name field (rename or create) the moment it mounts (only one is ever rendered at a time).
const focusRename = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};

// ---- create (inline) / delete (confirm dialog) / cut·copy·paste (over the whole selection) ----
const beginCreate = (dir: string, type: "file" | "dir"): void => {
    renamingPath.value = undefined;
    if (dir !== `` && !expanded.value.has(dir)) {
        toggleExpand(dir);
    }
    creating.value = { dir, type };
    createDraft.value = ``;
};
// Live validation while typing; empty stays error-free (an empty commit is a silent cancel, like rename).
const createError = computed<string | undefined>(() => {
    if (creating.value === undefined) {
        return undefined;
    }
    const name = createDraft.value.trim();
    if (name === ``) {
        return undefined;
    }
    if (name === `.` || name === `..` || /[/\\]/.test(name)) {
        return `Invalid name.`;
    }
    if (byPath.value.has(joinPath(creating.value.dir, name))) {
        return `"${name}" already exists.`;
    }
    return undefined;
});
const commitCreate = async (): Promise<void> => {
    const spec = creating.value;
    if (spec === undefined) {
        return; // blur fires after Enter already committed
    }
    const name = createDraft.value.trim();
    if (name === ``) {
        creating.value = undefined;
        return;
    }
    if (createError.value !== undefined) {
        return; // keep the input open with the error visible
    }
    creating.value = undefined;
    const path = joinPath(spec.dir, name);
    if (spec.type === `dir`) {
        await run(() => createDir(path));
        selectSingle(path);
        await focusLead();
        return;
    }
    // A new file: create it, open it, and drop straight into the editor so the user can type immediately.
    await run(() => saveText(path, ``));
    selectSingle(path);
    emit(`openFile`, path);
    layout.setEditMode(true);
    await focusLead();
};
const cancelCreate = (): void => {
    creating.value = undefined;
};
const doDeleteSelection = (): void => {
    if (selection.value.size === 0) {
        return;
    }
    confirmPaths.value = [...selection.value];
};
const deleteHeader = computed<string>(() => {
    const paths = confirmPaths.value;
    if (paths === undefined) {
        return ``;
    }
    const only = paths.length === 1 ? paths[0] : undefined;
    if (only === undefined) {
        return `Delete ${paths.length} items?`;
    }
    return byPath.value.get(only)?.type === `dir` ? `Delete folder?` : `Delete file?`;
});
const confirmDelete = (): void => {
    const paths = confirmPaths.value;
    confirmPaths.value = undefined;
    if (paths === undefined) {
        return;
    }
    void run(() => removeEntries(paths));
    selection.value = new Set();
    anchor.value = null;
};
const cancelDelete = (): void => {
    confirmPaths.value = undefined;
};
const doCut = (): void => {
    const paths = clipPaths();
    if (paths.length > 0) {
        clipboard.value = { mode: `cut`, paths };
    }
};
const doCopy = (): void => {
    const paths = clipPaths();
    if (paths.length > 0) {
        clipboard.value = { mode: `copy`, paths };
    }
};
const doPaste = (dir: string): void => {
    const clip = clipboard.value;
    if (clip === undefined) {
        return;
    }
    if (clip.mode === `copy`) {
        // Copying into the source's own dir would collide with itself — land those as "<name>-copy".
        const pairs = clip.paths.map((path) => {
            const collide = parentDir(path) === dir;
            const dot = collide ? basename(path).lastIndexOf(`.`) : -1;
            const name = !collide
                ? basename(path)
                : dot > 0
                  ? `${basename(path).slice(0, dot)}-copy${basename(path).slice(dot)}`
                  : `${basename(path)}-copy`;
            return { from: path, to: joinPath(dir, name) };
        });
        void run(() => copyEntries(pairs));
        return;
    }
    clipboard.value = undefined;
    void run(() => moveIntoMany(clip.paths, dir));
};

// ---- keyboard (target = the lead row; order = visible rows) ----
const onKeydown = (event: KeyboardEvent): void => {
    if (renamingPath.value !== undefined || creating.value !== undefined) {
        return; // the rename / create input owns its keys
    }
    const mod = event.ctrlKey || event.metaKey;
    const order = orderedPaths.value;
    const led = lead.value;

    if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
        const next = stepLead(order, led, event.key === `ArrowDown` ? 1 : -1);
        if (next !== null) {
            if (event.shiftKey) {
                extendTo(next);
            } else if (mod) {
                lead.value = next; // move the cursor only
            } else {
                selectSingle(next);
            }
            void focusLead();
        }
        event.preventDefault();
    } else if (event.key === `Home` || event.key === `End`) {
        const next = event.key === `Home` ? order[0] : order[order.length - 1];
        if (next !== undefined) {
            if (event.shiftKey) {
                extendTo(next);
            } else {
                selectSingle(next);
            }
            void focusLead();
        }
        event.preventDefault();
    } else if (event.key === `ArrowRight`) {
        const at = leadRowAt();
        if (at !== undefined && (at.row.entry.type === `dir` || at.row.nest === true)) {
            if (!at.row.isExpanded) {
                toggleExpand(at.row.entry.path); // expand
            } else {
                const child = visibleRows.value[at.index + 1];
                if (child !== undefined && !(`more` in child) && child.depth > at.row.depth) {
                    selectSingle(child.entry.path);
                    void focusLead();
                }
            }
        }
        event.preventDefault();
    } else if (event.key === `ArrowLeft`) {
        const at = leadRowAt();
        if (at !== undefined && (at.row.entry.type === `dir` || at.row.nest === true) && at.row.isExpanded) {
            toggleExpand(at.row.entry.path); // collapse
        } else if (at !== undefined) {
            // Jump to the visual parent: the nearest shallower row above — the containing dir, or the nest
            // parent when the lead is a file folded under a package.json.
            for (let i = at.index - 1; i >= 0; i--) {
                const above = visibleRows.value[i];
                if (above !== undefined && !(`more` in above) && above.depth < at.row.depth) {
                    selectSingle(above.entry.path);
                    void focusLead();
                    break;
                }
            }
        }
        event.preventDefault();
    } else if (event.key === ` `) {
        if (led !== null) {
            toggleAt(led);
        }
        event.preventDefault();
    } else if (event.key === `Enter`) {
        if (leadEntry.value !== undefined) {
            activate(leadEntry.value, true);
        }
        event.preventDefault();
    } else if (event.key === `Escape`) {
        selection.value = new Set();
        event.preventDefault();
    } else if (event.key === `Delete`) {
        doDeleteSelection();
        event.preventDefault();
    } else if (event.key === `F2`) {
        if (led !== null && selection.value.size <= 1) {
            beginRename(led);
        }
        event.preventDefault();
    } else if (mod && (event.key === `a` || event.key === `A`)) {
        selection.value = new Set(order);
        event.preventDefault();
    } else if (mod && (event.key === `c` || event.key === `C`)) {
        doCopy();
        event.preventDefault();
    } else if (mod && (event.key === `x` || event.key === `X`)) {
        doCut();
        event.preventDefault();
    } else if (mod && (event.key === `v` || event.key === `V`)) {
        doPaste(targetDir(led));
        event.preventDefault();
    }
};

// ---- drag: reorder within the tree (internal move, possibly of a multi-selection) OR upload OS files onto a
// folder row (file rows / empty space bubble to the explorer root). A drop into a folder's own subtree no-ops. ----
const isInvalidMoveTarget = (dir: string): boolean => dragPaths.value.length > 0 && dragPaths.value.every((source) => !canMoveInto(source, dir));
const onRowDragStart = (event: DragEvent, row: Row): void => {
    if (event.dataTransfer === null) {
        return;
    }
    const path = row.entry.path;
    // Grabbing a selected row drags the whole selection; grabbing an unselected row drags (and selects) just it.
    const paths = selection.value.has(path) ? [...selection.value] : [path];
    if (!selection.value.has(path)) {
        selection.value = new Set(paths);
        anchor.value = path;
        lead.value = path;
    }
    event.dataTransfer.setData(`application/x-intentic-path`, paths.join(`\n`));
    event.dataTransfer.effectAllowed = `move`;
    dragPaths.value = paths;
};
const onRowDragEnd = (): void => {
    dragPaths.value = [];
    dragOverPath.value = undefined;
};
const onRowDragOver = (event: DragEvent, row: Row): void => {
    if (row.entry.type !== `dir`) {
        return;
    }
    // preventDefault even on an invalid target so the drop lands here (a no-op) instead of bubbling to the root.
    event.preventDefault();
    const invalid = isInvalidMoveTarget(row.entry.path);
    if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = invalid ? `none` : dragPaths.value.length > 0 ? `move` : `copy`;
    }
    dragOverPath.value = invalid ? undefined : row.entry.path;
};
const onRowDragLeave = (row: Row): void => {
    if (dragOverPath.value === row.entry.path) {
        dragOverPath.value = undefined;
    }
};
const onRowDrop = (event: DragEvent, row: Row): void => {
    if (row.entry.type !== `dir` || event.dataTransfer === null) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const dir = row.entry.path;
    dragOverPath.value = undefined;
    const dataTransfer = event.dataTransfer;
    const internal = dataTransfer.getData(`application/x-intentic-path`);
    if (internal !== ``) {
        void run(() => moveIntoMany(internal.split(`\n`), dir));
        return;
    }
    // enqueueFromDataTransfer runs the capture synchronously (webkitGetAsEntry must fire while the items are alive)
    // and shows the "scanning" panel instantly.
    enqueueFromDataTransfer(dir, dataTransfer);
};

// ---- context menu (acts on the whole selection when the right-clicked row is part of it) ----
const menuItems = computed<MenuItem[]>(() => {
    const target = menuEntry.value;
    const multi = target !== undefined && selection.value.size > 1 && selection.value.has(target.path);
    const count = selection.value.size;
    const dir = target === undefined ? `` : target.type === `dir` ? target.path : parentDir(target.path);
    const items: MenuItem[] = [
        { label: `New File`, icon: `file`, command: () => beginCreate(dir, `file`) },
        { label: `New Folder`, icon: `folder`, command: () => beginCreate(dir, `dir`) },
    ];
    if (target !== undefined) {
        items.push({ separator: true });
        if (!multi) {
            items.push({ label: `Rename`, icon: `pencil`, command: () => beginRename(target.path) });
        }
        items.push(
            { label: multi ? `Delete ${count} items` : `Delete`, icon: `trash`, command: () => doDeleteSelection() },
            { separator: true },
            { label: multi ? `Cut ${count} items` : `Cut`, icon: `arrows-h`, command: () => doCut() },
            { label: multi ? `Copy ${count} items` : `Copy`, icon: `copy`, command: () => doCopy() },
        );
    }
    if (clipboard.value !== undefined) {
        items.push({ label: `Paste`, icon: `clone`, command: () => doPaste(dir) });
    }
    if (expanded.value.size > 0) {
        items.push({ separator: true }, { label: `Collapse Folders`, icon: `collapse-all`, command: collapseAll });
    }
    return items;
});
const openMenu = (event: MouseEvent, entry: WorkspaceTreeEntry | undefined): void => {
    menuEntry.value = entry;
    // Right-clicking outside the current selection collapses to that one row; inside a multi-selection keeps it.
    if (entry !== undefined && !selection.value.has(entry.path)) {
        selection.value = new Set([entry.path]);
        anchor.value = entry.path;
        lead.value = entry.path;
    }
    menu.value?.show(event);
};
</script>

<template>
    <div class="min-h-full" role="tree" aria-multiselectable="true" @keydown="onKeydown" @contextmenu.self.prevent="openMenu($event, undefined)">
        <!-- Phantom create row at the root (also covers an empty workspace). -->
        <div v-if="creating !== undefined && creating.dir === ''" class="flex flex-col" style="padding-left: 0.5rem">
            <div class="flex items-center gap-1.5 py-1 pr-2">
                <span class="w-[0.7rem] shrink-0"></span>
                <Icon class="shrink-0 text-2xs text-muted" :name="creating.type === 'dir' ? 'folder' : 'file'" />
                <input
                    v-model="createDraft"
                    type="text"
                    :aria-label="creating.type === 'dir' ? 'New folder name' : 'New file name'"
                    class="min-w-0 flex-1 rounded border bg-canvas px-1 text-[0.8125rem] text-content focus:outline-none"
                    :class="createError !== undefined ? 'border-danger' : 'border-line-strong'"
                    @click.stop
                    @keydown.enter.prevent="commitCreate"
                    @keydown.esc.prevent="cancelCreate"
                    @blur="createError !== undefined ? cancelCreate() : commitCreate()"
                    @vue:mounted="focusRename"
                />
            </div>
            <p v-if="createError !== undefined" class="pb-1 pl-[1.35rem] text-2xs text-danger">{{ createError }}</p>
        </div>
        <template v-for="row in visibleRows" :key="'more' in row ? row.key : row.entry.path">
            <div
                v-if="'more' in row"
                class="flex items-center gap-1.5 py-1 pr-2 text-2xs italic text-subtle select-none"
                :style="{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
                v-tooltip.top="'Search with Ctrl+P'"
            >
                <span class="w-[0.7rem] shrink-0"></span>
                <span class="min-w-0 flex-1 truncate"
                    >{{ row.more.toLocaleString() }} more {{ row.more === 1 ? "item" : "items" }} — search to reach them</span
                >
            </div>
            <template v-else>
                <button
                    :ref="(el) => setRowEl(row.entry.path, el)"
                    type="button"
                    role="treeitem"
                    :aria-selected="selection.has(row.entry.path)"
                    :aria-expanded="row.entry.type === 'dir' || row.nest ? row.isExpanded : undefined"
                    :tabindex="tabbablePath === row.entry.path ? 0 : -1"
                    :draggable="renamingPath !== row.entry.path"
                    class="treerow flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[0.8125rem]"
                    :class="{
                        'treerow-on': selection.has(row.entry.path),
                        'treerow-drop': row.entry.path === dragOverPath,
                        'treerow-changed': isRecentlyChanged(row.entry.path),
                        'opacity-50': clipboard?.mode === 'cut' && clipboard.paths.includes(row.entry.path),
                    }"
                    :style="{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
                    @click="onRowClick($event, row)"
                    @contextmenu.prevent.stop="openMenu($event, row.entry)"
                    @dragstart="onRowDragStart($event, row)"
                    @dragend="onRowDragEnd"
                    @dragover="onRowDragOver($event, row)"
                    @dragleave="onRowDragLeave(row)"
                    @drop="onRowDrop($event, row)"
                >
                    <Icon
                        v-if="row.entry.type === 'dir' || row.nest"
                        class="w-[0.7rem] shrink-0 text-[0.6rem] text-subtle"
                        :name="row.isExpanded ? 'chevron-down' : 'chevron-right'"
                        @click="onChevronClick($event, row)"
                    />
                    <span v-else class="w-[0.7rem] shrink-0"></span>
                    <!-- Icon size/colour come from the active explorer setup (minimal/colorful/vivid). The fixed-width
                         slot keeps every glyph in one column so filenames align; ignored rows always dim. -->
                    <span class="flex shrink-0 items-center justify-center" :class="treat(row).slotClass">
                        <Icon :name="treat(row).icon" :class="[treat(row).sizeClass, treat(row).colorClass]" />
                    </span>
                    <input
                        v-if="renamingPath === row.entry.path"
                        v-model="renameDraft"
                        type="text"
                        class="min-w-0 flex-1 rounded border border-line-strong bg-canvas px-1 text-[0.8125rem] text-content focus:outline-none"
                        @click.stop
                        @keydown.enter.prevent="commitRename"
                        @keydown.esc.prevent="cancelRename"
                        @blur="commitRename"
                        @vue:mounted="focusRename"
                    />
                    <span v-else class="min-w-0 flex-1 truncate" :class="row.entry.ignored ? 'text-subtle' : 'text-content/90'">{{
                        row.entry.name
                    }}</span>
                    <!-- A dir fetching its children lazily on expand (ignored, or below the walk's budget). -->
                    <Icon
                        v-if="row.entry.type === 'dir' && lazyLoading.has(row.entry.path)"
                        name="spinner"
                        :spin="true"
                        aria-hidden="true"
                        class="shrink-0 text-2xs text-subtle"
                    />
                    <!-- Git repo: two affordances, both opening a per-repo document as a tab — its codebase
                         health (churn × complexity, the import graph's key modules) and its commit graph. Root
                         has no row, so its pair sits on the explorer toolbar instead. -->
                    <template v-if="row.entry.type === 'dir' && repoDirs.has(row.entry.path)">
                        <Icon
                            name="wave-pulse"
                            aria-hidden="true"
                            class="shrink-0 cursor-pointer text-2xs text-subtle hover:text-content"
                            v-tooltip.right="'Open codebase health'"
                            @click.stop="onHealthClick(row.entry)"
                        />
                        <Icon
                            name="sitemap"
                            aria-hidden="true"
                            class="shrink-0 cursor-pointer text-2xs text-subtle hover:text-content"
                            v-tooltip.right="'Open git history'"
                            @click.stop="onGraphClick(row.entry)"
                        />
                    </template>
                    <!-- Managed repo: its cog opens the management surface as a tab (row click only expands). -->
                    <Icon
                        v-if="row.entry.type === 'dir' && manageableDirs.has(row.entry.path)"
                        name="cog"
                        aria-hidden="true"
                        class="shrink-0 cursor-pointer text-2xs text-subtle hover:text-content"
                        v-tooltip.right="'Open management panel'"
                        @click.stop="onCogClick(row.entry)"
                    />
                    <!-- Other members with this file open right now — live co-presence on the row. -->
                    <PresenceAvatars v-if="row.entry.type === 'file'" :viewers="viewersOfPath(row.entry.path)" label="viewing this file" />
                    <!-- Transient "just changed" dot (a shape cue, not color-only) alongside the row tint. -->
                    <Icon
                        name="circle-fill"
                        v-if="isRecentlyChanged(row.entry.path)"
                        aria-hidden="true"
                        class="shrink-0 text-[0.4rem] text-warning"
                    />
                </button>
                <!-- Phantom create row as the first child of the target dir (sorted position lands on refetch). -->
                <div
                    v-if="creating !== undefined && creating.dir === row.entry.path"
                    class="flex flex-col"
                    :style="{ paddingLeft: `${0.5 + (row.depth + 1) * 0.75}rem` }"
                >
                    <div class="flex items-center gap-1.5 py-1 pr-2">
                        <span class="w-[0.7rem] shrink-0"></span>
                        <span class="flex shrink-0 items-center justify-center" :class="treatEntry('', creating.type, false, false).slotClass">
                            <Icon
                                :name="creating.type === 'dir' ? 'folder' : 'file'"
                                :class="[treatEntry('', creating.type, false, false).sizeClass, 'text-muted']"
                            />
                        </span>
                        <input
                            v-model="createDraft"
                            type="text"
                            :aria-label="creating.type === 'dir' ? 'New folder name' : 'New file name'"
                            class="min-w-0 flex-1 rounded border bg-canvas px-1 text-[0.8125rem] text-content focus:outline-none"
                            :class="createError !== undefined ? 'border-danger' : 'border-line-strong'"
                            @click.stop
                            @keydown.enter.prevent="commitCreate"
                            @keydown.esc.prevent="cancelCreate"
                            @blur="createError !== undefined ? cancelCreate() : commitCreate()"
                            @vue:mounted="focusRename"
                        />
                    </div>
                    <p v-if="createError !== undefined" class="pb-1 pl-[1.35rem] text-2xs text-danger">{{ createError }}</p>
                </div>
            </template>
        </template>
        <p v-if="visibleRows.length === 0 && creating === undefined" class="px-3 py-3 text-center text-2xs text-subtle">
            {{ filter.trim() ? "No matching files." : "Empty workspace." }}
        </p>
        <!-- Compact the menu to the dense explorer (Tailwind wins via the utilities cssLayer, ordered last). -->
        <ContextMenu
            ref="menu"
            :model="menuItems"
            :pt="{
                root: '!min-w-40 !text-xs',
                rootList: '!p-1',
                itemLink: '!gap-2 !rounded !px-2 !py-1 !text-xs',
                itemIcon: '!text-2xs',
                separator: '!my-1',
            }"
        >
            <template #itemicon="{ item }"><Icon :name="item.icon as IconName" /></template>
        </ContextMenu>
        <Dialog
            :visible="confirmPaths !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '26rem' }"
            :header="deleteHeader"
            @update:visible="cancelDelete"
            @hide="focusLead"
        >
            <ul v-if="confirmPaths !== undefined" class="flex flex-col gap-1">
                <li v-for="path in confirmPaths.slice(0, 5)" :key="path" class="flex min-w-0 items-center gap-2 text-sm">
                    <!-- Delete-confirm list stays calm/monochrome, but tracks the setup's icon size. -->
                    <Icon
                        :name="iconForEntry(basename(path), byPath.get(path)?.type ?? 'file', false)"
                        class="shrink-0 text-muted"
                        :class="treatEntry(basename(path), byPath.get(path)?.type ?? 'file', false, false).sizeClass"
                    />
                    <span class="truncate text-content">{{ basename(path) }}</span>
                    <span v-if="parentDir(path) !== ''" class="min-w-0 truncate text-xs text-subtle">{{ parentDir(path) }}</span>
                </li>
                <li v-if="confirmPaths.length > 5" class="text-xs text-subtle">…and {{ confirmPaths.length - 5 }} more</li>
            </ul>
            <p class="mt-3 text-xs text-muted">This can't be undone.</p>
            <template #footer>
                <Button label="Cancel" severity="secondary" :text="true" @click="cancelDelete" />
                <Button label="Delete" severity="danger" autofocus @click="confirmDelete">
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </template>
        </Dialog>
    </div>
</template>

<style scoped>
.treerow {
    cursor: pointer;
    transition: background-color 0.1s;
}
.treerow:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
}
.treerow-on {
    background: color-mix(in srgb, var(--color-primary-500) 15%, transparent);
}
.treerow:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
.treerow-drop {
    background: color-mix(in srgb, var(--color-primary-500) 28%, transparent);
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
/* Flash a row that just changed on disk (agent/terminal edit), fading over the ~2s the path stays in
   recentlyChanged. The animation overrides the base/hover/selection background for its duration, then the class
   is removed and the row reverts. */
.treerow-changed {
    animation: treerow-changed-flash 2s ease-out;
}
@keyframes treerow-changed-flash {
    from {
        background: color-mix(in srgb, var(--color-warning) 26%, transparent);
    }
    to {
        background: color-mix(in srgb, var(--color-warning) 6%, transparent);
    }
}
</style>
