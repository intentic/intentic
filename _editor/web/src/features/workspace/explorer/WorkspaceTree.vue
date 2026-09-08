<script setup lang="ts">
import type { WorkspaceLink, WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import {
    Button,
    clipboardOf,
    ConfirmDialog,
    ContextMenu,
    type IconName,
    useExplorerStyle,
    vAction,
    explorerTreatment,
    iconForEntry,
} from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, type VNode, watch } from "vue";
import { useLayout } from "../../../shell/window/useLayout";
import { viewersOfPath } from "../../../shell/presence/usePresence";
import { noteUserCreatedDir, useEmptyDirs } from "./useEmptyDirs";
import { useFileNesting } from "./useFileNesting";
import { useUploadQueue } from "../files/useUploadQueue";
import { isRecentlyChanged } from "../changes/useWorkspaceLive";
import { lensPersonaId, reachOf } from "../directory-ui/personaReach";
import { useWorkspaceTree } from "./useWorkspaceTree";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import { useNotifications } from "../../../shell/notifications/notifications";
import { specialChip } from "./specialPaths";
import { dragOffer } from "./transfer/dragSource";
import { filesToEntries } from "./transfer/dropEntries";
import { explorerShows } from "./explorerFilter";
import { movableInto, pastePairs } from "./transfer/explorerPaste";
import { nestSiblings, type NestedEntry } from "./fileNesting";
import { ancestorDirs, revealTargets } from "./revealPath";
import type { RowAction } from "./rowActions";
import { selectRange, stepLead } from "./treeSelect";
import type { OpenMode } from "../tabs/workspaceTabs";
import { basename, parentDir } from "@intentic/ui/path";

interface Row {
    readonly entry: WorkspaceTreeEntry;
    readonly depth: number;
    readonly isExpanded: boolean;
    // Folds sibling files under it like a dir (fileNesting.ts); the row still opens the file itself on click.
    readonly nest?: boolean;
    // A barren branch collapses into one row keyed at its root; `chainTail` is absent once the chain runs past what the
    // listing reached.
    readonly barren?: boolean;
    readonly chain?: readonly string[];
    readonly chainTail?: WorkspaceTreeEntry;
}
// "N more" marker only for a dir (or root) with a real server-side cut; excluded from selection and keyboard nav.
interface MoreRow {
    readonly more: number;
    readonly depth: number;
    readonly key: string;
}

// Recursive file tree and file-management surface: click selects, Ctrl/Cmd toggles, Shift ranges; ops act on the whole
// selection via useWorkspaceTree, with a file standing in for its parent directory as a target. Cut/copy/paste ride
// native clipboard events instead of keydown, since only those carry `clipboardData` and fire regardless of focus.

const {
    tree,
    rootHidden = 0,
    barren = [],
    filter = ``,
    selectedPath,
    manageableDirs = new Set<string>(),
    rowActions,
} = defineProps<{
    tree: readonly WorkspaceTreeEntry[];
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
// `openFile` carries the gesture via `mode`: a click previews into one slot, a double-click keeps the tab.
const emit = defineEmits<{ openFile: [path: string, mode: OpenMode]; openDirectory: [path: string] }>();

const {
    saveText,
    createDir,
    moveEntry,
    removeEntries,
    copyEntries,
    moveIntoMany,
    run,
    canEditFiles,
    refuseWrite,
    loadChildren,
    expanded,
    collapseAll,
    clipboard,
    lazyChildren,
    lazyHidden,
    lazyLoading,
} = useWorkspaceTree();
const layout = useLayout();
const { enqueue, enqueueFromDataTransfer } = useUploadQueue();
const { say } = useNotifications();
const { fileNesting } = useFileNesting();
// Settled folders holding only empty folders; tracked by path since `tree`'s listing may not reach every branch here.
const { isBarren, roots: barrenRootPaths, chainOf, branchDirs } = useEmptyDirs(() => barren);

// `anchor` pivots Shift-range; `lead` is the keyboard cursor; ops act on `selection`, collapsing to one path on open.
const selection = ref<Set<string>>(new Set(selectedPath ? [selectedPath] : []));
const anchor = ref<string | null>(selectedPath ?? null);
const lead = ref<string | null>(selectedPath ?? null);
const renamingPath = ref<string | undefined>(undefined);
const renameDraft = ref(``);
// Inline create (VSCode-style): a phantom input row rendered inside the target dir; `` = the root.
const creating = ref<{ dir: string; type: "file" | "dir" } | undefined>(undefined);
const createDraft = ref(``);
// Paths pending delete confirmation: also drives the confirm dialog's visibility.
const confirmPaths = ref<readonly string[] | undefined>(undefined);
const dragOverPath = ref<string | undefined>(undefined);
// Paths dragged within the tree; dragover checks this since dataTransfer's payload isn't readable until drop.
const dragPaths = ref<readonly string[]>([]);
const menu = ref<{ show: (event: Event) => void } | undefined>(undefined);
const menuEntry = ref<WorkspaceTreeEntry | undefined>(undefined);
// Row elements by path (roving-tabindex focus): plain Map, kept in sync by the :ref callback on each button.
const rowEls = new Map<string, HTMLElement>();
// Tree container; tabindex -1 so clicking empty space still parks focus here, letting clipboard events fire.
const treeEl = ref<HTMLElement>();

// Opening a file collapses selection to it; Ctrl/Shift-click never emit openFile, so multi-select survives.
watch(
    () => selectedPath,
    (path) => {
        selection.value = new Set(path ? [path] : []);
        anchor.value = path ?? null;
        lead.value = path ?? null;
    },
);

const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);
const canMoveInto = (source: string, dir: string): boolean => !(dir === source || dir === parentDir(source) || dir.startsWith(`${source}/`));

// Sandbox-private paths (isLockedWorkspacePath): no rename, delete, cut, copy, drag, or drop-into; a click opens an
// explanation instead. Derived from the path, so children inherit it for free.
const locked = (path: string): boolean => isLockedWorkspacePath(path);

// Whether the read-as persona's lens would refuse this path; only dims the row, since a lens must not restrict the
// actual user. A folder on the way to a reachable child is never dimmed.
const { personas: lensPersonas } = usePersonas();
const lensReach = computed(() => {
    const card = lensPersonas.value.find((persona) => persona.id === lensPersonaId.value);
    return card === undefined ? undefined : reachOf(card);
});
const refused = (path: string): boolean => lensReach.value?.refuses(path) === true;
// Selection filtered to paths the ops may actually touch, so bulk delete doesn't hit paths the daemon will refuse.
const unlockedOnly = (paths: readonly string[]): string[] => paths.filter((path) => !locked(path));

// Children come from the eager walk's inline `children`, else the lazily-fetched map keyed by path. No `children` means
// never listed (ignored, or beyond budget) and fetches on expand; `children: []` is a genuinely empty dir.
const isUnlisted = (entry: WorkspaceTreeEntry): boolean => entry.type === `dir` && entry.children === undefined;
const childrenOf = (entry: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] => entry.children ?? lazyChildren.value.get(entry.path) ?? [];

// Flattens the tree into a path→entry map, covering lazy subtrees too, so a lazy row is selectable like any other.
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

// Flattened, ordered rows built in one pass. A "N more" marker appears only for a dir (or the root) with a nonzero
// server-side cut, and only unfiltered; an unlisted dir gets none, since expanding it loads instead.
const visibleRows = computed<(Row | MoreRow)[]>(() => {
    const needle = filter.trim().toLowerCase();
    const open = expanded.value;
    // Filters apply once here, covering the root, lazy subtrees, and name matches that feed the selection/keyboard
    // axis. Nesting only applies unfiltered, since a filter flattens every level to match folded names.
    const level = (nodes: readonly WorkspaceTreeEntry[]): readonly NestedEntry[] => {
        const shown = nodes.filter((entry) => explorerShows(entry, layout.showIgnored.value, layout.hideTests.value));
        return fileNesting.value && needle === `` ? nestSiblings(shown) : shown.map((entry) => ({ entry }));
    };

    // Draws the one row for a barren branch's collapsed chain. `chainTail` can be missing when the daemon's known
    // branch extends past what the listing loaded, leaving nothing below to draw or expand.
    const barrenRow = (entry: WorkspaceTreeEntry, depth: number, isExpanded: boolean): Row => {
        const { names, tail } = chainOf(entry.path);
        const chainTail = byPath.value.get(tail);
        return { entry, depth, isExpanded, barren: true, ...(chainTail ? { chainTail } : {}), ...(names.length > 1 ? { chain: names } : {}) };
    };

    const walk = (nodes: readonly WorkspaceTreeEntry[], depth: number): (Row | MoreRow)[] => {
        const out: (Row | MoreRow)[] = [];
        for (const { entry, nested } of level(nodes)) {
            if (entry.type !== `dir`) {
                if (nested !== undefined) {
                    const isExpanded = open.has(entry.path);
                    out.push({ entry, depth, isExpanded, nest: true });
                    if (isExpanded) {
                        out.push(...nested.map((child): Row => ({ entry: child, depth: depth + 1, isExpanded: false })));
                    }
                } else if (needle === `` || entry.name.toLowerCase().includes(needle)) {
                    out.push({ entry, depth, isExpanded: false });
                }
                continue;
            }
            // While filtering, a dir earns its row by matching itself or holding a match, and is always shown open.
            if (needle !== ``) {
                const childRows = walk(childrenOf(entry), depth + 1);
                if (!entry.name.toLowerCase().includes(needle) && childRows.length === 0) {
                    continue;
                }
                out.push({ entry, depth, isExpanded: true });
                out.push(...childRows);
                continue;
            }
            const isExpanded = open.has(entry.path);
            // A barren branch is one row, expanding from the chain's tail; skipped while filtering, like nesting.
            if (isBarren(entry.path)) {
                const row = barrenRow(entry, depth, isExpanded);
                out.push(row);
                if (isExpanded) {
                    out.push(...walk(childrenOf(row.chainTail ?? entry), depth + 1));
                }
                continue;
            }
            out.push({ entry, depth, isExpanded });
            if (isExpanded) {
                out.push(...walk(childrenOf(entry), depth + 1));
                const cut = lazyHidden.value.get(entry.path) ?? 0;
                if (cut > 0) {
                    out.push({ more: cut, depth: depth + 1, key: `${entry.path}#more` });
                }
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
// Visible order is the axis for Shift-range and arrow steps; markers are excluded so they can't be selected.
const orderedPaths = computed<string[]>(() => visibleRows.value.filter((row): row is Row => !(`more` in row)).map((row) => row.entry.path));

// Opens the tree down to the selected file and scrolls it into view, once per path once its row exists (retried via
// visibleRows). Keyed by path, not every refetch, so a collapsed folder stays collapsed; focus is never stolen.
let revealedPath: string | undefined;
watch(
    [() => selectedPath, visibleRows],
    async () => {
        const path = selectedPath;
        if (path === undefined || path === null || path === revealedPath) {
            return;
        }
        // The path's own directory decides whether nesting folds it; an unloaded parent folds nothing.
        const parent = parentDir(path);
        const parentEntry = byPath.value.get(parent);
        const siblings = parent === `` ? tree : parentEntry === undefined ? [] : childrenOf(parentEntry);
        const targets = revealTargets(path, siblings, fileNesting.value);
        if (targets.some((target) => !expanded.value.has(target))) {
            expanded.value = new Set([...expanded.value, ...targets]);
        }
        // Claimed before the await: expanding re-runs this watch, so two passes could both scroll the same row.
        revealedPath = path;
        await nextTick();
        const el = rowEls.get(path);
        if (el === undefined) {
            revealedPath = undefined; // not painted yet (or filtered out): a later pass reveals it
            return;
        }
        el.scrollIntoView({ block: `nearest` });
    },
    { immediate: true },
);
// The tree's one tab stop: the lead if visible, else the first row, so Tab enters even when a filter hides the lead.
const tabbablePath = computed<string | null>(() =>
    lead.value !== null && orderedPaths.value.includes(lead.value) ? lead.value : (orderedPaths.value[0] ?? null),
);

// The lead's visible row and index; keyboard expand/parent-jump act on rows, so nesting behaves like a dir too.
const leadRowAt = (): { row: Row; index: number } | undefined => {
    const index = visibleRows.value.findIndex((row) => !(`more` in row) && row.entry.path === lead.value);
    return index === -1 ? undefined : { row: visibleRows.value[index] as Row, index };
};

// The active file-tree setup (minimal/colorful/vivid): size, colour and folder emphasis for every row.
const { explorerStyle } = useExplorerStyle();
const treatEntry = (name: string, type: "file" | "dir", isExpanded: boolean, ignored: boolean | undefined) =>
    explorerTreatment(explorerStyle.value, name, type, isExpanded, ignored);
const treat = (row: Row): ReturnType<typeof treatEntry> => {
    // A barren row dims like an ignored one: nothing is at risk, so it reads as a fact, not an alarm.
    const treatment = treatEntry(row.entry.name, row.entry.type, row.isExpanded, row.entry.ignored === true || row.barren === true);
    return locked(row.entry.path) ? { ...treatment, icon: `lock` satisfies IconName, colorClass: `text-subtle` } : treatment;
};

// Hover text for a link row: the link's own target text as reported, not the resolved path. Broken and
// outside-workspace states are named explicitly, since a silent no-op click would look like a bug.
const linkTooltip = (link: WorkspaceLink): string =>
    link.state === `broken`
        ? `Link to ${link.to}: there is nothing there`
        : link.state === `outside`
          ? `Link to ${link.to}: outside the workspace, so the sandbox won't open it`
          : `Link to ${link.to}`;
// A link that goes nowhere or leaves the workspace: dimmed like an ignored row, and never expandable.
const deadLink = (entry: WorkspaceTreeEntry): boolean => entry.link?.state !== undefined;

// Whether a row has anything to expand into; a barren chain expands from its tail. No chevron when the tail has no
// children, or the dir is locked, or the link is dead.
const expandable = (row: Row): boolean =>
    (row.entry.type === `dir` || row.nest === true) &&
    !locked(row.entry.path) &&
    !deadLink(row.entry) &&
    (row.barren !== true || childrenOf(row.chainTail ?? row.entry).length > 0);

// Toggling expansion lazily fetches an unlisted dir, so a reload-restored folder loads like a fresh click.
const toggleExpand = (path: string): void => {
    const next = new Set(expanded.value);
    if (next.has(path)) {
        next.delete(path);
    } else {
        next.add(path);
    }
    expanded.value = next;
};

const activate = (entry: WorkspaceTreeEntry, revealManagedDir: boolean, mode: OpenMode): void => {
    // A locked folder opens its explanation like a locked file: there is nothing inside it to expand into.
    if (locked(entry.path)) {
        emit(`openFile`, entry.path, mode);
        return;
    }
    if (entry.type === `dir`) {
        toggleExpand(entry.path);
        // Keyboard activation (Enter) also reveals a managed dir's operator tab; a plain click just expands.
        if (revealManagedDir && manageableDirs.has(entry.path)) {
            emit(`openDirectory`, entry.path);
        }
        return;
    }
    emit(`openFile`, entry.path, mode);
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
// Focuses the row explicitly, since Safari and macOS Firefox don't focus a <button> on click by default.
const focusRow = (path: string): void => rowEls.get(path)?.focus();
// A click below the rows parks focus on the container, so cut/copy/paste work right after clicking in.
const claimFocus = (): void => treeEl.value?.focus();

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
const clipPaths = (): string[] => unlockedOnly(selection.value.size > 0 ? [...selection.value] : lead.value !== null ? [lead.value] : []);

// A row's own affordances, or none when the parent supplied no source (the mobile listing, a test).
const actionsFor = (path: string): readonly RowAction[] => rowActions?.(path) ?? [];

// Icon resting opacity: hidden for an action, dimmed for evidence there's a page, full for the selected row.
const restingClass = (action: RowAction, path: string): string =>
    selection.value.has(path) ? `opacity-100` : action.standing ? `opacity-40` : `pointer-events-none opacity-0`;

// Selects the row before running its action, so the highlight follows what was just opened.
const runAction = (entry: WorkspaceTreeEntry, action: RowAction): void => {
    selectSingle(entry.path);
    action.run();
};

const onRowClick = (event: MouseEvent, row: Row): void => {
    const path = row.entry.path;
    focusRow(path);
    if (event.shiftKey && anchor.value !== null) {
        extendTo(path); // range select, no activate
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        toggleAt(path); // toggle, no activate
        return;
    }
    selectSingle(path);
    activate(row.entry, false, `preview`);
};

// Double-click keeps the tab the first click previewed; only a file has anything to keep. A directory just toggles on
// each click and lands back where it started, as in VSCode's explorer.
const onRowDblClick = (row: Row): void => {
    if (row.entry.type === `file` || locked(row.entry.path)) {
        emit(`openFile`, row.entry.path, `keep`);
    }
};

// A nest parent's chevron toggles directly, since its row click opens the file instead of expanding.
const onChevronClick = (event: MouseEvent, row: Row): void => {
    if (row.nest === true) {
        event.stopPropagation();
        toggleExpand(row.entry.path);
    }
};

// ---- rename (inline) ----
const beginRename = (path: string): void => {
    if (locked(path) || refuseWrite()) {
        return;
    }
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
    void run(() => moveEntry(path, joinPath(parentDir(path), name)), `Couldn't rename that.`);
};
const cancelRename = (): void => {
    renamingPath.value = undefined;
};
// Focus and select the inline name field the moment it mounts; only one is ever rendered at a time.
const focusRename = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};

// ---- create (inline) / delete (confirm dialog) / cut·copy·paste (over the whole selection) ----
const beginCreate = (dir: string, type: "file" | "dir"): void => {
    if (refuseWrite()) {
        return;
    }
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
        // A freshly created folder is exempt from barren marking until it gains content.
        noteUserCreatedDir(path);
        await run(() => createDir(path), `Couldn't create that folder.`);
        selectSingle(path);
        await focusLead();
        return;
    }
    // A new file opens straight into edit mode; kept, not previewed, so a later peek can't close it mid-type.
    await run(() => saveText(path, ``), `Couldn't create that file.`);
    selectSingle(path);
    emit(`openFile`, path, `keep`);
    layout.setEditMode(true);
    await focusLead();
};
const cancelCreate = (): void => {
    creating.value = undefined;
};
const doDeleteSelection = (): void => {
    if (refuseWrite()) {
        return;
    }
    const paths = unlockedOnly([...selection.value]);
    if (paths.length === 0) {
        return;
    }
    // Barren-only selections skip the confirm dialog: nothing is lost, and Undo recreates the folder exactly.
    const barrenOnly = paths.every((path) => byPath.value.get(path)?.type === `dir` && isBarren(path));
    if (barrenOnly) {
        sweepBarren(paths);
        return;
    }
    confirmPaths.value = paths;
};
// The sweep line names each branch instead of a bare count, so one can be kept individually rather than all-or-nothing.
// `pointedBarren` is the branch the pointer or focus rests on, highlighted in the tree to match name to row.
const sweepOpen = ref(false);
const pointedBarren = ref<string | undefined>(undefined);
// `where` is the ancestor path that is staying; `label` is the barren chain itself, about to be deleted. Kept separate,
// since a joined path could read as one folder being deleted when only the tail is.
interface BarrenBranch {
    readonly path: string;
    readonly where: string;
    readonly label: string;
}
const branchOf = (path: string): BarrenBranch => ({
    path,
    where: path.split(`/`).slice(0, -1).join(` / `),
    label: chainOf(path).names.join(` / `),
});
const barrenBranches = computed<readonly BarrenBranch[]>(() => barrenRootPaths.value.map(branchOf));
// One branch needs no disclosure: the line just says it.
const soleBarren = computed(() => (barrenBranches.value.length === 1 ? barrenBranches.value[0] : undefined));
// The whole path in one string: for a receipt, where there is no room to shade the two parts differently.
const barrenPath = (branch: BarrenBranch): string => (branch.where === `` ? branch.label : `${branch.where} / ${branch.label}`);
// Folds the disclosure closed once the list empties, so it can't spring open for an unrelated folder later.
watch(barrenBranches, (branches) => {
    if (branches.length < 2) {
        sweepOpen.value = false;
    }
    if (!branches.some((branch) => branch.path === pointedBarren.value)) {
        pointedBarren.value = undefined;
    }
});
// Opens the path down to the folder, scrolls it into view, and selects it, matching the reveal watch above. Selection
// rather than focus, so the keyboard stays with the list the user is working through.
const revealBarren = async (path: string): Promise<void> => {
    const dirs = ancestorDirs(path);
    if (dirs.some((dir) => !expanded.value.has(dir))) {
        expanded.value = new Set([...expanded.value, ...dirs]);
    }
    selection.value = new Set([path]);
    anchor.value = path;
    lead.value = path;
    await nextTick();
    rowEls.get(path)?.scrollIntoView({ block: `nearest` });
};
// Reads `soleBarren` here, not in the template, since a template closure would read it outside the `v-if` proving it.
const revealSoleBarren = async (): Promise<void> => {
    const sole = soleBarren.value;
    if (sole !== undefined) {
        await revealBarren(sole.path);
    }
};
// Captured before the delete, since the tree won't know the shape after; Undo recreates each chain's deepest folder.
const sweepBarren = (roots: readonly string[]): void => {
    if (roots.length === 0 || refuseWrite()) {
        return;
    }
    const dirs = roots.flatMap((root) => branchDirs(root));
    const leaves = dirs.filter((dir) => !dirs.some((other) => other !== dir && other.startsWith(`${dir}/`)));
    // Named while the tree still knows the shape: one branch names itself in the receipt, several get a count.
    const first = roots[0];
    const only = roots.length === 1 && first !== undefined ? barrenPath(branchOf(first)) : undefined;
    void run(async () => {
        await removeEntries(roots);
        say(only !== undefined ? `${only} removed` : `${roots.length} empty folders removed`, async () => {
            for (const dir of leaves) {
                await createDir(dir);
            }
        });
    }, `Couldn't delete that.`);
    selection.value = new Set();
    anchor.value = null;
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
    // Said only after the delete lands, since a receipt for a failed delete would misreport what can't be undone.
    void run(async () => {
        await removeEntries(paths);
        say(paths.length === 1 ? `1 item deleted` : `${paths.length} items deleted`);
    }, `Couldn't delete that.`);
    selection.value = new Set();
    anchor.value = null;
};
// Drops a placeholder into the chain's deepest folder, making it non-empty for git and off the barren list for good.
const keepFolder = async (path: string): Promise<void> => {
    if (refuseWrite()) {
        return;
    }
    const tail = chainOf(path).tail;
    await run(async () => {
        await saveText(joinPath(tail, `.gitkeep`), ``);
        say(`Folder kept`);
    }, `Couldn't keep that folder.`);
};
const cancelDelete = (): void => {
    confirmPaths.value = undefined;
};
// Stages the selection; `async` also writes paths as text to the OS clipboard, since the menu path has no clipboard
// event to hook. Routed via the tree element (clipboardOf) so a popped-out explorer targets the right window.
const stage = (mode: "copy" | "cut", system: "async" | "event"): readonly string[] => {
    const paths = clipPaths();
    if (paths.length === 0) {
        return paths;
    }
    clipboard.value = { mode, paths };
    if (system === `async`) {
        void clipboardOf(treeEl.value)
            .writeText(paths.join(`\n`))
            .catch(() => undefined);
    }
    return paths;
};

// Names already in the target dir; an unlisted dir is fetched first, so the check isn't made against a placeholder.
const namesIn = async (dir: string): Promise<ReadonlySet<string>> => {
    const target = dir === `` ? undefined : byPath.value.get(dir);
    if (target !== undefined && isUnlisted(target)) {
        await loadChildren(dir);
    }
    const siblings = target === undefined ? tree : childrenOf(target);
    return new Set(siblings.map((child) => child.name));
};

// Expands the target dir and selects landed entries, so a paste into a collapsed folder isn't invisible.
const revealPasted = (dir: string, paths: readonly string[]): void => {
    if (dir !== `` && !expanded.value.has(dir)) {
        toggleExpand(dir);
    }
    selection.value = new Set(paths);
    anchor.value = paths.at(-1) ?? null;
    lead.value = anchor.value;
};

// A copy never overwrites, landing under a free name ("<name> copy"); a cut moves and consumes the clipboard.
const doPaste = async (dir: string): Promise<void> => {
    const clip = clipboard.value;
    if (clip === undefined || refuseWrite()) {
        return;
    }
    if (clip.mode === `copy`) {
        const pairs = pastePairs(clip.paths, dir, await namesIn(dir));
        if (pairs.length === 0) {
            return;
        }
        await run(() => copyEntries(pairs), `Couldn't paste those items.`);
        revealPasted(
            dir,
            pairs.map((pair) => pair.to),
        );
        return;
    }
    const sources = movableInto(clip.paths, dir);
    clipboard.value = undefined;
    if (sources.length === 0) {
        return;
    }
    await run(() => moveIntoMany(sources, dir), `Couldn't move those items.`);
    revealPasted(
        dir,
        sources.map((source) => joinPath(dir, basename(source))),
    );
};

// ---- clipboard events (the tree owns them only while it holds focus; an inline input owns its own) ----
const editingInline = (): boolean => renamingPath.value !== undefined || creating.value !== undefined;
const onCopyEvent = (event: ClipboardEvent, mode: "copy" | "cut"): void => {
    if (editingInline()) {
        return;
    }
    const paths = stage(mode, `event`);
    if (paths.length === 0) {
        return;
    }
    // Publishing as text makes the copy usable outside the tree, overwriting whatever the OS clipboard held.
    event.clipboardData?.setData(`text/plain`, paths.join(`\n`));
    event.preventDefault();
};
const onPasteEvent = (event: ClipboardEvent): void => {
    if (editingInline()) {
        return;
    }
    const dir = targetDir(lead.value);
    // OS files win over the internal clipboard: a copy made here always overwrites the clipboard's text.
    const files = event.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
        event.preventDefault();
        if (dir !== `` && !expanded.value.has(dir)) {
            toggleExpand(dir);
        }
        void enqueue(dir, filesToEntries(files));
        return;
    }
    if (clipboard.value === undefined) {
        return;
    }
    event.preventDefault();
    void doPaste(dir);
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
        const next = event.key === `Home` ? order[0] : order.at(-1);
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
                toggleExpand(at.row.entry.path);
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
            toggleExpand(at.row.entry.path);
        } else if (at !== undefined) {
            // Jumps to the nearest shallower row above: the containing dir, or a nest parent for a folded file.
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
            // Enter behaves like a single click (preview), leaving the same one tab behind as clicking down the rows.
            activate(leadEntry.value, true, `preview`);
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
    }
    // Ctrl/Cmd+X/C/V are absent here: they arrive as the clipboard events above instead.
};

// ---- drag: internal move (or multi-select) or OS-file upload; dropping into a folder's own subtree no-ops. ----
// A folder takes the drop itself; a file stands in for its parent, as with New File and paste.
const dropDirOf = (row: Row): string => (row.entry.type === `dir` ? row.entry.path : parentDir(row.entry.path));
const isInvalidMoveTarget = (dir: string): boolean => dragPaths.value.length > 0 && dragPaths.value.every((source) => !canMoveInto(source, dir));
const onRowDragStart = (event: DragEvent, row: Row): void => {
    if (event.dataTransfer === null) {
        return;
    }
    const path = row.entry.path;
    // Dragging a selected row moves the whole selection; otherwise just that row. Locked rows never travel.
    const paths = unlockedOnly(selection.value.has(path) ? [...selection.value] : [path]);
    if (paths.length === 0) {
        event.preventDefault();
        return;
    }
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
    const offer = dragOffer(event);
    // Not a file or an internal row drag: left alone so the browser declines it, as the background does.
    if (!offer.files && !offer.rows) {
        return;
    }
    // preventDefault even on an invalid target so the drop lands here (a no-op) instead of bubbling to the root.
    event.preventDefault();
    const dir = dropDirOf(row);
    const invalid = locked(dir) || isInvalidMoveTarget(dir);
    if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = invalid ? `none` : dragPaths.value.length > 0 ? `move` : `copy`;
    }
    // Highlights the destination folder, not the hovered row; a root-level file has none to highlight.
    dragOverPath.value = invalid || dir === `` ? undefined : dir;
};
const onRowDragLeave = (row: Row): void => {
    if (dragOverPath.value === dropDirOf(row)) {
        dragOverPath.value = undefined;
    }
};
const onRowDrop = (event: DragEvent, row: Row): void => {
    const offer = dragOffer(event);
    if (event.dataTransfer === null || (!offer.files && !offer.rows)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const dir = dropDirOf(row);
    // Swallowed here so a refused drop can't bubble to the root and land files unexpectedly.
    if (locked(dir) || refuseWrite()) {
        dragOverPath.value = undefined;
        return;
    }
    dragOverPath.value = undefined;
    const dataTransfer = event.dataTransfer;
    const internal = dataTransfer.getData(`application/x-intentic-path`);
    if (internal !== ``) {
        void run(() => moveIntoMany(internal.split(`\n`), dir), `Couldn't move those items.`);
        return;
    }
    if (!offer.files) {
        return;
    }
    // Runs synchronously, since webkitGetAsEntry must fire while the drag items are still alive.
    enqueueFromDataTransfer(dir, dataTransfer);
};

// Text menu items for a row's hover-only action icons, unreachable by touch or keyboard otherwise. The one non-pointer
// route to a directory's docs, health, and history; read-only, so it stays in the read-only menu too.
const dirActionItems = (target: WorkspaceTreeEntry | undefined, multi: boolean): MenuItem[] =>
    target?.type === `dir` && !multi
        ? actionsFor(target.path).map((action) => ({ label: action.tooltip, icon: action.icon, command: () => runAction(target, action) }))
        : [];

// A read-only member's menu: write items are dropped, not disabled, since greyed-out verbs just invite frustration. The
// tier is named once at the bottom; the daemon would refuse each dropped item anyway (auth/role-floor.ts).
const readOnlyMenu = (target: WorkspaceTreeEntry | undefined, multi: boolean): MenuItem[] => {
    const readable = [
        ...dirActionItems(target, multi),
        ...(expanded.value.size > 0 ? [{ label: `Collapse Folders`, icon: `collapse-all`, command: collapseAll }] : []),
    ];
    return [
        ...readable,
        ...(readable.length > 0 ? [{ separator: true }] : []),
        { label: `Read-only: changing files needs maintainer access`, icon: `lock`, disabled: true },
    ];
};

// ---- context menu (acts on the whole selection when the right-clicked row is part of it) ----
const menuItems = computed<MenuItem[]>(() => {
    const target = menuEntry.value;
    // A locked row's menu is just the padlock explanation, since every item would be refused anyway.
    if (target !== undefined && locked(target.path)) {
        return [{ label: `Kept private by the sandbox`, icon: `lock`, disabled: true }];
    }
    const multi = target !== undefined && selection.value.size > 1 && selection.value.has(target.path);
    const count = unlockedOnly([...selection.value]).length;
    const dir = target === undefined ? `` : target.type === `dir` ? target.path : parentDir(target.path);
    if (!canEditFiles.value) {
        return readOnlyMenu(target, multi);
    }
    const items: MenuItem[] = [
        { label: `New File`, icon: `file`, command: () => beginCreate(dir, `file`) },
        { label: `New Folder`, icon: `folder`, command: () => beginCreate(dir, `dir`) },
        ...dirActionItems(target, multi),
    ];
    if (target !== undefined) {
        items.push({ separator: true });
        if (!multi) {
            items.push({ label: `Rename`, icon: `pencil`, command: () => beginRename(target.path) });
        }
        // Marks a barren folder intentional via a placeholder: durable, visible to git, not a private exclusion flag.
        if (!multi && target.type === `dir` && isBarren(target.path)) {
            items.push({ label: `Keep folder`, icon: `check-circle`, command: () => keepFolder(target.path) });
        }
        items.push(
            { label: multi ? `Delete ${count} items` : `Delete`, icon: `trash`, command: () => doDeleteSelection() },
            { separator: true },
            {
                label: multi ? `Cut ${count} items` : `Cut`,
                icon: `arrows-h`,
                command: () => {
                    stage(`cut`, `async`);
                },
            },
            {
                label: multi ? `Copy ${count} items` : `Copy`,
                icon: `copy`,
                command: () => {
                    stage(`copy`, `async`);
                },
            },
        );
    }
    if (clipboard.value !== undefined) {
        items.push({ label: `Paste`, icon: `clone`, command: () => void doPaste(dir) });
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
    <!-- Sweep line is a sibling of the `role="tree"` element, not nested inside it, so it isn't read as a stray treeitem. -->
    <div class="flex min-h-full flex-col">
        <div
            ref="treeEl"
            class="flex-1 pb-1 focus:outline-none"
            role="tree"
            aria-multiselectable="true"
            tabindex="-1"
            @keydown="onKeydown"
            @mousedown.self="claimFocus"
            @copy="onCopyEvent($event, 'copy')"
            @cut="onCopyEvent($event, 'cut')"
            @paste="onPasteEvent"
            @contextmenu.self.prevent="openMenu($event, undefined)"
        >
            <!-- Phantom create row at the root (also covers an empty workspace). -->
            <div v-if="creating !== undefined && creating.dir === ''" class="flex flex-col" style="padding-left: 0.5rem">
                <div class="flex items-center gap-1.5 py-1 pr-2">
                    <span class="w-[0.7rem] shrink-0"></span>
                    <Icon class="shrink-0 text-2xs text-muted" :name="creating.type === 'dir' ? 'folder' : 'file'" />
                    <input
                        v-model="createDraft"
                        type="text"
                        :aria-label="creating.type === 'dir' ? 'New folder name' : 'New file name'"
                        class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-[0.8125rem]"
                        :class="createError !== undefined ? 'ui-field-error-box' : ''"
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
                        >{{ row.more.toLocaleString() }} more {{ row.more === 1 ? "item" : "items" }}, search to reach them</span
                    >
                </div>
                <template v-else>
                    <button
                        :ref="(el) => setRowEl(row.entry.path, el)"
                        type="button"
                        role="treeitem"
                        :aria-selected="selection.has(row.entry.path)"
                        :aria-expanded="expandable(row) ? row.isExpanded : undefined"
                        :tabindex="tabbablePath === row.entry.path ? 0 : -1"
                        :draggable="renamingPath !== row.entry.path && !locked(row.entry.path)"
                        class="ui-row-select group flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[0.8125rem]"
                        :class="{
                            'ui-row-select-on': selection.has(row.entry.path),
                            'ui-row-select-pointed': row.entry.path === pointedBarren,
                            'ui-row-select-drop': row.entry.path === dragOverPath,
                            'ui-row-select-changed': isRecentlyChanged(row.entry.path),
                            'opacity-50': clipboard?.mode === 'cut' && clipboard.paths.includes(row.entry.path),
                        }"
                        :style="{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
                        @click="onRowClick($event, row)"
                        @dblclick="onRowDblClick(row)"
                        @contextmenu.prevent.stop="openMenu($event, row.entry)"
                        @dragstart="onRowDragStart($event, row)"
                        @dragend="onRowDragEnd"
                        @dragover="onRowDragOver($event, row)"
                        @dragleave="onRowDragLeave(row)"
                        @drop="onRowDrop($event, row)"
                    >
                        <!-- No chevron on a locked folder or a barren chain whose tail is empty; there's nothing to expand into either way. -->
                        <Icon
                            v-if="expandable(row)"
                            class="w-[0.7rem] shrink-0 text-[0.6rem] text-subtle"
                            :name="row.isExpanded ? 'chevron-down' : 'chevron-right'"
                            @click="onChevronClick($event, row)"
                        />
                        <span v-else class="w-[0.7rem] shrink-0"></span>
                        <!-- Icon size/colour come from the active explorer setup; a locked row shows a padlock here instead, explained on hover. -->
                        <span
                            class="flex shrink-0 items-center justify-center"
                            :class="treat(row).slotClass"
                            v-tooltip.right="locked(row.entry.path) ? 'Kept private by the sandbox' : undefined"
                        >
                            <Icon :name="treat(row).icon" :class="[treat(row).sizeClass, treat(row).colorClass]" />
                        </span>
                        <input
                            v-if="renamingPath === row.entry.path"
                            v-model="renameDraft"
                            type="text"
                            class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-[0.8125rem]"
                            @click.stop
                            @keydown.enter.prevent="commitRename"
                            @keydown.esc.prevent="cancelRename"
                            @blur="commitRename"
                            @vue:mounted="focusRename"
                        />
                        <!-- A collapsed barren chain reads as one path ("public / demo / assets"), selectable and deletable as one unit. -->
                        <span
                            v-else
                            class="min-w-0 flex-1 truncate"
                            :class="[
                                row.entry.ignored || row.barren || locked(row.entry.path) || deadLink(row.entry) ? 'text-subtle' : 'text-content/90',
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
                            v-if="specialChip(row.entry.path)"
                            class="shrink-0 rounded-full px-1.5 text-2xs font-medium"
                            :class="specialChip(row.entry.path)?.tone === `warning` ? `bg-warning/10 text-warning` : `bg-subtle/10 text-subtle`"
                            v-tooltip.right="specialChip(row.entry.path)?.tooltip"
                            >{{ specialChip(row.entry.path)?.label }}</span
                        >
                        <!-- A dir fetching its children lazily on expand (ignored, or below the walk's budget). -->
                        <Icon
                            v-if="row.entry.type === 'dir' && lazyLoading.has(row.entry.path)"
                            name="spinner"
                            :spin="true"
                            aria-hidden="true"
                            class="shrink-0 text-2xs text-subtle"
                        />
                        <!-- Row action icons show on hover or when selected (restingClass); handlers, not buttons, since the row is already one. -->
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
                        <PresenceAvatars v-if="row.entry.type === 'file'" :members="viewersOfPath(row.entry.path)" label="viewing this file" />
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
                                class="ui-field-box ui-field-inline min-w-0 flex-1 px-1 text-[0.8125rem]"
                                :class="createError !== undefined ? 'ui-field-error-box' : ''"
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
        </div>
        <!-- Shown only while barren branches exist, pinned to the bottom; names what it counts, since Undo reverses the delete exactly. -->
        <div v-if="barrenBranches.length > 0 && filter.trim() === ''" class="sticky bottom-0 z-10 border-t border-line bg-card">
            <!-- Every branch is named, and each can be kept individually rather than all-or-nothing. -->
            <!-- Space between entries, since each is up to two lines and adjacent ones would otherwise blur together. -->
            <ul v-if="sweepOpen && barrenBranches.length > 1" class="scrollbar-thin max-h-40 space-y-1.5 overflow-auto border-b border-line py-1.5">
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
                        v-tooltip.top="'Keep this folder: it stops counting as empty'"
                        @click="keepFolder(branch.path)"
                    >
                        Keep
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
                    <span class="block truncate">{{ soleBarren.label }} is empty</span>
                    <span v-if="soleBarren.where !== ''" class="block truncate text-muted/70">{{ soleBarren.where }}</span>
                </button>
                <button
                    v-else
                    type="button"
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left hover:text-content"
                    :aria-expanded="sweepOpen"
                    @click="sweepOpen = !sweepOpen"
                >
                    <span class="truncate">{{ barrenBranches.length }} empty folders</span>
                    <Icon :name="sweepOpen ? 'chevron-down' : 'chevron-right'" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    class="shrink-0 cursor-pointer font-medium text-content/70 underline-offset-2 hover:text-content hover:underline"
                    @click="sweepBarren(barrenRootPaths)"
                >
                    Clean up
                </button>
            </div>
        </div>
        <ContextMenu ref="menu" :model="menuItems" :min-width="10" />
        <ConfirmDialog
            :open="confirmPaths !== undefined"
            :header="deleteHeader"
            confirm-label="Delete"
            confirm-icon="trash"
            :items="confirmPaths ?? []"
            @cancel="cancelDelete"
            @confirm="confirmDelete"
            @hide="focusLead"
        >
            <!-- Delete-confirm list stays calm/monochrome, but tracks the setup's icon size. -->
            <template #item="{ item }">
                <Icon
                    :name="iconForEntry(basename(item), byPath.get(item)?.type ?? 'file', false)"
                    class="shrink-0 text-muted"
                    :class="treatEntry(basename(item), byPath.get(item)?.type ?? 'file', false, false).sizeClass"
                />
                <span class="truncate text-content">{{ basename(item) }}</span>
                <span v-if="parentDir(item) !== ''" class="min-w-0 truncate text-xs text-subtle">{{ parentDir(item) }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">This can't be undone.</p>
        </ConfirmDialog>
    </div>
</template>

<style scoped>
/* States `.ui-row-select` doesn't cover: a drop target, a changed-on-disk row, and one the sweep line points at. */

/* Pointed at from the sweep line, not hovered; an outline, not a fill, keeps it distinct from hover and selection. */
.ui-row-select-pointed {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary-500) 55%, transparent);
}
.ui-row-select-drop {
    background: color-mix(in srgb, var(--color-primary-500) 28%, transparent);
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
/* Flags a row changed on disk for ~2s; static, not animated, since DevTools rebuilds under a live CSS animation. */
.ui-row-select-changed {
    background: color-mix(in srgb, var(--color-warning) 16%, transparent);
}
</style>
