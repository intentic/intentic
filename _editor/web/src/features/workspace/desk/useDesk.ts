import { definePreference } from "@intentic/ui/preference";
import { parentDir } from "@intentic/ui/path";
import { type InjectionKey, type Ref, ref, watch } from "vue";
import type { RowAction } from "../explorer/rowActions";
import { workspaceDir } from "../health/workspaceScope";

// The desk: the main pane's "nothing open" surface drawn as large tiles of one folder. Opt-in, since it takes the
// place of the drop target a reader between files gets today. Which folder, and which entry is current, are
// module-level state shared with the explorer tree: a click in either view lands in the same two refs, so the other
// view marks what this one picked, and closing the last tab brings back the folder the reader left, not the root.

const STORAGE_KEY = `ui-workspace-desk`;

// A folder's own rows for the desk's menu (documents, personas, checks, management), composed by the workspace page,
// which holds the openers; provided rather than passed, since the desk is mounted by the pane, not the page.
export const DESK_DIR_ACTIONS: InjectionKey<(dir: string) => readonly RowAction[]> = Symbol(`desk-dir-actions`);

const desk: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `1`,
    write: (value) => (value ? `1` : `0`),
});

// Root-relative; the scope root ("" for the whole tree) is the desk's own root.
const deskDir = ref<string>(workspaceDir.value);
// The current entry: what the last click, in the tree or on the desk, landed on. Undefined after entering a folder.
const selected = ref<string | undefined>(undefined);

// Whether `dir` lies at or under the scope root; a path outside it names nothing this desk can show.
const withinScope = (dir: string, root: string): boolean => root === `` || dir === root || dir.startsWith(`${root}/`);

// Re-roots when the scope moves: a folder path means nothing under a different project root.
watch(workspaceDir, (root) => {
    deskDir.value = root;
    selected.value = undefined;
});

// A sandbox switch is a different /work; the folder the reader was in is not there.
export const resetDesk = (): void => {
    deskDir.value = workspaceDir.value;
    selected.value = undefined;
};

const openDir = (dir: string): void => {
    deskDir.value = withinScope(dir, workspaceDir.value) ? dir : workspaceDir.value;
};

// A click in the tree, or a file opening anywhere: a folder opens on the desk; a file becomes current in its own
// folder, so the desk is already there, with the file marked, when it next shows.
const pick = (path: string, type: "file" | "dir"): void => {
    if (type === `dir`) {
        openDir(path);
        selected.value = undefined;
        return;
    }
    openDir(parentDir(path));
    selected.value = path;
};

export function useDesk() {
    return { desk, deskDir, selected, openDir, pick };
}
