import type { WorkspaceSearchGroup } from "@intentic/api-contract";
import { parentDir } from "@intentic/ui/path";
import { sandboxRef } from "@intentic/extension-api";
import { type InjectionKey, type Ref, watch } from "vue";
import type { RowAction } from "../explorer/rowActions";
import { withinScope } from "../../../app/projectScope";
import { workspaceDir } from "../health/workspaceScope";
import type { SearchScope } from "../search/useWorkspaceSearch";

// The home: the main pane's "nothing open" surface drawn as large tiles of one folder. Which folder, and which entry
// is current, are module-level state shared with the explorer tree: a click in either view lands in the same two refs,
// so the other view marks what this one picked, and closing the last tab brings back the folder the reader left, not
// the root.

// A folder's own rows for the home's menu (documents, personas, checks, management), composed by the workspace page,
// which holds the openers; provided rather than passed, since the home is mounted by the pane, not the page.
export const HOME_DIR_ACTIONS: InjectionKey<(dir: string) => readonly RowAction[]> = Symbol(`home-dir-actions`);

// The sidebar's search, as the home reads and writes it: one query for both views. Name scope the home answers itself
// over the loaded tree; text and smart are the daemon's, and the home draws the files its groups name.
export interface HomeSearch {
    readonly filter: Ref<string>;
    readonly scope: Ref<"name" | SearchScope>;
    readonly contentMode: Ref<boolean>;
    readonly groups: Ref<readonly WorkspaceSearchGroup[]>;
    readonly searching: Ref<boolean>;
    readonly clear: () => void;
}
export const HOME_SEARCH: InjectionKey<HomeSearch> = Symbol(`home-search`);

// Root-relative; the scope root ("" for the whole tree) is the home's own root. An archive is a folder here: the home
// enters `drop/photos.zip` and the daemon serves its contents. A switch is a different /work, so it starts at the root.
const homeDir = sandboxRef<string>(() => workspaceDir.value);
// The current entry: what the last click, in the tree or on the home, landed on. Undefined after entering a folder.
const selected = sandboxRef<string | undefined>(() => undefined);

// Re-roots when the scope moves: a folder path means nothing under a different project root.
watch(workspaceDir, (root) => {
    homeDir.value = root;
    selected.value = undefined;
});

// A path outside the open project names nothing this home can show, so it opens at the project's own floor instead.
const openDir = (dir: string): void => {
    homeDir.value = withinScope(dir) ? dir : workspaceDir.value;
};

// A click in the tree, or a file opening anywhere: a folder opens on the home and is the current entry (the tree
// marks it, the home shows its contents); a file becomes current in its own folder, so the home is already there,
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

export function useHome() {
    return { homeDir, selected, openDir, pick };
}
