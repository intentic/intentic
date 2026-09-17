import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { clipboardOf } from "@intentic/ui";
import { basename, parentDir } from "@intentic/ui/path";
import type { MenuItem } from "primevue/menuitem";
import { computed, onScopeDispose, type Ref, ref, watch } from "vue";
import { useNotifications } from "../../../shell/notifications/notifications";
import { entryMenuItems } from "../explorer/entryMenu";
import { deletedReceipt, deleteHeader, joinPath, newNameError } from "../explorer/entryNames";
import type { RowAction } from "../explorer/rowActions";
import { filesOffered } from "../explorer/transfer/dragSource";
import { useEntryDrag } from "../explorer/transfer/useEntryDrag";
import { filesToEntries } from "../explorer/transfer/dropEntries";
import { movableInto, pastePairs } from "../explorer/transfer/explorerPaste";
import { selectRange } from "../explorer/treeSelect";
import { noteUserCreatedDir, useEmptyDirs } from "../explorer/useEmptyDirs";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { isLeaving, provisionalAt } from "../files/provisionalEntries";
import { useUploadQueue } from "../files/upload/useUploadQueue";

// What can be done to the desk's tiles: the tree's file management (select several, rename, create, delete, cut, copy,
// paste, drag) over the same daemon calls (useWorkspaceTree) and the same clipboard, so a cut in the tree pastes on the
// desk and the other way round. The view keeps navigation, the peek and arrow travel; this owns the verbs.

export interface DeskActionsContext {
    // The open folder: where a create, a keyboard paste and a drop on the background land.
    readonly dir: Ref<string>;
    // The tiles in reading order; Shift-click ranges over it.
    readonly order: Ref<readonly WorkspaceTreeEntry[]>;
    // The shared current entry (useDesk.selected): the lead of the selection here, the marked row in the tree.
    readonly lead: Ref<string | undefined>;
    // The desk element: the window a clipboard write targets, and where focus parks.
    readonly host: Ref<HTMLElement | undefined>;
    readonly open: (entry: WorkspaceTreeEntry) => void;
    // A file just created opens straight into editing.
    readonly openCreated: (path: string) => void;
    // A folder's own rows (documents, personas, checks, management), composed by the page.
    readonly dirActions: (dir: string) => readonly RowAction[];
}

export type SelectModifiers = Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">;

export function useDeskActions(ctx: DeskActionsContext) {
    const {
        tree,
        entriesByPath,
        lazyChildren,
        loadChildren,
        barren,
        clipboard,
        run,
        refuseWrite,
        canEditFiles,
        moveEntry,
        removeEntries,
        copyEntries,
        moveIntoMany,
        createFile,
        createDir,
    } = useWorkspaceTree();
    const { enqueue, enqueueFromDataTransfer } = useUploadQueue();
    const { say } = useNotifications();
    const { isBarren, chainOf } = useEmptyDirs(() => barren.value);

    // Walked, or listed by its parent's lazy load.
    const entryAt = (path: string): WorkspaceTreeEntry | undefined =>
        entriesByPath.value.get(path) ?? lazyChildren.value.get(parentDir(path))?.find((entry) => entry.path === path);
    const locked = (path: string): boolean => isLockedWorkspacePath(path);
    // Still arriving: nothing at that path to act on yet.
    const pending = (path: string): boolean => !entriesByPath.value.has(path) && provisionalAt(path) !== undefined;
    // What the verbs may touch: not the sandbox's private paths, nor rows still on their way in or out.
    const unlockedOnly = (paths: readonly string[]): string[] => paths.filter((path) => !locked(path) && !pending(path) && !isLeaving(path));
    const exists = (path: string): boolean => entryAt(path) !== undefined || provisionalAt(path) !== undefined;
    // A folder's entries, fetched first if the walk skipped it, so a name check isn't made against nothing.
    const listing = async (dir: string): Promise<readonly WorkspaceTreeEntry[]> => {
        const listed = dir === `` ? tree.value : (entriesByPath.value.get(dir)?.children ?? lazyChildren.value.get(dir));
        if (listed !== undefined) {
            return listed;
        }
        await loadChildren(dir);
        return lazyChildren.value.get(dir) ?? [];
    };

    // ---- selection: a set, with the shared lead as its cursor and an anchor for Shift ranges ----
    const paths = computed(() => ctx.order.value.map((entry) => entry.path));
    // Starts on the current entry when it is a tile here: the desk mounts afresh each time it shows, and the tree
    // already marks that one.
    const lead = ctx.lead.value;
    const marked = ref<ReadonlySet<string>>(new Set(lead !== undefined && paths.value.includes(lead) ? [lead] : []));
    const anchor = ref<string | undefined>(lead);

    const select = (path: string, modifiers?: SelectModifiers): void => {
        if (modifiers?.shiftKey === true && anchor.value !== undefined) {
            marked.value = new Set(selectRange(paths.value, anchor.value, path));
            ctx.lead.value = path;
            return;
        }
        if (modifiers?.ctrlKey === true || modifiers?.metaKey === true) {
            const next = new Set(marked.value);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            marked.value = next;
        } else {
            marked.value = new Set([path]);
        }
        anchor.value = path;
        ctx.lead.value = path;
    };
    const selectAll = (): void => {
        marked.value = new Set(paths.value);
    };
    const clear = (): void => {
        marked.value = new Set();
        anchor.value = undefined;
        ctx.lead.value = undefined;
    };
    // A lead set elsewhere (the tree, a folder change) collapses the set to it, or to nothing when the lead is not a
    // tile here (the open folder itself, an entry of another folder): the verbs act on what can be seen, and only that.
    // One toggled out of the set stays the lead.
    watch(ctx.lead, (path) => {
        if (path === undefined || !paths.value.includes(path)) {
            marked.value = new Set();
        } else if (!marked.value.has(path)) {
            marked.value = new Set([path]);
            anchor.value = path;
        }
    });
    // Rows that left the listing (deleted, moved, filtered) leave the selection too.
    watch(paths, (list) => {
        const present = new Set(list);
        if ([...marked.value].some((path) => !present.has(path))) {
            marked.value = new Set([...marked.value].filter((path) => present.has(path)));
        }
    });
    const acting = (): string[] => unlockedOnly([...marked.value]);

    // ---- rename (inline, on the tile) ----
    const renaming = ref<string | undefined>(undefined);
    const renameDraft = ref(``);
    const creating = ref<"file" | "dir" | undefined>(undefined);
    const createDraft = ref(``);
    const editing = computed(() => renaming.value !== undefined || creating.value !== undefined);

    const beginRename = (path: string): void => {
        if (locked(path) || pending(path) || refuseWrite()) {
            return;
        }
        creating.value = undefined;
        renaming.value = path;
        renameDraft.value = basename(path);
    };
    const commitRename = (): void => {
        const path = renaming.value;
        renaming.value = undefined;
        if (path === undefined) {
            return;
        }
        const name = renameDraft.value.trim();
        if (name === `` || name === basename(path)) {
            return;
        }
        const to = joinPath(parentDir(path), name);
        // `moveEntry` swaps the rows before its first await, so the selection can follow the new name in the same frame.
        void run(() => moveEntry(path, to), `Couldn't rename that.`);
        select(to);
    };
    const cancelRename = (): void => {
        renaming.value = undefined;
    };

    // ---- create (a phantom tile in the open folder) ----
    const beginCreate = (type: "file" | "dir"): void => {
        if (refuseWrite()) {
            return;
        }
        renaming.value = undefined;
        creating.value = type;
        createDraft.value = ``;
    };
    const createError = computed<string | undefined>(() =>
        creating.value === undefined ? undefined : newNameError(createDraft.value, ctx.dir.value, exists),
    );
    const commitCreate = async (): Promise<void> => {
        const type = creating.value;
        if (type === undefined) {
            return; // blur fires after Enter already committed
        }
        const name = createDraft.value.trim();
        if (name === ``) {
            creating.value = undefined;
            return;
        }
        if (createError.value !== undefined) {
            return; // the field stays open with the error under it
        }
        creating.value = undefined;
        const path = joinPath(ctx.dir.value, name);
        if (type === `dir`) {
            // A freshly created folder is exempt from barren marking until it gains content.
            noteUserCreatedDir(path);
            const write = run(() => createDir(path), `Couldn't create that folder.`);
            select(path);
            await write;
            return;
        }
        const write = run(() => createFile(path), `Couldn't create that file.`);
        select(path);
        await write;
        // Refused, and taken back off the listing: there is nothing to open.
        if (pending(path) || exists(path)) {
            ctx.openCreated(path);
        }
    };
    const cancelCreate = (): void => {
        creating.value = undefined;
    };

    // ---- delete (confirmed; there is no trash to restore from) ----
    const confirmPaths = ref<readonly string[] | undefined>(undefined);
    const requestDelete = (): void => {
        if (refuseWrite()) {
            return;
        }
        const targets = acting();
        if (targets.length > 0) {
            confirmPaths.value = targets;
        }
    };
    const deleteTitle = computed(() => (confirmPaths.value === undefined ? `` : deleteHeader(confirmPaths.value, (path) => entryAt(path)?.type)));
    const confirmDelete = (): void => {
        const targets = confirmPaths.value;
        confirmPaths.value = undefined;
        if (targets === undefined) {
            return;
        }
        // Named while the listing still knows them, said only once the delete lands.
        const named = deletedReceipt(targets);
        void run(async () => {
            await removeEntries(targets);
            say(named);
        }, `Couldn't delete that.`);
        clear();
    };
    const cancelDelete = (): void => {
        confirmPaths.value = undefined;
    };
    // Drops a placeholder into the chain's deepest folder, making it non-empty for git and off the barren list for good.
    const keepFolder = async (path: string): Promise<void> => {
        if (refuseWrite()) {
            return;
        }
        const tail = chainOf(path).tail;
        await run(async () => {
            await createFile(joinPath(tail, `.gitkeep`));
            say(`Folder kept`);
        }, `Couldn't keep that folder.`);
    };

    // ---- cut, copy, paste: the clipboard is useWorkspaceTree's, shared with the tree ----
    // `async` also writes the paths as text to the OS clipboard, for the menu path, which has no clipboard event to
    // hook; routed via the desk element so a popped-out window targets its own clipboard.
    const stage = (mode: "copy" | "cut", system: "async" | "event"): readonly string[] => {
        const targets = acting();
        if (targets.length === 0) {
            return targets;
        }
        clipboard.value = { mode, paths: targets };
        if (system === `async`) {
            void clipboardOf(ctx.host.value)
                .writeText(targets.join(`\n`))
                .catch(() => undefined);
        }
        return targets;
    };
    // Landed entries in the open folder become the selection, so a paste is visible as more than new tiles.
    const landed = (dir: string, list: readonly string[]): void => {
        if (dir !== ctx.dir.value) {
            return;
        }
        marked.value = new Set(list);
        anchor.value = list.at(-1);
        ctx.lead.value = anchor.value;
    };
    // A copy never overwrites, landing under a free name ("<name> copy"); a cut moves and consumes the clipboard.
    const paste = async (dir: string = ctx.dir.value): Promise<void> => {
        const clip = clipboard.value;
        if (clip === undefined || refuseWrite()) {
            return;
        }
        if (clip.mode === `copy`) {
            const taken = new Set((await listing(dir)).map((entry) => entry.name));
            const pairs = pastePairs(clip.paths, dir, taken);
            if (pairs.length === 0) {
                return;
            }
            const write = run(() => copyEntries(pairs), `Couldn't paste those items.`);
            landed(
                dir,
                pairs.map((pair) => pair.to),
            );
            await write;
            return;
        }
        const sources = movableInto(clip.paths, dir);
        clipboard.value = undefined;
        if (sources.length === 0) {
            return;
        }
        const write = run(() => moveIntoMany(sources, dir), `Couldn't move those items.`);
        landed(
            dir,
            sources.map((source) => joinPath(dir, basename(source))),
        );
        await write;
    };
    // The desk owns the clipboard events only while it holds focus; an inline field owns its own.
    const onCopyEvent = (event: ClipboardEvent, mode: "copy" | "cut"): void => {
        if (editing.value) {
            return;
        }
        const targets = stage(mode, `event`);
        if (targets.length === 0) {
            return;
        }
        event.clipboardData?.setData(`text/plain`, targets.join(`\n`));
        event.preventDefault();
    };
    const onPasteEvent = (event: ClipboardEvent): void => {
        if (editing.value) {
            return;
        }
        // OS files win over the internal clipboard: a copy made here always overwrites the clipboard's text.
        const files = event.clipboardData?.files;
        if (files !== undefined && files.length > 0) {
            event.preventDefault();
            if (!refuseWrite()) {
                void enqueue(ctx.dir.value, filesToEntries(files));
            }
            return;
        }
        if (clipboard.value === undefined) {
            return;
        }
        event.preventDefault();
        void paste();
    };

    // ---- drag: tiles move by pointer (useEntryDrag) into a folder tile, a crumb, or the open folder itself; OS files
    // arrive by the platform's own drag, the one drag read natively, since one the page starts freezes the tab in Brave.
    const { dragging, paths: dragPaths, over, begin: beginEntryDrag, consumeSuppressedClick } = useEntryDrag();
    const onPointerDown = (event: PointerEvent, entry: WorkspaceTreeEntry): void => {
        // A modified press is a selection gesture, and a press on the name field is the field's.
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || renaming.value === entry.path) {
            return;
        }
        // Dragging a selected tile moves the whole selection; otherwise just that tile. Locked tiles never travel.
        const targets = unlockedOnly(marked.value.has(entry.path) ? [...marked.value] : [entry.path]);
        if (targets.length === 0) {
            return;
        }
        beginEntryDrag(event, { paths: targets, onDrop: (dir) => void run(() => moveIntoMany(targets, dir), `Couldn't move those items.`) });
    };

    // The folder an OS file drag is over; undefined over nothing, or over a folder the sandbox keeps private.
    const dropDir = ref<string | undefined>(undefined);
    const onDragOver = (event: DragEvent, dir: string): void => {
        // Not OS files: left alone so the browser declines it.
        if (!filesOffered(event)) {
            return;
        }
        // Stopped here: the page's own drop zone sits behind the desk and must not also claim this drag.
        event.preventDefault();
        event.stopPropagation();
        const invalid = locked(dir);
        if (event.dataTransfer !== null) {
            event.dataTransfer.dropEffect = invalid ? `none` : `copy`;
        }
        dropDir.value = invalid ? undefined : dir;
    };
    // `dragleave` also fires when the pointer crosses into a child; only a real exit clears the target.
    const onDragLeave = (event: DragEvent, dir: string): void => {
        const to = event.relatedTarget;
        if (to instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(to)) {
            return;
        }
        if (dropDir.value === dir) {
            dropDir.value = undefined;
        }
    };
    const onDrop = (event: DragEvent, dir: string): void => {
        if (event.dataTransfer === null || !filesOffered(event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        dropDir.value = undefined;
        if (locked(dir) || refuseWrite()) {
            return;
        }
        // Synchronous: webkitGetAsEntry must fire while the drag's items are still alive.
        enqueueFromDataTransfer(dir, event.dataTransfer);
    };
    // A file drag that ends anywhere (dropped elsewhere, cancelled) clears the hint; capture, so a stopped drop still counts.
    const clearDropDir = (): void => {
        dropDir.value = undefined;
    };
    window.addEventListener(`dragend`, clearDropDir, true);
    window.addEventListener(`drop`, clearDropDir, true);
    onScopeDispose(() => {
        window.removeEventListener(`dragend`, clearDropDir, true);
        window.removeEventListener(`drop`, clearDropDir, true);
    });

    // ---- the menu (entryMenu.ts), acting on the whole selection when the right-clicked tile is part of it ----
    const menu = ref<{ show: (event: Event) => void } | undefined>(undefined);
    const menuEntry = ref<WorkspaceTreeEntry | undefined>(undefined);
    const dirActionItems = (target: WorkspaceTreeEntry | undefined, multi: boolean): MenuItem[] =>
        target?.type === `dir` && !multi
            ? ctx.dirActions(target.path).map((action) => ({
                  label: action.tooltip,
                  icon: action.icon,
                  command: () => {
                      select(target.path);
                      action.run();
                  },
              }))
            : [];
    // The desk's own first row: what a double-click does, for the keyboard and touch.
    const openItem = (target: WorkspaceTreeEntry | undefined, multi: boolean): MenuItem[] =>
        target === undefined || multi ? [] : [{ label: `Open`, icon: target.type === `dir` ? `folder-open` : `file`, command: () => ctx.open(target) }];
    // A folder tile takes a paste itself; creates always land in the open folder, where the new tile can be seen.
    const menuVerbs = (target: WorkspaceTreeEntry | undefined) => ({
        newFile: () => beginCreate(`file`),
        newFolder: () => beginCreate(`dir`),
        rename: () => {
            if (target !== undefined) {
                beginRename(target.path);
            }
        },
        keepFolder: () => {
            if (target !== undefined) {
                void keepFolder(target.path);
            }
        },
        remove: requestDelete,
        cut: () => {
            stage(`cut`, `async`);
        },
        copy: () => {
            stage(`copy`, `async`);
        },
        paste: () => void paste(target?.type === `dir` ? target.path : ctx.dir.value),
    });
    const menuItems = computed<MenuItem[]>(() => {
        const target = menuEntry.value;
        const multi = target !== undefined && marked.value.size > 1 && marked.value.has(target.path);
        return entryMenuItems({
            target,
            locked: target !== undefined && locked(target.path),
            canEdit: canEditFiles.value,
            multi,
            count: acting().length,
            barren: target?.type === `dir` && isBarren(target.path),
            clipboardFull: clipboard.value !== undefined,
            head: openItem(target, multi),
            lead: dirActionItems(target, multi),
            verbs: menuVerbs(target),
        });
    });
    // Right-clicking outside the selection collapses it to that one tile; inside a multi-selection keeps it.
    const openMenu = (event: MouseEvent, entry: WorkspaceTreeEntry | undefined): void => {
        event.preventDefault();
        menuEntry.value = entry;
        if (entry !== undefined && !marked.value.has(entry.path)) {
            select(entry.path);
        }
        menu.value?.show(event);
    };

    // ---- keys the verbs answer; the view keeps travel, Enter, Backspace and Escape ----
    // F2 renames the lead, and only when it stands alone: a rename over a selection would name one of several.
    const renameLead = (): void => {
        const path = ctx.lead.value;
        if (path !== undefined && marked.value.has(path) && marked.value.size === 1) {
            beginRename(path);
        }
    };
    const KEY_VERBS: ReadonlyMap<string, () => void> = new Map([
        [`Delete`, requestDelete],
        [`F2`, renameLead],
    ]);
    const isSelectAll = (event: KeyboardEvent): boolean => (event.ctrlKey || event.metaKey) && (event.key === `a` || event.key === `A`);
    const handleKey = (event: KeyboardEvent): boolean => {
        if (editing.value) {
            return true; // the inline field owns its keys
        }
        const verb = isSelectAll(event) ? selectAll : KEY_VERBS.get(event.key);
        if (verb === undefined) {
            return false;
        }
        verb();
        event.preventDefault();
        return true;
    };

    return {
        marked,
        select,
        selectAll,
        clear,
        editing,
        renaming,
        renameDraft,
        beginRename,
        commitRename,
        cancelRename,
        creating,
        createDraft,
        createError,
        beginCreate,
        commitCreate,
        cancelCreate,
        confirmPaths,
        deleteTitle,
        requestDelete,
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
        pending,
    };
}
