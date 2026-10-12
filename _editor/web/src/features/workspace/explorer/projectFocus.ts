import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { t } from "@intentic/ui/i18n";

// Where the project scope (app/projectScope.ts) is chosen in the tree: the right-click menu of a repository's own row
// narrows the shell to it, and while one is open the menu of the tree's background widens it back. The scope has no rail
// tile, so it is chosen where the files it narrows are, and the palette's Project commands are the keyboard's way to it
// (shell/commands/useProjectCommands.ts). Pure, so the rows can be checked without a tree.

export interface ProjectFocus {
    // Repository ids under the workspace root, the workspace's own repository (`root`) left out: it is not a project.
    readonly projects: ReadonlySet<string>;
    // The open project, undefined while the whole workspace is shown.
    readonly current: string | undefined;
    readonly focus: (project: string | undefined) => void;
}

export interface ProjectFocusRows {
    // Opens the menu, beside the surface's other opening rows: narrowing is a way into the folder.
    readonly head: readonly MenuItem[];
    // Closes it, beside Collapse Folders: what the whole tree shows, not what one row is.
    readonly tail: readonly MenuItem[];
}

const NONE: ProjectFocusRows = { head: [], tail: [] };

export const projectFocusRows = (target: WorkspaceTreeEntry | undefined, multi: boolean, focus: ProjectFocus): ProjectFocusRows => {
    if (target === undefined) {
        return focus.current === undefined
            ? NONE
            : { head: [], tail: [{ label: t(`workspace.workspaceScopeNote.showEverything`), icon: `th-large`, command: () => focus.focus(undefined) }] };
    }
    // One repository's row, and not the one already open: a selection of several has no one project to narrow to.
    if (multi || target.type !== `dir` || !focus.projects.has(target.path) || target.path === focus.current) {
        return NONE;
    }
    return { head: [{ label: t(`workspace.projectFocus.showOnly`), icon: `filter`, command: () => focus.focus(target.path) }], tail: [] };
};

// The repository ids that are projects: every one the daemon found but the workspace's own.
export const projectIdsOf = (repos: readonly string[]): ReadonlySet<string> => new Set(repos.filter((id) => id !== `root`));
