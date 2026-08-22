<script setup lang="ts">
import type { WorkspaceLink, WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { Button, clipboardOf, ConfirmDialog, ContextMenu, type IconName, useExplorerStyle, vAction } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, type VNode, watch } from "vue";
import { useLayout } from "../../composables/useLayout";
import { viewersOfPath } from "../../composables/usePresence";
import { noteUserCreatedDir, useEmptyDirs } from "../../composables/workspace/useEmptyDirs";
import { useFileNesting } from "../../composables/workspace/useFileNesting";
import { useUploadQueue } from "../../composables/workspace/useUploadQueue";
import { isRecentlyChanged } from "../../composables/workspace/useWorkspaceLive";
import { lensPersonaId, reachOf } from "../../composables/workspace/personaReach";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import { usePersonas } from "../../composables/sandbox/usePersonas";
import PresenceAvatars from "../../presence/PresenceAvatars.vue";
import { useReceipts } from "../../composables/receipts";
import { explorerTreatment, iconForEntry } from "@intentic/ui";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";
import { dragOffer } from "./dragSource";
import { filesToEntries } from "./dropEntries";
import { explorerShows } from "./explorerFilter";
import { movableInto, pastePairs } from "./explorerPaste";
import { nestSiblings, type NestedEntry } from "./fileNesting";
import { ancestorDirs, revealTargets } from "./revealPath";
import type { RowAction } from "./rowActions";
import { selectRange, stepLead } from "./treeSelect";
import type { OpenMode } from "./workspaceTabs";
import { basename, parentDir } from "@intentic/ui/path";

interface Row {
    readonly entry: WorkspaceTreeEntry;
    readonly depth: number;
    readonly isExpanded: boolean;
    // A file row that folds sibling files under it (a dir's package.json, see fileNesting.ts): draws a
    // chevron and expands/collapses like a dir, while clicking the row still opens the file itself.
    readonly nest?: boolean;
    // A settled-barren branch (emptyDirs.ts): dims like an ignored row, and a single-child descent collapses
    // into this ONE row: `chain` labels it ("public / demo / assets"), `chainTail` is the deepest link, whose
    // children are what an expanded chain shows. The row stays keyed by the branch ROOT, so selection, delete
    // and the keyboard axis all act on the unit the user would actually remove.
    readonly barren?: boolean;
    readonly chain?: readonly string[];
    readonly chainTail?: WorkspaceTreeEntry;
}
// A non-interactive "N more items" marker, rendered ONLY under a dir the daemon actually cut (or at the root),
// and only ever with the real count it reported: a directory that merely hasn't been loaded yet lazy-loads on
// expand instead of claiming things are missing. Kept out of the selection/keyboard axis: it's a fact, not a row.
interface MoreRow {
    readonly more: number;
    readonly depth: number;
    readonly key: string;
}

/* The file explorer: a custom recursive tree (dense, VSCode-like rows) that is also the file-management surface.
 * VSCode-style multi-selection (plain click = one, Ctrl/Cmd+click = toggle, Shift+click = range) drives mass
 * actions: delete, cut/copy/paste, and drag-move all act on the whole selection. Arrow keys move a focus "lead"
 * (roving tabindex); Shift/Ctrl+↑↓ extend/move it. All ops route through useWorkspaceTree's mutations. Paths are
 * root-relative; a dir is the drop/create target, a file's parent stands in for it.
 *
 * Cut/copy/paste ride the NATIVE clipboard events rather than a Ctrl+X/C/V keydown branch. Two reasons, both
 * about the chord actually arriving: the browser fires copy/cut/paste at whatever non-editable element holds
 * focus, so the gesture reaches us even where a keydown wouldn't (Safari and macOS Firefox don't focus a
 * <button> on click at all: the old handler was simply dead there), and only the event carries `clipboardData`,
 * which is what lets a copy publish its paths to the SYSTEM clipboard and a paste accept files copied out of the
 * OS file manager. Owning the keyboard is the other half: a row focuses itself on click and the container takes
 * focus when the click lands on empty space, so the explorer holds focus the way VSCode's does, and, equally,
 * a chord pressed with the editor or chat focused still belongs to them. */

const {
    tree,
    rootHidden = 0,
    filter = ``,
    selectedPath,
    manageableDirs = new Set<string>(),
    rowActions,
} = defineProps<{
    tree: readonly WorkspaceTreeEntry[];
    // How many of the root's own entries the daemon's entry budget cut (0 = the root listing is complete).
    rootHidden?: number;
    filter?: string;
    selectedPath?: string | null;
    // Directory paths that have a management surface (a directory-surface extension serves the repo). Activating
    // such a row with the KEYBOARD also opens its operator tab: the row's cog is one of its rowActions.
    manageableDirs?: ReadonlySet<string>;
    /* What this directory offers beside its name: its documents, its health, its history, its management panel
     * (see rowActions.ts). The tree does not know what any of them mean: it draws the icons and runs the one that
     * is clicked. That is what lets an EXTENSION put something on a row without this component learning about it.
     *
     * A function rather than a map, because the rows on screen are the only ones worth asking about: a monorepo's
     * listing is lazily loaded, so nobody can enumerate the paths up front. */
    rowActions?: (dir: string) => readonly RowAction[];
}>();
/* `openFile` carries the GESTURE, not just the path (see OpenMode): a single click is a peek, and it lands in the
 * strip's one transient slot that the next peek takes over: reading down a folder used to leave a pinned tab per
 * file glanced at. A double-click on the row is the "I want this one" that keeps it, exactly as in VSCode. */
const emit = defineEmits<{ openFile: [path: string, mode: OpenMode]; openDirectory: [path: string] }>();

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
    clipboard,
    lazyChildren,
    lazyHidden,
    lazyLoading,
} = useWorkspaceTree();
const layout = useLayout();
const { enqueue, enqueueFromDataTransfer } = useUploadQueue();
const { say } = useReceipts();
const { fileNesting } = useFileNesting();
// Barren branches: folders holding nothing but empty folders (settled, so an agent mid-scaffold never
// flickers the tree). Rows dim and collapse below; the sweep line names them and clears the whole set.
const {
    isBarren,
    roots: barrenRootEntries,
    chainOf,
    branchDirs,
} = useEmptyDirs(
    () => tree,
    () => lazyChildren.value,
);

// Expanded directory paths live in useWorkspaceTree (shared with the explorer toolbar's Collapse All), consulted
// here only when not filtering: a filter force-expands matched branches.
// Multi-selection: the set of selected paths, plus an `anchor` (Shift-range pivot) and a `lead` (keyboard focus
// cursor). Ops act on the whole `selection`; opening a file collapses it back to that one (the watch below).
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
// The paths being dragged WITHIN the tree (an internal move), set on dragstart. Lets dragover validate the target
// before the drop (the dragged payload isn't readable from dataTransfer until the drop fires).
const dragPaths = ref<readonly string[]>([]);
const menu = ref<{ show: (event: Event) => void } | undefined>(undefined);
const menuEntry = ref<WorkspaceTreeEntry | undefined>(undefined);
// Row elements by path (roving-tabindex focus): plain Map, kept in sync by the :ref callback on each button.
const rowEls = new Map<string, HTMLElement>();
// The tree container. Focusable (tabindex -1) so a click on the empty space below the rows still parks focus
// inside the explorer, which is what makes the clipboard events below arrive.
const treeEl = ref<HTMLElement>();

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

const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);
const canMoveInto = (source: string, dir: string): boolean => !(dir === source || dir === parentDir(source) || dir.startsWith(`${source}/`));

/* THE ROWS THE SANDBOX KEEPS TO ITSELF: its capability sign-ins, the owner record, the agents' provider homes
 * (isLockedWorkspacePath owns the list). They are listed, because they exist and hiding them would read as
 * files having gone missing, but every op below refuses them the way the daemon does: no rename, no delete, no
 * cut, no copy, no drag, no drop into them, and no expanding a locked folder: the walk doesn't list what is
 * inside one. A click still opens a tab, which is the whole point: FileLocked says what the file holds and
 * where to manage it, instead of the old flash of a tab that closed itself.
 *
 * Drawn from the PATH rather than a flag on the entry, so a row and its restored tab agree without waiting on
 * the tree, and a folder's children inherit it for free. */
const locked = (path: string): boolean => isLockedWorkspacePath(path);

/* Would the persona being read as be refused this path? Only ever a DIMMING: see personaReach.ts for why a
 * lens must not take the explorer away from the person using it: they are not the persona, the rows stay
 * clickable, and a folder on the way to a reachable one is not dimmed at all. */
const { personas: lensPersonas } = usePersonas();
const lensReach = computed(() => {
    const card = lensPersonas.value.find((persona) => persona.id === lensPersonaId.value);
    return card === undefined ? undefined : reachOf(card);
});
const refused = (path: string): boolean => lensReach.value?.refuses(path) === true;
// Paths from a selection that the file ops may actually touch: a Ctrl+A then Delete must not send the daemon
// a delete for a file it will refuse, and then report that refusal as "couldn't delete that".
const unlockedOnly = (paths: readonly string[]): string[] => paths.filter((path) => !locked(path));

// Children to render under a dir: the inline `children` from the eager walk when it descended there, otherwise
// the lazily-fetched ones (keyed by path). A dir with NO `children` was never listed: ignored, or below the
// walk's breadth-first budget, so it fetches on expand; `children: []` is a genuinely empty dir.
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
// under a dir the daemon reported a nonzero cut for (and at the root), only when NOT filtering: a filter can't
// reveal server-hidden items anyway. A dir that is merely unlisted gets no marker: expanding it loads it.
const visibleRows = computed<(Row | MoreRow)[]>(() => {
    const needle = filter.trim().toLowerCase();
    const open = expanded.value;
    // Every level passes through here, so applying the toolbar's filters once covers the root, every
    // lazily-loaded subtree, and the name filter's matches, and with them the selection/keyboard axis built off
    // these rows. Nesting only applies unfiltered: a filter flattens every level so it can match folded names
    // directly.
    const level = (nodes: readonly WorkspaceTreeEntry[]): readonly NestedEntry[] => {
        const shown = nodes.filter((entry) => explorerShows(entry, layout.showIgnored.value, layout.hideTests.value));
        return fileNesting.value && needle === `` ? nestSiblings(shown) : shown.map((entry) => ({ entry }));
    };

    const walk = (nodes: readonly WorkspaceTreeEntry[], depth: number): (Row | MoreRow)[] => {
        const out: (Row | MoreRow)[] = [];
        for (const { entry, nested } of level(nodes)) {
            if (entry.type === `dir`) {
                if (needle === ``) {
                    const isExpanded = open.has(entry.path);
                    // A barren branch is ONE row: the single-child descent collapses into it, and expanding it
                    // continues from the chain's tail: three rows of debris become one legible line whose shape
                    // says exactly what happened. Skipped while filtering, like nesting: a filter flattens.
                    if (isBarren(entry.path)) {
                        const { names, tail } = chainOf(entry);
                        out.push({ entry, depth, isExpanded, barren: true, chainTail: tail, ...(names.length > 1 ? { chain: names } : {}) });
                        if (isExpanded) {
                            out.push(...walk(childrenOf(tail), depth + 1));
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

/* ---- reveal (the open file, wherever it was opened from) ----
 * Open the tree to the selected file: expand the way down to it (revealPath.ts does that arithmetic) and bring
 * its row on screen. Without this, the file the user is looking at is invisible in the explorer they are
 * looking at it with, and on a reload it was the whole workspace that seemed to have collapsed, since the
 * restored tab points at a file buried under closed folders.
 *
 * Once per path, and only once the row exists: on a reload the path is known before the tree query lands, so an
 * early pass expands and a later one (the tree, or a lazy subtree, arriving) does the scroll. `visibleRows`
 * as the source is what makes that retry automatic. Keyed on the path rather than re-running per tree refetch
 * (the file watcher fires one on every agent write), so a folder the user collapses stays collapsed, and the
 * reveal is silent about focus: it orients, it doesn't take the keyboard away from whatever holds it. */
let revealedPath: string | undefined;
watch(
    [() => selectedPath, visibleRows],
    async () => {
        const path = selectedPath;
        if (path === undefined || path === null || path === revealedPath) {
            return;
        }
        // The path's own directory, whose entries decide whether a nest folds it. The root's are the tree
        // itself; a dir whose children haven't landed yet folds nothing.
        const parent = parentDir(path);
        const parentEntry = byPath.value.get(parent);
        const siblings = parent === `` ? tree : parentEntry === undefined ? [] : childrenOf(parentEntry);
        const targets = revealTargets(path, siblings, fileNesting.value);
        if (targets.some((target) => !expanded.value.has(target))) {
            expanded.value = new Set([...expanded.value, ...targets]);
        }
        // Claimed before the await, not after: expanding re-runs this watch, and two passes that both got past
        // the guard would each scroll the same row.
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
// The single tab stop: the lead when it's visible, else the first row (so Tab can always enter the tree even when
// a filter has hidden the previous lead).
const tabbablePath = computed<string | null>(() =>
    lead.value !== null && orderedPaths.value.includes(lead.value) ? lead.value : (orderedPaths.value[0] ?? null),
);

// The lead's visible row + index: expand/collapse and parent jumps work on rows, not raw entries, so a
// nest parent (package.json) behaves like a dir on the keyboard.
const leadRowAt = (): { row: Row; index: number } | undefined => {
    const index = visibleRows.value.findIndex((row) => !(`more` in row) && row.entry.path === lead.value);
    return index === -1 ? undefined : { row: visibleRows.value[index] as Row, index };
};

// The active file-tree setup (minimal/colorful/vivid): size, colour and folder emphasis for every row.
const { explorerStyle } = useExplorerStyle();
const treatEntry = (name: string, type: "file" | "dir", isExpanded: boolean, ignored: boolean | undefined) =>
    explorerTreatment(explorerStyle.value, name, type, isExpanded, ignored);
// A locked row wears the padlock in place of its own glyph: what kind of file it is stops being the useful
// fact about it the moment it is the one thing you cannot open.
const treat = (row: Row): ReturnType<typeof treatEntry> => {
    // A barren row wears the ignored dimming: nothing is at risk, so it gets the same weight as any other
    // out-of-focus row: a fact, not an alarm.
    const treatment = treatEntry(row.entry.name, row.entry.type, row.isExpanded, row.entry.ignored === true || row.barren === true);
    return locked(row.entry.path) ? { ...treatment, icon: `lock` satisfies IconName, colorClass: `text-subtle` } : treatment;
};

/* WHAT A LINK ROW SAYS ON HOVER. Where it points is the useful half, in the words whoever made the link wrote
 * (the daemon sends the link's own text, not the resolved path). The two refusals are named outright: a row
 * that simply does nothing when clicked is indistinguishable from a broken app, and both of these are the
 * sandbox declining on purpose. */
const linkTooltip = (link: WorkspaceLink): string =>
    link.state === `broken`
        ? `Link to ${link.to}: there is nothing there`
        : link.state === `outside`
          ? `Link to ${link.to}: outside the workspace, so the sandbox won't open it`
          : `Link to ${link.to}`;
// A link that goes nowhere or leaves the workspace: dimmed like an ignored row, and never expandable.
const deadLink = (entry: WorkspaceTreeEntry): boolean => entry.link?.state !== undefined;

// Whether a row has anything to expand into. A barren chain expands from its TAIL, and a chain whose tail is
// the empty leaf gets no chevron: the gesture would be a promise the row can't keep (same as a locked dir,
// and same as a link with nothing reachable behind it).
const expandable = (row: Row): boolean =>
    (row.entry.type === `dir` || row.nest === true) &&
    !locked(row.entry.path) &&
    !deadLink(row.entry) &&
    (row.barren !== true || childrenOf(row.chainTail ?? row.entry).length > 0);

// Expansion is the whole gesture: a dir the walk never listed (ignored, or below its entry budget) fetches its
// children off this set, in useWorkspaceTree, so a folder restored open on reload loads exactly like one the
// user just clicked.
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
// Clicking a row must leave the explorer holding the keyboard, and a <button> can't be relied on to focus
// itself: Safari and macOS Firefox follow the platform convention of NOT focusing one on click. Focus it here
// so the clipboard chords land on the tree in every browser, the way VSCode's explorer keeps focus on a
// single click (opening the file in the editor doesn't take it).
const focusRow = (path: string): void => rowEls.get(path)?.focus();
// A click on the empty space below the rows: park focus on the container itself, so an explorer the user
// obviously just clicked into still owns cut/copy/paste.
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

/* How much of an icon is showing when the pointer is somewhere else. Hover (and the selected row) brings every
 * one of them up to full; this is only about the resting state, and there are three of them:
 *
 *   hidden   an ACTION: what you can do to a repo. Revealed on hover, because fifty-five rows of cogs is the
 *            noise that stops the eye reading the names, and nobody hunts for an action they haven't decided on.
 *   dimmed   EVIDENCE, the row has a page to read. Hiding this hides the fact itself: a documented monorepo
 *            looked exactly like an undocumented one, so the per-package documentation nobody could see was
 *            documentation nobody had.
 *   full     the row the user is on. */
const restingClass = (action: RowAction, path: string): string =>
    selection.value.has(path) ? `opacity-100` : action.standing ? `opacity-40` : `pointer-events-none opacity-0`;

// Running one selects its row first, so the highlight follows what the user just opened: the behaviour all
// three hardcoded affordances used to repeat, now stated once.
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

/* The second half of the click: a double-click keeps the tab the first click previewed. Only a file has anything
 * to keep: a directory row toggles on each of the two clicks and lands back where it started, which is what
 * VSCode's explorer does too. */
const onRowDblClick = (row: Row): void => {
    if (row.entry.type === `file` || locked(row.entry.path)) {
        emit(`openFile`, row.entry.path, `keep`);
    }
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
    if (locked(path)) {
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
        // The user's own New Folder is empty by definition: exempt from the barren marking until it gains
        // content, so the explorer doesn't call it junk three seconds after they made it.
        noteUserCreatedDir(path);
        await run(() => createDir(path), `Couldn't create that folder.`);
        selectSingle(path);
        await focusLead();
        return;
    }
    // A new file: create it, open it, and drop straight into the editor so the user can type immediately. Kept,
    // never previewed: the user is about to type into it, and the next peek must not close it under them.
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
    const paths = unlockedOnly([...selection.value]);
    if (paths.length === 0) {
        return;
    }
    // A selection that is ONLY barren branches skips the confirm dialog: no content is lost, so "this can't
    // be undone" would be false: the receipt's Undo puts an empty folder back exactly. Anything holding real
    // content keeps the full confirmation below.
    const entries = paths.map((path) => byPath.value.get(path));
    const barrenOnly = entries.every((entry): entry is WorkspaceTreeEntry => entry !== undefined && entry.type === `dir` && isBarren(entry.path));
    if (barrenOnly) {
        sweepBarren(entries);
        return;
    }
    confirmPaths.value = paths;
};
/* WHAT THE SWEEP IS ABOUT TO TAKE. A bare count asked the user to authorise deleting N things it never named,
 * and the receipt afterwards named them no better, so the only record of what went was an Undo that restores
 * all of it or none of it. The line NAMES what it counts instead: one branch reads as itself, several fold into
 * a count that opens, and every name is a control that points at the row it stands for. Naming them is also
 * what makes the choice stop being all-or-nothing, since a named branch can carry its own Keep.
 *
 * `pointedBarren` is the branch the pointer (or keyboard focus) is resting on in that list, lit in the tree so
 * the name and the row are visibly the same thing. */
const sweepOpen = ref(false);
const pointedBarren = ref<string | undefined>(undefined);
/* Each branch as the line writes it, in TWO parts, because a list standing away from the tree cannot borrow
 * the tree's indentation to say where a folder lives: a branch called `old` names nothing a user could act on.
 * So `where` carries the folders above it and `label` the barren chain itself: the same "web / demo / assets"
 * the collapsed tree row wears. Kept apart rather than glued into one path because they mean opposite things:
 * everything in `label` is about to be deleted and everything in `where` is staying, and a reader who takes
 * "src / old" for one empty run would think a folder full of source was going with it. */
interface BarrenBranch {
    readonly entry: WorkspaceTreeEntry;
    readonly where: string;
    readonly label: string;
}
const branchOf = (entry: WorkspaceTreeEntry): BarrenBranch => ({
    entry,
    where: entry.path.split(`/`).slice(0, -1).join(` / `),
    label: chainOf(entry).names.join(` / `),
});
const barrenBranches = computed<readonly BarrenBranch[]>(() => barrenRootEntries.value.map(branchOf));
// One branch needs no disclosure: the line just says it.
const soleBarren = computed(() => (barrenBranches.value.length === 1 ? barrenBranches.value[0] : undefined));
// The whole path in one string: for a receipt, where there is no room to shade the two parts differently.
const barrenPath = (branch: BarrenBranch): string => (branch.where === `` ? branch.label : `${branch.where} / ${branch.label}`);
// A list that empties (swept, or the folders gained content) has nothing left to disclose. Folding it back
// here is what stops it springing open later on an unrelated empty folder.
watch(barrenBranches, (branches) => {
    if (branches.length < 2) {
        sweepOpen.value = false;
    }
    if (!branches.some((branch) => branch.entry.path === pointedBarren.value)) {
        pointedBarren.value = undefined;
    }
});
/* Point at the folder the line is naming: open the way down to it, scroll it into view, select it. Selection
 * rather than focus, matching the reveal watch above: it orients the eye without taking the keyboard away
 * from the list the user is still working through. */
const revealBarren = async (entry: WorkspaceTreeEntry): Promise<void> => {
    const dirs = ancestorDirs(entry.path);
    if (dirs.some((dir) => !expanded.value.has(dir))) {
        expanded.value = new Set([...expanded.value, ...dirs]);
    }
    selection.value = new Set([entry.path]);
    anchor.value = entry.path;
    lead.value = entry.path;
    await nextTick();
    rowEls.get(entry.path)?.scrollIntoView({ block: `nearest` });
};
// The one-folder line's own press. A closure in the template would read `soleBarren` outside the `v-if` that
// proved it exists, so the row asks for it here instead, where the check is an ordinary early return.
const revealSoleBarren = async (): Promise<void> => {
    const sole = soleBarren.value;
    if (sole !== undefined) {
        await revealBarren(sole.entry);
    }
};
/* Remove barren branches without ceremony, and hold the way back: the branch shapes are recorded BEFORE the
 * delete (afterwards the tree no longer knows them), and Undo recreates the deepest folder of each chain:
 * recursive create rebuilds the exact shape, which is what makes this the one delete that is genuinely
 * reversible. Counted in BRANCHES, the unit the user sees and deletes. */
const sweepBarren = (roots: readonly WorkspaceTreeEntry[]): void => {
    if (roots.length === 0) {
        return;
    }
    const dirs = roots.flatMap((root) => branchDirs(root));
    const leaves = dirs.filter((dir) => !dirs.some((other) => other !== dir && other.startsWith(`${dir}/`)));
    const paths = roots.map((root) => root.path);
    // Named while the tree still knows the shape. ONE branch fits a receipt and is the whole story; several
    // would be a list, and a pill that retires itself is the wrong place for one: naming them was the line's
    // job, before the click, where the names could still change the decision.
    const first = roots[0];
    const only = roots.length === 1 && first !== undefined ? barrenPath(branchOf(first)) : undefined;
    void run(async () => {
        await removeEntries(paths);
        say(only !== undefined ? `${only} removed` : `${paths.length} empty folders removed`, async () => {
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
    // Said after the delete lands, not before it: a receipt for something that then failed would be the
    // app lying about the one action it cannot take back. The failure has its own notice.
    void run(async () => {
        await removeEntries(paths);
        say(paths.length === 1 ? `1 item deleted` : `${paths.length} items deleted`);
    }, `Couldn't delete that.`);
    selection.value = new Set();
    anchor.value = null;
};
// Keep a barren branch on purpose: drop the standard placeholder into its DEEPEST folder, so the whole chain
// is non-empty from then on: real for git, carried by clones, and out of the empty-folder list for good.
const keepFolder = async (entry: WorkspaceTreeEntry): Promise<void> => {
    const tail = chainOf(entry).tail;
    await run(async () => {
        await saveText(joinPath(tail.path, `.gitkeep`), ``);
        say(`Folder kept`);
    }, `Couldn't keep that folder.`);
};
const cancelDelete = (): void => {
    confirmPaths.value = undefined;
};
// Stage the selection on the clipboard. `system` publishes the same paths as text to the OS clipboard: the
// menu path has no clipboard event to write through, so it asks the async API (best effort: it needs a secure
// context, and CopyButton swallows the same failure). Reached through the tree element so a POPPED-OUT
// explorer writes to the window the user is actually looking at: see clipboardOf.
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

// The names already in the target dir: what a paste must not land on top of. A dir the walk never listed is
// fetched first, so the check is made against what's really there rather than an empty "nothing here yet".
const namesIn = async (dir: string): Promise<ReadonlySet<string>> => {
    const target = dir === `` ? undefined : byPath.value.get(dir);
    if (target !== undefined && isUnlisted(target)) {
        await loadChildren(dir);
    }
    const siblings = target === undefined ? tree : childrenOf(target);
    return new Set(siblings.map((child) => child.name));
};

// Show what a paste produced: expand the target dir and select the landed entries. Without this a paste into a
// collapsed folder, or one scrolled out of view: is indistinguishable from nothing having happened.
const revealPasted = (dir: string, paths: readonly string[]): void => {
    if (dir !== `` && !expanded.value.has(dir)) {
        toggleExpand(dir);
    }
    selection.value = new Set(paths);
    anchor.value = paths[paths.length - 1] ?? null;
    lead.value = anchor.value;
};

// Paste the clipboard into `dir`. A copy never overwrites: each source lands under a free name (VSCode's
// "<name> copy"); a cut moves and consumes the clipboard.
const doPaste = async (dir: string): Promise<void> => {
    const clip = clipboard.value;
    if (clip === undefined) {
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
    // Publishing the paths as text is what makes an explorer copy useful outside the tree (paste into the chat,
    // a terminal, an editor), and it replaces whatever the OS clipboard held, so the file branch of onPasteEvent
    // can't then fire on a stale file copied before this one.
    event.clipboardData?.setData(`text/plain`, paths.join(`\n`));
    event.preventDefault();
};
const onPasteEvent = (event: ClipboardEvent): void => {
    if (editingInline()) {
        return;
    }
    const dir = targetDir(lead.value);
    // Files copied out of the OS file manager (or an image copied from a page) beat the internal clipboard: a
    // copy made HERE overwrites the system clipboard with text, so files present means they were copied later.
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
            // Jump to the visual parent: the nearest shallower row above, the containing dir, or the nest
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
            // Enter is the keyboard's single click, so it peeks like one: walking a folder with ↑↓ then Enter
            // leaves the same one tab behind that clicking down it does.
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
    // Ctrl/Cmd+X·C·V are deliberately absent: they arrive as the clipboard events above, which reach the tree
    // in browsers a keydown wouldn't and carry the clipboardData a keydown can't.
};

// ---- drag: reorder within the tree (internal move, possibly of a multi-selection) OR upload OS files onto a
// row (empty space bubbles to the explorer root). A drop into a folder's own subtree no-ops. ----
/* WHERE A DROP ON THIS ROW LANDS. A folder takes the drop itself; a FILE stands in for the folder holding it,
 * exactly as it does for New File, paste and every other op here (targetDir above). Aiming at a file used to be
 * the one gesture that ignored what was under the pointer: the row declined the drop, it bubbled to the
 * explorer background, and the files landed at the workspace root: nowhere near the folder the user was
 * pointing into. Dropping ONTO something now always means "beside it". */
const dropDirOf = (row: Row): string => (row.entry.type === `dir` ? row.entry.path : parentDir(row.entry.path));
const isInvalidMoveTarget = (dir: string): boolean => dragPaths.value.length > 0 && dragPaths.value.every((source) => !canMoveInto(source, dir));
const onRowDragStart = (event: DragEvent, row: Row): void => {
    if (event.dataTransfer === null) {
        return;
    }
    const path = row.entry.path;
    // Grabbing a selected row drags the whole selection; grabbing an unselected row drags (and selects) just it.
    // Locked rows never travel: dragging one out of the state folder is a move the daemon refuses.
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
    // Nothing this row can take (an image or a link dragged around inside the app): left alone, so the browser
    // declines it: the same answer the explorer background gives, which a row must not quietly overrule.
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
    // The highlight names the DESTINATION, so hovering a file lights up the folder row holding it: the answer
    // to "where will this land?" is the row it will land in, not the one under the pointer. A file at the root
    // has no such row: the explorer background's own "drop to add" hint is already up and says it.
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
    // Swallowed here rather than left to bubble: a drop the sandbox would refuse must not fall through to the
    // explorer root and land the files somewhere the user never aimed at.
    if (locked(dir)) {
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
    // enqueueFromDataTransfer runs the capture synchronously (webkitGetAsEntry must fire while the items are alive)
    // and shows the "scanning" panel instantly.
    enqueueFromDataTransfer(dir, dataTransfer);
};

// ---- context menu (acts on the whole selection when the right-clicked row is part of it) ----
const menuItems = computed<MenuItem[]>(() => {
    const target = menuEntry.value;
    /* A locked row has no menu worth showing: every item on it is something the sandbox refuses, so it gets
     * the one line that explains the padlock instead. Said here as well as on the row because the menu is where
     * a user goes when a row won't do what they expect, and an empty menu would answer them with nothing. */
    if (target !== undefined && locked(target.path)) {
        return [{ label: `Kept private by the sandbox`, icon: `lock`, disabled: true }];
    }
    const multi = target !== undefined && selection.value.size > 1 && selection.value.has(target.path);
    const count = unlockedOnly([...selection.value]).length;
    const dir = target === undefined ? `` : target.type === `dir` ? target.path : parentDir(target.path);
    const items: MenuItem[] = [
        { label: `New File`, icon: `file`, command: () => beginCreate(dir, `file`) },
        { label: `New Folder`, icon: `folder`, command: () => beginCreate(dir, `dir`) },
    ];
    /* What the row's own icons offer, said in words and at the top, because the icons are revealed by HOVER, and
     * a touch device has no hover and a keyboard user never reaches them (the row is the button; the icons inside
     * it cannot be). This menu is the whole non-pointer route to a directory's document, health and history. */
    if (target?.type === `dir` && !multi) {
        const actions = actionsFor(target.path);
        if (actions.length > 0) {
            items.push(...actions.map((action) => ({ label: action.tooltip, icon: action.icon, command: () => runAction(target, action) })));
        }
    }
    if (target !== undefined) {
        items.push({ separator: true });
        if (!multi) {
            items.push({ label: `Rename`, icon: `pencil`, command: () => beginRename(target.path) });
        }
        /* The one user-facing gesture a barren branch keeps: saying it is INTENTIONAL, a place a build drops
         * output, a mount point. Kept the durable way, with the standard placeholder file, so the folder is
         * genuinely non-empty from then on: real for git, visible to teammates, out of this list forever. No
         * private exclusion state anyone else can't see. */
        if (!multi && target.type === `dir` && isBarren(target.path)) {
            items.push({ label: `Keep folder`, icon: `check-circle`, command: () => keepFolder(target) });
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
    <!-- The tree fills the column and the sweep line rides its bottom edge, so the line is a sibling of the
         `role="tree"` element rather than a stray non-treeitem inside it. -->
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
                        <!-- No chevron on a locked folder (nothing behind it to expand into: the walk stops there)
                         or on a barren chain whose tail is the empty leaf: either way the gesture would only be
                         a promise the row can't keep. -->
                        <Icon
                            v-if="expandable(row)"
                            class="w-[0.7rem] shrink-0 text-[0.6rem] text-subtle"
                            :name="row.isExpanded ? 'chevron-down' : 'chevron-right'"
                            @click="onChevronClick($event, row)"
                        />
                        <span v-else class="w-[0.7rem] shrink-0"></span>
                        <!-- Icon size/colour come from the active explorer setup (minimal/colorful/vivid). The fixed-width
                         slot keeps every glyph in one column so filenames align; ignored rows always dim. A locked
                         row shows a padlock here (treat) and says so on hover: the tab it opens says the rest. -->
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
                            class="min-w-0 flex-1 rounded border border-line-strong bg-canvas px-1 text-[0.8125rem] text-content focus:outline-none"
                            @click.stop
                            @keydown.enter.prevent="commitRename"
                            @keydown.esc.prevent="cancelRename"
                            @blur="commitRename"
                            @vue:mounted="focusRename"
                        />
                        <!-- A collapsed barren chain reads as one path ("public / demo / assets"): the shape of the
                         label IS the explanation: a branch holding nothing but emptiness, selectable and
                         deletable as the one unit it really is. -->
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
                        <!-- A SYMLINK. The row already wears its TARGET's icon: a link to a folder looks like a
                         folder, because that is what opening it gets you, so this marker is the one thing that
                         says the name is a pointer rather than the thing. Small and after the name, the way
                         VSCode hangs a ⤷ badge off the row rather than swapping the icon out. Hover names where
                         it goes, which VSCode's explorer does NOT do and which is most of the value: the whole
                         reason to look at a link is to find out what is on the other end. Colored only when
                         there is nothing on the other end. -->
                        <Icon
                            v-if="row.entry.link !== undefined"
                            :name="deadLink(row.entry) ? 'link-broken' : 'link'"
                            aria-hidden="true"
                            class="shrink-0 text-2xs"
                            :class="deadLink(row.entry) ? 'text-warning' : 'text-subtle'"
                            v-tooltip.right="linkTooltip(row.entry.link)"
                        />
                        <!-- The reference shelf: dimmed like every out-of-focus dir, but it must not read as junk:
                         the badge names what it is. What the shelf is FOR was a 29-word paragraph hanging off a
                         tree row, which is neither where anyone reads documentation nor anywhere a touch device
                         can reach; the workspace README owns that. -->
                        <span
                            v-if="row.entry.path === REFERENCE_DIR"
                            class="shrink-0 rounded-full bg-subtle/10 px-1.5 text-2xs font-medium text-subtle"
                            >reference</span
                        >
                        <!-- The outbox, and the one badge here that is a WARNING rather than a label: everything
                         under this directory is on the open internet. Colored, not dimmed: the shelf is out of
                         focus, this is the opposite of out of focus. The Public tab in the sandbox hub owns the
                         detail (which files, at what address, which ones the guards refused). -->
                        <span
                            v-if="row.entry.path === PUBLIC_DIR"
                            class="shrink-0 rounded-full bg-warning/10 px-1.5 text-2xs font-medium text-warning"
                            >public</span
                        >
                        <!-- A dir fetching its children lazily on expand (ignored, or below the walk's budget). -->
                        <Icon
                            v-if="row.entry.type === 'dir' && lazyLoading.has(row.entry.path)"
                            name="spinner"
                            :spin="true"
                            aria-hidden="true"
                            class="shrink-0 text-2xs text-subtle"
                        />
                        <!-- What this directory offers beside its name: its documents, its codebase health, its commit
                         graph, its management panel: whatever rowActions gives it (the tree doesn't know which).
                         Root has no row, so its own pair sits on the explorer toolbar instead.

                         REVEALED ON HOVER, and kept on the selected row: except for the ones that are standing
                         (see restingClass). Always-on for ALL of them was affordable while only the two or three
                         repo rows had any; a documented monorepo puts one on fifty-five package rows, and a
                         permanent icon column is exactly the noise that stops the eye reading the names. The space
                         is reserved either way, so nothing shifts as the pointer sweeps down the tree, and a
                         hidden icon takes no clicks: invisible-but-clickable is worse than absent.

                         An icon with a handler rather than a <button>: the ROW is the button (role="treeitem"),
                         and an interactive element inside one is invalid. The keyboard reaches these through the
                         row's own context menu instead. -->
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
        </div>
        <!-- THE SWEEP. Present only while settled-barren branches exist and gone the moment they are, not a
             fixture waiting to be useful, and PINNED to the bottom of the panel, because a line that only
             surfaces at the end of a long scroll tells a large workspace nothing at all.

             It NAMES what it counts. A single branch reads as itself; several fold into a count that opens; and
             either way the name is a control that points at the row it stands for, so the abstraction and the
             thing are one gesture apart. No dialog in front of the sweep: deleting an empty folder is the
             safest destructive act there is, and the receipt's Undo puts one back exactly. -->
        <div v-if="barrenBranches.length > 0 && filter.trim() === ''" class="sticky bottom-0 z-10 border-t border-line bg-card">
            <!-- Every branch named, each one a way into the tree and each one keepable. Names are what make the
                 choice stop being all-or-nothing: sweep the debris, keep the folder that is a drop point. -->
            <!-- Space BETWEEN entries, since each is up to two lines and adjacent ones would otherwise read as
                 one four-line block with no telling which location belongs to which name. -->
            <ul v-if="sweepOpen && barrenBranches.length > 1" class="scrollbar-thin max-h-40 space-y-1.5 overflow-auto border-b border-line py-1.5">
                <li v-for="branch in barrenBranches" :key="branch.entry.path" class="flex items-start gap-2 pr-2 pl-3">
                    <button
                        type="button"
                        class="min-w-0 flex-1 cursor-pointer py-0.5 text-left text-2xs text-subtle hover:text-content"
                        v-action="() => revealBarren(branch.entry)"
                        @mouseenter="pointedBarren = branch.entry.path"
                        @mouseleave="pointedBarren = undefined"
                        @focus="pointedBarren = branch.entry.path"
                        @blur="pointedBarren = undefined"
                    >
                        <!-- Two lines rather than one path, because a path in a 16rem column truncates from the
                             RIGHT, which is precisely where the folder being deleted is. The name that is going
                             gets its own line and is never cut; where it lives goes underneath, quieter (those
                             folders are staying) and croppable, since it is the half you can afford to lose. -->
                        <span class="block truncate">{{ branch.label }}</span>
                        <span v-if="branch.where !== ''" class="block truncate text-muted/70">{{ branch.where }}</span>
                    </button>
                    <button
                        type="button"
                        class="shrink-0 cursor-pointer py-0.5 text-2xs text-subtle underline-offset-2 hover:text-content hover:underline"
                        v-tooltip.top="'Keep this folder: it stops counting as empty'"
                        @click="keepFolder(branch.entry)"
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
                    @mouseenter="pointedBarren = soleBarren?.entry.path"
                    @mouseleave="pointedBarren = undefined"
                    @focus="pointedBarren = soleBarren?.entry.path"
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
                    @click="sweepBarren(barrenRootEntries)"
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
/* Only the states the shared `.ui-row-select` has no opinion about: a drop target, the flash a row gets when
   the file under it just changed on disk, and the row an empty-folder name in the sweep line is pointing at.
   Hover, selection and the focus ring come from the utility. */

/* POINTED AT FROM ELSEWHERE: the pointer is on a name in the sweep line, not on this row, so the row cannot
   use hover to answer. An outline rather than a fill: it has to be legible next to both the plain hover tint
   and the selection tint without being mistaken for either. */
.ui-row-select-pointed {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary-500) 55%, transparent);
}
.ui-row-select-drop {
    background: color-mix(in srgb, var(--color-primary-500) 28%, transparent);
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
/* Flash a row that just changed on disk (agent/terminal edit), fading over the ~2s the path stays in
   recentlyChanged. The animation overrides the base/hover/selection background for its duration, then the class
   is removed and the row reverts. */
.ui-row-select-changed {
    animation: ui-row-select-changed-flash 2s ease-out;
}
@keyframes ui-row-select-changed-flash {
    from {
        background: color-mix(in srgb, var(--color-warning) 26%, transparent);
    }
    to {
        background: color-mix(in srgb, var(--color-warning) 6%, transparent);
    }
}
</style>
