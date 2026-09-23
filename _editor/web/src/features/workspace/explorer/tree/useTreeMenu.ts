import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { parentDir } from "@intentic/ui/path";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { type EntryVerbs, entryMenuItems } from "../entryMenu";
import type { RowAction } from "../rowActions";
import type { useWorkspaceTree } from "../useWorkspaceTree";
import type { useTreeRules } from "./useTreeRules";
import type { useTreeSelection } from "./useTreeSelection";

// The right-click menu (entryMenu.ts), acting on the whole selection when the right-clicked row is part of it, and a
// directory's own actions, which its row offers as hover icons and the menu as text.

export interface TreeMenuHost {
    // Where a right-click on empty space acts: the tree's own root, the open project when one is.
    readonly rootDir: () => string;
    // A directory's own actions, none when the surface supplied no source.
    readonly rowActions: (dir: string) => readonly RowAction[];
    readonly isBarren: (path: string) => boolean;
    readonly rules: Pick<ReturnType<typeof useTreeRules>, "archiveDir" | "unlockedOnly">;
    readonly selecting: Pick<ReturnType<typeof useTreeSelection>, "selection" | "selectSingle">;
    readonly store: Pick<ReturnType<typeof useWorkspaceTree>, "canEditFiles" | "clipboard" | "expanded" | "collapseAll">;
    readonly beginCreate: (dir: string, type: "file" | "dir") => void;
    readonly beginRename: (path: string) => void;
    readonly extract: (path: string) => Promise<void>;
    readonly keepFolder: (path: string) => Promise<void>;
    readonly requestDelete: () => void;
    readonly stage: (mode: "copy" | "cut", system: "async" | "event") => readonly string[];
    readonly paste: (dir: string) => Promise<void>;
}

export const useTreeMenu = (host: TreeMenuHost) => {
    const { selection, selectSingle } = host.selecting;
    const menu = ref<{ show: (event: Event) => void } | undefined>(undefined);
    const menuEntry = ref<WorkspaceTreeEntry | undefined>(undefined);

    // Selects the row before running its action, so the highlight follows what was just opened.
    const runAction = (entry: WorkspaceTreeEntry, action: RowAction): void => {
        selectSingle(entry.path);
        action.run();
    };
    // Text rows for a directory's hover-only icons, unreachable by touch or keyboard otherwise: the one non-pointer route to
    // its document and its management panel. Read-only, so they stay in the read-only menu too.
    const dirActionItems = (target: WorkspaceTreeEntry | undefined, multi: boolean): MenuItem[] =>
        target?.type === `dir` && !multi
            ? host.rowActions(target.path).map((action) => ({ label: action.tooltip, icon: action.icon, command: () => runAction(target, action) }))
            : [];
    // The verbs of a menu opened on `target` (undefined for the background), acting in `dir`.
    const verbsFor = (target: WorkspaceTreeEntry | undefined, dir: string): EntryVerbs => ({
        newFile: () => host.beginCreate(dir, `file`),
        newFolder: () => host.beginCreate(dir, `dir`),
        rename: () => {
            if (target !== undefined) {
                host.beginRename(target.path);
            }
        },
        extract: () => {
            if (target !== undefined) {
                void host.extract(target.path);
            }
        },
        keepFolder: () => {
            if (target !== undefined) {
                void host.keepFolder(target.path);
            }
        },
        remove: host.requestDelete,
        cut: () => {
            host.stage(`cut`, `async`);
        },
        copy: () => {
            host.stage(`copy`, `async`);
        },
        paste: () => void host.paste(dir),
    });
    // A right-click on empty space acts in the tree's OWN root: `` would aim every verb at /work from inside a project.
    const dirOf = (target: WorkspaceTreeEntry | undefined): string => {
        if (target === undefined) {
            return host.rootDir();
        }
        return target.type === `dir` ? target.path : parentDir(target.path);
    };

    const menuItems = computed<MenuItem[]>(() => {
        const target = menuEntry.value;
        const multi = target !== undefined && selection.value.size > 1 && selection.value.has(target.path);
        const dir = dirOf(target);
        return entryMenuItems({
            target,
            locked: target !== undefined && isLockedWorkspacePath(target.path),
            canEdit: host.store.canEditFiles.value,
            // The folder the verbs would act in decides it: the archive's own row keeps its verbs, a row inside it does not.
            archived: host.rules.archiveDir(dir),
            multi,
            count: host.rules.unlockedOnly([...selection.value]).length,
            barren: target?.type === `dir` && host.isBarren(target.path),
            clipboardFull: host.store.clipboard.value !== undefined,
            lead: dirActionItems(target, multi),
            tail:
                host.store.expanded.value.size > 0
                    ? [{ label: t(`workspace.workspaceTree.collapseFolders`), icon: `collapse-all`, command: host.store.collapseAll }]
                    : [],
            verbs: verbsFor(target, dir),
        });
    });
    // Right-clicking outside the current selection collapses it to that one row; inside a multi-selection keeps it.
    const openMenu = (event: MouseEvent, entry: WorkspaceTreeEntry | undefined): void => {
        menuEntry.value = entry;
        if (entry !== undefined && !selection.value.has(entry.path)) {
            selectSingle(entry.path);
        }
        menu.value?.show(event);
    };

    return { menu, menuItems, openMenu, runAction };
};
