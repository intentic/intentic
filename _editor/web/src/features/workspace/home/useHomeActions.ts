import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { t } from "@intentic/ui/i18n";
import { isApplePlatform } from "@intentic/ui/keys";
import { parentDir } from "@intentic/ui/path";
import { computed, type Ref } from "vue";
import type { RowAction } from "../explorer/rowActions";
import { createFileVerbs } from "../explorer/tree/fileVerbs";
import { fileVerbSeams } from "../explorer/tree/fileVerbSeams";
import { useEmptyDirs } from "../explorer/useEmptyDirs";
import { opensAsFolder } from "../../../models/workspace/files/archiveEntries";
import { provisionalAt } from "../../../models/workspace/files/provisionalEntries";
import { homeKeyVerb, type HomeKeyVerbs } from "./homeKeys";

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
    // Up to the folder holding this one (a Mac's ⌘↑).
    readonly up: () => void;
    // A file just created opens straight into editing.
    readonly openCreated: (path: string) => void;
    // Reads a file's name in every folder in place of the tiles (homeCover.ts): the file right-clicked is the example.
    readonly cover: (name: string) => void;
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
        // What a double-click does, for the keyboard and touch; beside a file, reading its name in every folder.
        frame: (target, multi) => ({
            head:
                target === undefined || multi
                    ? []
                    : [
                          { label: t(`ui.action.open`), icon: target.type === `dir` ? `folder-open` : `file`, command: () => ctx.open(target) },
                          ...(target.type === `file` && !opensAsFolder(target)
                              ? [{ label: t(`workspace.homeCover.showInEveryFolder`, { name: target.name }), icon: `book`, command: () => ctx.cover(target.name) }]
                              : []),
                      ],
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
    const isMac = isApplePlatform();
    const keyVerbs: HomeKeyVerbs = {
        remove: requestDelete,
        rename: renameLead,
        selectAll,
        duplicate: () => void transfer.duplicate(),
        moveHere: () => void transfer.moveHere(),
        open: () => {
            const entry = ctx.lead.value === undefined ? undefined : store.entry(ctx.lead.value);
            if (entry !== undefined) {
                ctx.open(entry);
            }
        },
        up: ctx.up,
    };
    // The keys the verbs answer (homeKeys.ts); while a name is being typed, every key is the field's.
    const handleKey = (event: KeyboardEvent): boolean => {
        if (inline.editing.value) {
            return true;
        }
        const verb = homeKeyVerb(event, isMac, keyVerbs);
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
