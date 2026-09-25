import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { parentDir } from "@intentic/ui/path";
import { computed, type Ref, ref, watch } from "vue";
import { clickIntent, rangeSelect } from "../../../lib/multiSelect";
import { useNotifications } from "../../../shell/notifications/notifications";
import { useDeleteUndo } from "../explorer/undo/useDeleteUndo";
import type { RowAction } from "../explorer/rowActions";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";
import { useTreeDelete } from "../explorer/tree/useTreeDelete";
import { useInlineEdit, useTreeEdits } from "../explorer/tree/useTreeEdits";
import { useTreeMenu } from "../explorer/tree/useTreeMenu";
import { useTreeRules } from "../explorer/tree/useTreeRules";
import { useTreeTransfer } from "../explorer/tree/useTreeTransfer";
import { useEmptyDirs } from "../explorer/useEmptyDirs";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { provisionalAt } from "../files/provisionalEntries";
import { useUploadQueue } from "../files/upload/useUploadQueue";

// The tree's own verbs (explorer/tree) over the home's tiles, every one aimed at the open folder; the clipboard is shared.

export interface HomeActionsContext {
    // The open folder: where a create, a keyboard paste and a drop on the background land.
    readonly dir: Ref<string>;
    // The tiles in reading order; Shift-click ranges over it.
    readonly order: Ref<readonly WorkspaceTreeEntry[]>;
    // The shared current entry (useHome.selected): the lead of the selection here, the marked row in the tree.
    readonly lead: Ref<string | undefined>;
    // The home element: the window a clipboard write targets, and where focus parks.
    readonly host: Ref<HTMLElement | undefined>;
    readonly open: (entry: WorkspaceTreeEntry) => void;
    // A file just created opens straight into editing.
    readonly openCreated: (path: string) => void;
    // A folder's own rows (documents, personas, checks, management), composed by the page.
    readonly dirActions: (dir: string) => readonly RowAction[];
}

export type SelectModifiers = Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">;

export function useHomeActions(ctx: HomeActionsContext) {
    const store = useWorkspaceTree();
    const { entriesByPath: byPath } = store;
    const uploads = useUploadQueue();
    const { say } = useNotifications();
    const emptyDirs = useEmptyDirs(() => store.barren.value);
    const rules = useTreeRules({ byPath, store });
    const here = (): string => ctx.dir.value;

    // ---- selection: unlike the tree's, its lead is the shared current entry, so every gesture here moves it ----
    const tiles = computed(() => ctx.order.value.map((tile) => tile.path));
    const start = ctx.lead.value;
    const selection = ref(new Set<string>(start !== undefined && tiles.value.includes(start) ? [start] : []));
    // The Shift pivot, which also stands in for the tree's lead: the tile a verb falls back to when nothing is marked.
    const anchor = ref<string | null>([...selection.value][0] ?? null);
    const selectSingle = (path: string): void => {
        selection.value = new Set([path]);
        anchor.value = path;
        ctx.lead.value = path;
    };
    const select = (path: string, modifiers?: SelectModifiers): void => {
        const intent = modifiers === undefined ? `single` : clickIntent(modifiers, anchor.value !== null);
        if (intent === `single`) {
            selectSingle(path);
            return;
        }
        if (intent === `range`) {
            selection.value = new Set(rangeSelect(tiles.value, anchor.value ?? undefined, path) ?? [path]);
            ctx.lead.value = path;
            return;
        }
        const next = new Set(selection.value);
        if (!next.delete(path)) {
            next.add(path);
        }
        selection.value = next;
        anchor.value = path;
        ctx.lead.value = path;
    };
    const selectAll = (): void => {
        selection.value = new Set(tiles.value);
    };
    const clear = (): void => {
        selection.value = new Set();
        anchor.value = null;
        ctx.lead.value = undefined;
    };
    // Only what landed in the open folder is on screen to mark.
    const selectLanded = (paths: readonly string[]): void => {
        const last = paths.at(-1);
        if (last !== undefined && parentDir(last) === ctx.dir.value) {
            selection.value = new Set(paths);
            anchor.value = last;
            ctx.lead.value = last;
        }
    };
    // A lead set elsewhere collapses the set to it, or empties it off the tiles; a tile toggled out here is the anchor.
    watch(ctx.lead, (path) => {
        if (path === undefined || !tiles.value.includes(path)) {
            selection.value = new Set();
            anchor.value = null;
        } else if (!selection.value.has(path) && path !== anchor.value) {
            selectSingle(path);
        }
    });
    // Tiles that left the listing (deleted, moved, filtered) leave the selection too.
    watch(tiles, (list) => {
        const present = new Set(list);
        if ([...selection.value].some((path) => !present.has(path))) {
            selection.value = new Set([...selection.value].filter((path) => present.has(path)));
        }
    });
    const selecting = { selection, lead: anchor, selectSingle, selectLanded, clear };

    // The home shows one folder: nothing opens around a verb, and focus parks on the home once the name field closes.
    const inline = useInlineEdit((path) => store.entry(path) !== undefined || provisionalAt(path) !== undefined);
    const { beginRename, beginCreate, endEdit } = useTreeEdits({
        inline,
        byPath,
        rules,
        targetDir: here,
        openLanding: () => undefined,
        selectSingle,
        focusLead: async () => ctx.host.value?.focus({ preventScroll: true }),
        store,
        openCreated: ctx.openCreated,
    });
    const { requestDelete, keepFolder } = useTreeDelete({
        byPath,
        targetDir: here,
        rules,
        emptyDirs,
        selecting,
        store,
        say,
        sayDeleted: useDeleteUndo().sayDeleted,
    });
    const transfer = useTreeTransfer({
        tree: () => store.tree.value,
        rootDir: () => ``,
        byPath,
        childrenOf: (folder) => store.listingOf(folder.path) ?? [],
        targetDir: here,
        openLanding: () => undefined,
        openNest: () => undefined,
        rules,
        selecting,
        inline,
        el: ctx.host,
        store,
        uploads,
        say,
    });
    const terminalPanel = useTerminalPanel();
    const { menu, menuItems, openMenu } = useTreeMenu({
        rootDir: here,
        rowActions: ctx.dirActions,
        isBarren: emptyDirs.isBarren,
        rules,
        selecting,
        store,
        // A folder tile takes a paste itself, but a create lands in the open folder, where its tile can be seen.
        beginCreate: (_dir, type) => beginCreate(ctx.dir.value, type),
        beginRename,
        extract: transfer.extract,
        keepFolder,
        requestDelete,
        stage: transfer.stage,
        paste: transfer.paste,
        openTerminal: (dir) => terminalPanel.spawnShell(dir),
        // What a double-click does, for the keyboard and touch.
        frame: (target, multi) => ({
            head:
                target === undefined || multi
                    ? []
                    : [{ label: t(`ui.action.open`), icon: target.type === `dir` ? `folder-open` : `file`, command: () => ctx.open(target) }],
        }),
    });

    // F2 renames the lead only when it stands alone: a rename over a selection would name one of several.
    const renameLead = (): void => {
        const path = ctx.lead.value;
        if (path !== undefined && selection.value.has(path) && selection.value.size === 1) {
            beginRename(path);
        }
    };
    const KEY_VERBS: ReadonlyMap<string, () => void> = new Map([
        [`Delete`, requestDelete],
        [`F2`, renameLead],
    ]);
    // The keys the verbs answer (Delete, F2, select all); while a name is being typed, every key is the field's.
    const handleKey = (event: KeyboardEvent): boolean => {
        if (inline.editing.value) {
            return true;
        }
        const verb = (event.ctrlKey || event.metaKey) && (event.key === `a` || event.key === `A`) ? selectAll : KEY_VERBS.get(event.key);
        if (verb === undefined) {
            return false;
        }
        verb();
        event.preventDefault();
        return true;
    };

    return {
        selection,
        select,
        clear,
        rules,
        inline,
        endEdit,
        transfer,
        menu,
        menuItems,
        openMenu,
        handleKey,
    };
}
