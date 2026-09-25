import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { archiveFormat } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { t } from "@intentic/ui/i18n";

// The right-click menu both file surfaces (the tree, the home) build: one list, so a verb never exists in one and not
// the other, and the wording of a bulk verb ("Delete 3 items") is decided once. Each surface supplies its own rows in
// the slots (`head`, `lead`, `tail`) and the closures behind the verbs. Pure, no framework code.

export interface EntryVerbs {
    readonly newFile: () => void;
    readonly newFolder: () => void;
    readonly rename: () => void;
    // Unpacks an archive into a new entry beside it; the daemon names it, having seen what is inside.
    readonly extract: () => void;
    // Drops a placeholder into an empty folder chain so it stops counting as empty.
    readonly keepFolder: () => void;
    readonly remove: () => void;
    readonly cut: () => void;
    readonly copy: () => void;
    readonly paste: () => void;
    // Starts a shell in the right-clicked folder.
    readonly openTerminal: () => void;
}

export interface EntryMenuInput {
    // The right-clicked entry; undefined for a click on the surface's own background.
    readonly target: WorkspaceTreeEntry | undefined;
    // Kept private by the sandbox: the menu is just the explanation, since every verb would be refused.
    readonly locked: boolean;
    // A read-only member: write verbs are dropped, not disabled, and the tier is named once at the bottom.
    readonly canEdit: boolean;
    // The target is an archive's contents. Read verbs only: nothing here repacks a zip, and Extract is how you get
    // something changeable.
    readonly archived: boolean;
    // The target sits inside a larger selection, which the bulk verbs then act on.
    readonly multi: boolean;
    // How many entries the bulk verbs would touch.
    readonly count: number;
    // The target is a folder holding only empty folders.
    readonly barren: boolean;
    readonly clipboardFull: boolean;
    // The surface's own rows: first of all (the home's Open), after New Folder (a folder's documents, personas,
    // checks, management), and last (the tree's Collapse Folders). The read-only menu keeps the readable ones.
    readonly head?: readonly MenuItem[];
    readonly lead?: readonly MenuItem[];
    readonly tail?: readonly MenuItem[];
    readonly verbs: EntryVerbs;
}

const lockedNote = (): MenuItem => ({ label: t(`workspace.words.keptPrivateBySandbox`), icon: `lock`, disabled: true });
const readOnlyNote = (): MenuItem => ({ label: t(`workspace.words.readOnlyChangingFiles`), icon: `lock`, disabled: true });
const archiveNote = (): MenuItem => ({ label: t(`workspace.words.insideArchiveExtractTo`), icon: `box`, disabled: true });

const withSeparator = (items: readonly MenuItem[]): MenuItem[] => (items.length === 0 ? [] : [{ separator: true }, ...items]);

const readOnlyMenu = ({ head = [], lead = [], tail = [] }: EntryMenuInput): MenuItem[] => joinGroups(head, lead, tail, [readOnlyNote()]);

// Joins the groups that have rows, a rule between them, so a menu never opens or closes on a separator.
const joinGroups = (...groups: readonly (readonly MenuItem[])[]): MenuItem[] =>
    groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? [...group] : [{ separator: true }, ...group]));

// An archive's contents: what can be read, plus the one verb that gets something out of it. A folder's own rows
// (`lead`) are dropped with the rest, since none of them mean anything about a copy the daemon keeps out of sight.
const archiveMenu = ({ target, multi, count, head = [], tail = [], verbs }: EntryMenuInput): MenuItem[] =>
    joinGroups(head, target === undefined ? [] : [{ label: multi ? `Copy ${count} items` : `Copy`, icon: `copy`, command: verbs.copy }], tail, [
        archiveNote(),
    ]);

// The rows that can only ever name one entry, which is why a bulk selection has none of them.
const soleVerbs = (target: WorkspaceTreeEntry, barren: boolean, verbs: EntryVerbs): MenuItem[] => {
    const items: MenuItem[] = [];
    // Offered by the same rule the daemon unpacks by, so the row can't promise what it would then refuse.
    if (target.type === `file` && archiveFormat(target.name) !== undefined) {
        items.push({ label: t(`workspace.entryMenu.extract`), icon: `box`, command: verbs.extract });
    }
    items.push({ label: t(`ui.action.rename`), icon: `pencil`, command: verbs.rename });
    // Marks a barren folder intentional via a placeholder: durable, visible to git, not a private exclusion flag.
    if (target.type === `dir` && barren) {
        items.push({ label: t(`workspace.entryMenu.keepFolder`), icon: `check-circle`, command: verbs.keepFolder });
    }
    return items;
};

const entryVerbs = ({ target, multi, count, barren, verbs }: EntryMenuInput): MenuItem[] => {
    if (target === undefined) {
        return [];
    }
    return [
        { separator: true },
        ...(multi ? [] : soleVerbs(target, barren, verbs)),
        { label: multi ? `Delete ${count} items` : `Delete`, icon: `trash`, command: verbs.remove },
        { separator: true },
        { label: multi ? `Cut ${count} items` : `Cut`, icon: `arrows-h`, command: verbs.cut },
        { label: multi ? `Copy ${count} items` : `Copy`, icon: `copy`, command: verbs.copy },
    ];
};

export const entryMenuItems = (input: EntryMenuInput): MenuItem[] => {
    if (input.locked) {
        return [lockedNote()];
    }
    if (!input.canEdit) {
        return readOnlyMenu(input);
    }
    if (input.archived) {
        return archiveMenu(input);
    }
    const { head = [], lead = [], tail = [], verbs, clipboardFull } = input;
    return [
        ...head,
        ...(head.length > 0 ? [{ separator: true }] : []),
        { label: t(`workspace.entryMenu.newFile`), icon: `file`, command: verbs.newFile },
        { label: t(`workspace.entryMenu.newFolder`), icon: `folder`, command: verbs.newFolder },
        ...lead,
        ...(input.target?.type === `dir` && !input.multi
            ? [{ label: t(`workspace.entryMenu.openTerminal`), icon: `terminal`, command: verbs.openTerminal }]
            : []),
        ...entryVerbs(input),
        ...(clipboardFull ? [{ label: t(`ui.action.paste`), icon: `clone`, command: verbs.paste }] : []),
        ...withSeparator(tail),
    ];
};
