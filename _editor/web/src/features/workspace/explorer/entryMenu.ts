import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { MenuItem } from "primevue/menuitem";

// The right-click menu both file surfaces (the tree, the desk) build: one list, so a verb never exists in one and not
// the other, and the wording of a bulk verb ("Delete 3 items") is decided once. Each surface supplies its own rows in
// the slots (`head`, `lead`, `tail`) and the closures behind the verbs. Pure, no framework code.

export interface EntryVerbs {
    readonly newFile: () => void;
    readonly newFolder: () => void;
    readonly rename: () => void;
    // Drops a placeholder into an empty folder chain so it stops counting as empty.
    readonly keepFolder: () => void;
    readonly remove: () => void;
    readonly cut: () => void;
    readonly copy: () => void;
    readonly paste: () => void;
}

export interface EntryMenuInput {
    // The right-clicked entry; undefined for a click on the surface's own background.
    readonly target: WorkspaceTreeEntry | undefined;
    // Kept private by the sandbox: the menu is just the explanation, since every verb would be refused.
    readonly locked: boolean;
    // A read-only member: write verbs are dropped, not disabled, and the tier is named once at the bottom.
    readonly canEdit: boolean;
    // The target sits inside a larger selection, which the bulk verbs then act on.
    readonly multi: boolean;
    // How many entries the bulk verbs would touch.
    readonly count: number;
    // The target is a folder holding only empty folders.
    readonly barren: boolean;
    readonly clipboardFull: boolean;
    // The surface's own rows: first of all (the desk's Open), after New Folder (a folder's documents, personas,
    // checks, management), and last (the tree's Collapse Folders). The read-only menu keeps the readable ones.
    readonly head?: readonly MenuItem[];
    readonly lead?: readonly MenuItem[];
    readonly tail?: readonly MenuItem[];
    readonly verbs: EntryVerbs;
}

const LOCKED_NOTE: MenuItem = { label: `Kept private by the sandbox`, icon: `lock`, disabled: true };
const READ_ONLY_NOTE: MenuItem = { label: `Read-only: changing files needs maintainer access`, icon: `lock`, disabled: true };

const withSeparator = (items: readonly MenuItem[]): MenuItem[] => (items.length === 0 ? [] : [{ separator: true }, ...items]);

const readOnlyMenu = ({ head = [], lead = [], tail = [] }: EntryMenuInput): MenuItem[] => {
    const readable = [...head, ...lead, ...tail];
    return [...readable, ...withSeparator([READ_ONLY_NOTE])];
};

const entryVerbs = ({ target, multi, count, barren, verbs }: EntryMenuInput): MenuItem[] => {
    if (target === undefined) {
        return [];
    }
    const items: MenuItem[] = [{ separator: true }];
    if (!multi) {
        items.push({ label: `Rename`, icon: `pencil`, command: verbs.rename });
    }
    // Marks a barren folder intentional via a placeholder: durable, visible to git, not a private exclusion flag.
    if (!multi && target.type === `dir` && barren) {
        items.push({ label: `Keep folder`, icon: `check-circle`, command: verbs.keepFolder });
    }
    items.push(
        { label: multi ? `Delete ${count} items` : `Delete`, icon: `trash`, command: verbs.remove },
        { separator: true },
        { label: multi ? `Cut ${count} items` : `Cut`, icon: `arrows-h`, command: verbs.cut },
        { label: multi ? `Copy ${count} items` : `Copy`, icon: `copy`, command: verbs.copy },
    );
    return items;
};

export const entryMenuItems = (input: EntryMenuInput): MenuItem[] => {
    if (input.locked) {
        return [LOCKED_NOTE];
    }
    if (!input.canEdit) {
        return readOnlyMenu(input);
    }
    const { head = [], lead = [], tail = [], verbs, clipboardFull } = input;
    return [
        ...head,
        ...(head.length > 0 ? [{ separator: true }] : []),
        { label: `New File`, icon: `file`, command: verbs.newFile },
        { label: `New Folder`, icon: `folder`, command: verbs.newFolder },
        ...lead,
        ...entryVerbs(input),
        ...(clipboardFull ? [{ label: `Paste`, icon: `clone`, command: verbs.paste }] : []),
        ...withSeparator(tail),
    ];
};
