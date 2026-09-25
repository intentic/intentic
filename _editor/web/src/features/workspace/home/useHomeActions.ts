import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { parentDir } from "@intentic/ui/path";
import { computed, type Ref } from "vue";
import type { RowAction } from "../explorer/rowActions";
import { createFileVerbs } from "../explorer/tree/fileVerbs";
import { fileVerbSeams } from "../explorer/tree/fileVerbSeams";
import { useEmptyDirs } from "../explorer/useEmptyDirs";
import { provisionalAt } from "../files/provisionalEntries";

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

export function useHomeActions(ctx: HomeActionsContext) {
    const seams = fileVerbSeams();
    const { store } = seams;
    const tiles = computed(() => ctx.order.value.map((tile) => tile.path));
    // Unlike the tree's, the lead here is the shared current entry, so every gesture here moves it.
    const lead = computed<string | null>({
        get: () => ctx.lead.value ?? null,
        set: (path) => {
            ctx.lead.value = path ?? undefined;
        },
    });
    // The home shows one folder: nothing opens around a verb, and focus parks on the home once the name field closes.
    const { selecting, inline, edits, deleting, transfer, menu: entryMenu, rules } = createFileVerbs({
        seams,
        byPath: store.entriesByPath,
        order: tiles,
        lead,
        rootDir: () => ctx.dir.value,
        tree: () => store.listingOf(ctx.dir.value) ?? [],
        childrenOf: (folder) => store.listingOf(folder.path) ?? [],
        targetDir: () => ctx.dir.value,
        // Only what landed in the open folder is on screen to mark.
        shows: (path) => parentDir(path) === ctx.dir.value,
        exists: (path) => store.entry(path) !== undefined || provisionalAt(path) !== undefined,
        el: ctx.host,
        emptyDirs: useEmptyDirs(() => store.barren.value),
        focusLead: async () => ctx.host.value?.focus({ preventScroll: true }),
        openCreated: ctx.openCreated,
        rowActions: ctx.dirActions,
        // A folder tile takes a paste itself, but a create lands in the open folder, where its tile can be seen.
        createIn: () => ctx.dir.value,
        // What a double-click does, for the keyboard and touch.
        frame: (target, multi) => ({
            head:
                target === undefined || multi
                    ? []
                    : [{ label: t(`ui.action.open`), icon: target.type === `dir` ? `folder-open` : `file`, command: () => ctx.open(target) }],
        }),
    });
    const { selection, select, selectAll, clear } = selecting;
    const { beginRename, endEdit } = edits;
    const { requestDelete } = deleting;
    const { menu, menuItems, openMenu } = entryMenu;

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
