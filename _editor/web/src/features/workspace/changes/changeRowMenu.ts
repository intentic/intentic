import type { MenuItem } from "primevue/menuitem";
import { t } from "@intentic/ui/i18n";

// The right-click menu of a Changes row, VSCode's SCM set cut to what this panel can do: look (diff, file, where it sits
// in the tree), move it across the index or throw it away, and copy its path. Pure, so the rows it offers are pinned by
// a test rather than by clicking.

export interface ChangeRowVerbs {
    readonly openChanges: () => void;
    readonly openFile: () => void;
    readonly reveal: () => void;
    readonly stage: () => void;
    readonly discard: () => void;
    readonly copyPath: () => void;
    readonly copyRepoPath: () => void;
}

export interface ChangeRowMenuInput {
    // The right-clicked row sits in a larger selection, which the index verbs and the copies then act on.
    readonly multi: boolean;
    // Distinct paths the selection covers across both sides: what Discard and the copies touch.
    readonly paths: number;
    // Rows on the clicked row's own side: what the index verb moves.
    readonly sameSide: number;
    // The index verb for the row's side ("Stage", "Unstage", "Mark resolved") and its icon.
    readonly indexVerb: string;
    readonly indexIcon: string;
    // Gone from the worktree: nothing to open or reveal, only its diff.
    readonly deleted: boolean;
    // The repo is a folder inside the workspace, so a repo-relative path differs from the workspace one.
    readonly nested: boolean;
    // A git action is already running; the buttons beside the row are disabled then too.
    readonly busy: boolean;
    readonly verbs: ChangeRowVerbs;
}

const counted = (label: string, count: number, multi: boolean): string => (multi ? `${label} (${count})` : label);

export const changeRowMenuItems = (input: ChangeRowMenuInput): MenuItem[] => {
    const { multi, paths, sameSide, indexVerb, indexIcon, deleted, nested, busy, verbs } = input;
    // Opening and revealing name one file, so a selection keeps only the copies and the git verbs.
    const looks: MenuItem[] = multi
        ? []
        : [
              { label: t(`workspace.changeRowMenu.openChanges`), icon: `split-columns`, command: verbs.openChanges },
              ...(deleted
                  ? []
                  : [
                        { label: t(`workspace.changeRowMenu.openFile`), icon: `file`, command: verbs.openFile },
                        { label: t(`workspace.changeRowMenu.revealInExplorer`), icon: `folder-open`, command: verbs.reveal },
                    ]),
              { separator: true },
          ];
    return [
        ...looks,
        { label: counted(indexVerb, sameSide, multi), icon: indexIcon, disabled: busy, command: verbs.stage },
        { label: counted(t(`workspace.changeRowMenu.discardChanges`), paths, multi), icon: `trash`, disabled: busy, danger: true, command: verbs.discard },
        { separator: true },
        { label: multi ? t(`workspace.changeRowMenu.copyPaths`, { count: paths }) : t(`workspace.changeRowMenu.copyPath`), icon: `copy`, command: verbs.copyPath },
        ...(nested
            ? [
                  {
                      label: multi ? t(`workspace.changeRowMenu.copyRepoPaths`, { count: paths }) : t(`workspace.changeRowMenu.copyRepoPath`),
                      icon: `copy`,
                      command: verbs.copyRepoPath,
                  },
              ]
            : []),
    ];
};
