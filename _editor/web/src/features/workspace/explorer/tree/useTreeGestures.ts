import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import type { Ref } from "vue";
import { opensAsFolder } from "../../files/archiveEntries";
import type { OpenMode } from "../../tabs/workspaceTabs";
import { consumeSuppressedClick } from "../transfer/useEntryDrag";
import { type KeyIntent, keyIntent } from "./treeKeys";
import { holdsRows, type MoreRow, type Row } from "./treeRows";
import type { useTreeSelection } from "./useTreeSelection";

// What a press on the tree does: a row's click, double-click and chevron, the tree's background, and the keyboard
// (treeKeys.ts decides, this does). Activation opens a file, expands a folder or an archive, and explains a locked path.

export interface TreeGesturesHost {
    readonly rows: Readonly<Ref<readonly (Row | MoreRow)[]>>;
    readonly order: Readonly<Ref<readonly string[]>>;
    readonly byPath: Readonly<Ref<ReadonlyMap<string, WorkspaceTreeEntry>>>;
    // Dirs with a management surface, which keyboard activation also opens.
    readonly manageableDirs: () => ReadonlySet<string>;
    readonly selecting: ReturnType<typeof useTreeSelection>;
    readonly pending: (path: string) => boolean;
    readonly toggleExpand: (path: string) => void;
    // An open inline field owns its keys.
    readonly editing: Readonly<Ref<boolean>>;
    readonly beginRename: (path: string) => void;
    readonly requestDelete: () => void;
    readonly focusRow: (path: string) => void;
    readonly focusLead: () => Promise<void>;
    // A file to show: a click previews it into one slot, a double-click keeps the tab.
    readonly openFile: (path: string, mode: OpenMode) => void;
    readonly openDirectory: (path: string) => void;
    // The plain click or Enter itself, whatever it opens: the home follows it, so both views mark one entry.
    readonly pick: (entry: WorkspaceTreeEntry) => void;
    // The selection was dropped, so the home drops its own mark too.
    readonly cleared: () => void;
}

export const useTreeGestures = (host: TreeGesturesHost) => {
    const { selection, anchor, lead, selectSingle, extendTo, toggleAt, clear } = host.selecting;

    const activate = (entry: WorkspaceTreeEntry, revealManagedDir: boolean, mode: OpenMode): void => {
        // A locked folder opens its explanation like a locked file: there is nothing inside it to expand into.
        if (isLockedWorkspacePath(entry.path)) {
            host.openFile(entry.path, mode);
            return;
        }
        // A zip or tar expands like the folder it holds, rather than opening as a file.
        if (holdsRows(entry)) {
            host.toggleExpand(entry.path);
            // Keyboard activation (Enter) also reveals a managed dir's operator tab; a plain click just expands.
            if (revealManagedDir && host.manageableDirs().has(entry.path)) {
                host.openDirectory(entry.path);
            }
            return;
        }
        // A placeholder has no file behind it yet; opening one would read a path the daemon doesn't serve.
        if (host.pending(entry.path)) {
            return;
        }
        host.openFile(entry.path, mode);
    };

    // Shift ranges and Ctrl/Cmd toggles, neither activating; a plain click selects, picks and activates.
    const onRowClick = (event: MouseEvent, row: Row): void => {
        // The release that ended a drag lands here too; it was a drop, not a click.
        if (consumeSuppressedClick()) {
            return;
        }
        const path = row.entry.path;
        host.focusRow(path);
        if (event.shiftKey && anchor.value !== null) {
            extendTo(path);
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            toggleAt(path);
            return;
        }
        selectSingle(path);
        host.pick(row.entry);
        activate(row.entry, false, `preview`);
    };
    // Double-click keeps the tab the first click previewed; only a file has anything to keep. A directory just toggles on
    // each click and lands back where it started, as in VSCode's explorer.
    const onRowDblClick = (row: Row): void => {
        if (host.pending(row.entry.path)) {
            return;
        }
        if ((row.entry.type === `file` && !opensAsFolder(row.entry)) || isLockedWorkspacePath(row.entry.path)) {
            host.openFile(row.entry.path, `keep`);
        }
    };
    // A nest parent's chevron toggles directly, since its row click opens the file instead of expanding.
    const onChevronClick = (event: MouseEvent, row: Row): void => {
        if (row.nest === true) {
            event.stopPropagation();
            host.toggleExpand(row.entry.path);
        }
    };
    // A click on empty space drops the selection, like clicking a desktop's wallpaper; the lead stays for the keyboard.
    const onBackgroundClick = (): void => {
        clear();
        host.cleared();
    };

    // What each key intent does; a move of the selection or the cursor takes the focus with it.
    const ACTS: { readonly [K in KeyIntent["kind"]]: (intent: Extract<KeyIntent, { kind: K }>) => void } = {
        select: ({ path }) => {
            selectSingle(path);
            void host.focusLead();
        },
        extend: ({ path }) => {
            extendTo(path);
            void host.focusLead();
        },
        lead: ({ path }) => {
            lead.value = path;
            void host.focusLead();
        },
        toggleExpand: ({ path }) => host.toggleExpand(path),
        toggleSelected: ({ path }) => toggleAt(path),
        activate: ({ entry }) => {
            host.pick(entry);
            activate(entry, true, `preview`);
        },
        rename: ({ path }) => host.beginRename(path),
        deselect: () => {
            selection.value = new Set();
        },
        delete: host.requestDelete,
        selectAll: () => {
            selection.value = new Set(host.order.value);
        },
        none: () => undefined,
    };
    const onKeydown = (event: KeyboardEvent): void => {
        if (host.editing.value) {
            return;
        }
        const intent = keyIntent(event, {
            rows: host.rows.value,
            order: host.order.value,
            lead: lead.value,
            selected: selection.value.size,
            entryAt: (path) => host.byPath.value.get(path),
        });
        if (intent === undefined) {
            return;
        }
        (ACTS[intent.kind] as (intent: KeyIntent) => void)(intent);
        event.preventDefault();
    };

    return { onRowClick, onRowDblClick, onChevronClick, onBackgroundClick, onKeydown };
};
