import { clipboardOf, type IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { commandShortcut } from "./useCommands";

// THE FILE-TAB RIGHT-CLICK, one menu wherever a file's tab stands: the Workspace's strip (either pane) and the side
// panel's (beside the chat, in the main window or a popped-out one). Same rows in the same order, each with its glyph
// and its surface's chord, so the habit learned on one strip holds on the other. A surface supplies only what it can
// do; a row it cannot act on right now is drawn disabled rather than dropped, so the menu keeps its shape.

// The strips that carry file tabs; their commands are `<surface>.closeTab` and the rest (builtinCommands.ts).
export type FileTabSurface = `side` | `workspace`;

// Where the tab can go from here: the Workspace's other pane, or the main area from beside the chat.
export interface TabMenuPlace {
    readonly label: string;
    readonly icon: IconName;
    readonly command: string;
    readonly disabled?: boolean;
    readonly run: () => void;
}

// The rows about the strip as a whole, which a right-click on its empty space shows on their own.
export interface TabStripActions {
    // Undefined with nothing open.
    readonly closeAll?: () => void;
    // Undefined with nothing to bring back.
    readonly reopen?: () => void;
}

export interface TabMenuActions extends TabStripActions {
    // Only on the preview (italic) tab.
    readonly keep?: () => void;
    readonly place?: TabMenuPlace;
    readonly close: () => void;
    // Undefined when there is nothing for them to close: drawn disabled.
    readonly closeOthers?: () => void;
    readonly closeToRight?: () => void;
    // Only tabs that name a path: the path, and the element of the window the menu is drawn in, whose clipboard it goes to
    // (clipboardOf; a popped-out window's own).
    readonly copyPath?: { readonly path: string; readonly root: () => Element | undefined };
}

// Groups rather than inline separators: most rows are conditional, and an inline separator would draw a line under a
// group that turned out empty.
const joinGroups = (groups: readonly (readonly MenuItem[])[]): MenuItem[] => {
    const items: MenuItem[] = [];
    for (const group of groups.filter((candidate) => candidate.length > 0)) {
        if (items.length > 0) {
            items.push({ separator: true });
        }
        items.push(...group);
    }
    return items;
};

const writePath = ({ path, root }: NonNullable<TabMenuActions[`copyPath`]>): void => {
    // A clipboard the page may not write (no focus, permission refused) leaves nothing to recover.
    // allow(silent-catch): the path is still on the tab's hover card, and a menu row has nowhere to say it failed.
    void clipboardOf(root()).writeText(path).catch(() => undefined);
};

export const tabStripMenu = (surface: FileTabSurface, actions: TabStripActions): MenuItem[] => [
    ...(actions.closeAll === undefined
        ? []
        : [{ label: t(`workspace.workspaceDesktop.closeAll`), shortcut: commandShortcut(`${surface}.closeAllTabs`), command: actions.closeAll }]),
    ...(actions.reopen === undefined
        ? []
        : [
              {
                  label: t(`workspace.workspaceDesktop.reopenClosedTab`),
                  shortcut: commandShortcut(`${surface}.reopenClosedTab`),
                  command: actions.reopen,
              },
          ]),
];

export const fileTabMenu = (surface: FileTabSurface, actions: TabMenuActions): MenuItem[] => {
    const { keep, place, closeOthers, closeToRight, copyPath } = actions;
    return joinGroups([
        // Promotes the preview tab, as the double-click does.
        keep === undefined ? [] : [{ label: t(`ui.action.keepOpen`), icon: `pin`, shortcut: commandShortcut(`${surface}.keepTab`), command: keep }],
        place === undefined
            ? []
            : [{ label: place.label, icon: place.icon, disabled: place.disabled === true, shortcut: commandShortcut(place.command), command: place.run }],
        [
            { label: t(`ui.action.close`), icon: `times`, shortcut: commandShortcut(`${surface}.closeTab`), command: actions.close },
            {
                label: t(`workspace.workspaceDesktop.closeOthers`),
                disabled: closeOthers === undefined,
                shortcut: commandShortcut(`${surface}.closeOtherTabs`),
                command: () => closeOthers?.(),
            },
            {
                label: t(`ui.action.closeToRight`),
                disabled: closeToRight === undefined,
                shortcut: commandShortcut(`${surface}.closeTabsToRight`),
                command: () => closeToRight?.(),
            },
        ],
        tabStripMenu(surface, actions),
        copyPath === undefined ? [] : [{ label: t(`workspace.workspaceDesktop.copyPath`), icon: `copy`, command: () => writePath(copyPath) }],
    ]);
};
