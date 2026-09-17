import type { WorkspaceSearchGroup } from "@intentic/api-contract";
import { definePreference } from "@intentic/ui/preference";
import { parentDir } from "@intentic/ui/path";
import { type InjectionKey, type Ref, ref, watch } from "vue";
import type { RowAction } from "../explorer/rowActions";
import { workspaceDir } from "../health/workspaceScope";
import type { SearchScope } from "../search/useWorkspaceSearch";

// The desk: the main pane's "nothing open" surface drawn as large tiles of one folder. Opt-in, since it takes the
// place of the drop target a reader between files gets today. Which folder, and which entry is current, are
// module-level state shared with the explorer tree: a click in either view lands in the same two refs, so the other
// view marks what this one picked, and closing the last tab brings back the folder the reader left, not the root.

const STORAGE_KEY = `ui-workspace-desk`;

// A folder's own rows for the desk's menu (documents, personas, checks, management), composed by the workspace page,
// which holds the openers; provided rather than passed, since the desk is mounted by the pane, not the page.
export const DESK_DIR_ACTIONS: InjectionKey<(dir: string) => readonly RowAction[]> = Symbol(`desk-dir-actions`);

// The sidebar's search, as the desk reads and writes it: one query for both views. Name scope the desk answers itself
// over the loaded tree; text and smart are the daemon's, and the desk draws the files its groups name.
export interface DeskSearch {
    readonly filter: Ref<string>;
    readonly scope: Ref<"name" | SearchScope>;
    readonly contentMode: Ref<boolean>;
    readonly groups: Ref<readonly WorkspaceSearchGroup[]>;
    readonly searching: Ref<boolean>;
    readonly clear: () => void;
}
export const DESK_SEARCH: InjectionKey<DeskSearch> = Symbol(`desk-search`);

const desk: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `1`,
    write: (value) => (value ? `1` : `0`),
});

// Root-relative; the scope root ("" for the whole tree) is the desk's own root. An archive is a folder here: the desk
// enters `drop/photos.zip` and the daemon serves its contents.
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

// A click in the tree, or a file opening anywhere: a folder opens on the desk and is the current entry (the tree
// marks it, the desk shows its contents); a file becomes current in its own folder, so the desk is already there,
// with the file marked, when it next shows. The root is nobody's entry.
const pick = (path: string, type: "file" | "dir"): void => {
    if (type === `dir`) {
        openDir(path);
        selected.value = path === workspaceDir.value ? undefined : path;
        return;
    }
    openDir(parentDir(path));
    selected.value = path;
};

export function useDesk() {
    return { desk, deskDir, selected, openDir, pick };
}
