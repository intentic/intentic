import { archiveFormat } from "@intentic/sandbox-contract/formats/archives";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import type { MenuItem } from "primevue/menuitem";
import { t } from "@intentic/ui/i18n";
import { formatChord } from "../../../workbench/commands/keybindings";
import { accessWords } from "../../../client/sandbox/access/accessWords";
import { belowMaintainer } from "../../../components/heldPlace";

// The right-click menu both file surfaces (the tree, the home) build: one list, so a verb never exists in one and not
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
    // The verbs below are ones a surface may not have, and one it was not handed is left out of the menu: a folder on
    // this computer has no shell, no archive to unpack into, and nowhere to download to, being already there (fileVerbs.ts'
    // seams), and only its window has a way to an agent.
    // Unpacks an archive into a new entry beside it; the daemon names it, having seen what is inside.
    readonly extract?: () => void;
    // Starts a shell in the right-clicked folder.
    readonly openTerminal?: () => void;
    // Saves the entry, or the whole selection, onto this computer; a folder or several entries come as one ZIP.
    readonly download?: () => void;
    // Asks an agent about the one file right-clicked: the desktop app's way from a folder on this computer to an agent.
    readonly ask?: () => void;
    // A copy of each entry beside itself, under a free name.
    readonly duplicate?: () => void;
    // What was copied, moved here instead (a Mac's ⌥⌘V); offered only while the clipboard holds a copy.
    readonly moveHere?: () => void;
    // Puts the entry's workspace path, or the selection's one per line, on the clipboard as text.
    readonly copyPath?: () => void;
}

// The key each verb answers to on the surface, drawn at the right of its row: how a reader learns them.
export interface EntryKeys {
    readonly rename: string;
    readonly remove: string;
    readonly cut: string;
    readonly copy: string;
    readonly paste: string;
    readonly duplicate?: string;
    readonly moveHere?: string;
}

/** The file surfaces' keys on this platform (treeKeys.ts): Finder's on a Mac, Explorer's and VS Code's elsewhere. */
export const entryKeys = (isMac: boolean): EntryKeys =>
    isMac
        ? {
              rename: formatChord(`Enter`, true),
              remove: formatChord(`Mod+Backspace`, true),
              cut: formatChord(`Mod+X`, true),
              copy: formatChord(`Mod+C`, true),
              paste: formatChord(`Mod+V`, true),
              duplicate: formatChord(`Mod+D`, true),
              moveHere: formatChord(`Mod+Alt+V`, true),
          }
        : { rename: `F2`, remove: formatChord(`Delete`, false), cut: formatChord(`Mod+X`, false), copy: formatChord(`Mod+C`, false), paste: formatChord(`Mod+V`, false) };

export interface EntryMenuInput {
    // The right-clicked entry; undefined for a click on the surface's own background.
    readonly target: WorkspaceTreeEntry | undefined;
    // Kept private by the sandbox: the menu is just the explanation, since every verb would be refused.
    readonly locked: boolean;
    // The target, or the selection it sits in, holds `.intentic` or one of its groups, which stay where they are: Rename,
    // Delete and Cut are left out and a note at the bottom says why. Everything else, writing inside included, stays.
    readonly kept: boolean;
    // Whether the member may change what the verbs would act on (their tier and edit fence): when not, write verbs are
    // dropped, not disabled, and why is said once at the bottom.
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
    // The clipboard holds a copy rather than a cut, which is when Move Here differs from Paste.
    readonly clipboardCopied?: boolean;
    // The keys drawn beside the verbs; none drawn without them.
    readonly keys?: EntryKeys;
    // The surface's own rows: first of all (the home's Open), after New Folder (a folder's documents, personas,
    // checks, management), and last (the tree's Collapse Folders). The read-only menu keeps the readable ones.
    readonly head?: readonly MenuItem[];
    readonly lead?: readonly MenuItem[];
    readonly tail?: readonly MenuItem[];
    readonly verbs: EntryVerbs;
    // Whether the backend answers a contract route (`supportsRoute`): a verb whose route it does not serve is left out
    // rather than offered to fail. Everything is served when absent.
    readonly serves?: (route: string) => boolean;
}

// The contract route behind each verb a backend may not serve. A folder on the user's own computer serves none of them
// (the desktop app's sidecar, which says what it does serve). New File and Keep folder write through the upload route
// every backend has, Paste pastes only what Cut or Copy staged, and Download is below.
export const VERB_ROUTES = {
    newFolder: `workspace.mkdir`,
    rename: `workspace.move`,
    cut: `workspace.move`,
    copy: `workspace.copy`,
    remove: `workspace.delete`,
    extract: `workspace.extract`,
    openTerminal: `system.terminals`,
} as const satisfies Partial<Record<keyof EntryVerbs, string>>;

// A folder or a selection downloads as one ZIP the backend writes, by a download ticket. One file is always on offer: it
// comes by a media ticket, or from its bytes where the backend mints none (downloadEntries.ts).
export const ZIP_ROUTE = `workspace.downloadTicket`;

const offers = (input: Pick<EntryMenuInput, "serves">, route: string): boolean => input.serves?.(route) ?? true;

// A verb's row with its key beside it, when the surface named one.
const keyed = (item: MenuItem, keys: string | undefined): MenuItem => (keys === undefined ? item : { ...item, shortcut: keys });

const lockedNote = (): MenuItem => ({ label: t(`workspace.words.keptPrivateBySandbox`), icon: `lock`, disabled: true });
// Read-only here, whether below the writer tier or outside the folders a writer edits: the one line every surface says it in.
const readOnlyNote = (): MenuItem => ({ label: accessWords({ kind: `tier`, floor: `writer` }).note, icon: `lock`, disabled: true });
const archiveNote = (): MenuItem => ({ label: t(`workspace.words.insideArchiveExtractTo`), icon: `box`, disabled: true });
const keptNote = (): MenuItem => ({ label: t(`workspace.words.keptInPlaceBySandbox`), icon: `lock`, disabled: true });

const withSeparator = (items: readonly MenuItem[]): MenuItem[] => (items.length === 0 ? [] : [{ separator: true }, ...items]);

// Says up front that a folder or a selection arrives zipped, so the file that lands is the one the row promised.
const downloadRow = (input: EntryMenuInput): MenuItem[] => {
    const { target, multi, count, verbs } = input;
    if (target === undefined || verbs.download === undefined || ((multi || target.type === `dir`) && !offers(input, ZIP_ROUTE))) {
        return [];
    }
    const label = multi
        ? t(`workspace.entryMenu.downloadItems`, { count })
        : target.type === `dir`
          ? t(`workspace.entryMenu.downloadZip`)
          : t(`workspace.entryMenu.download`);
    return [{ label, icon: `download`, command: verbs.download }];
};

// Changes nothing and is read anywhere, so every menu with a target has it: the read-only one and an archive's too.
const copyPathRow = ({ target, multi, count, verbs }: EntryMenuInput): MenuItem[] =>
    target === undefined || verbs.copyPath === undefined
        ? []
        : [
              {
                  label: multi ? t(`workspace.entryMenu.copyPaths`, { count }) : t(`workspace.entryMenu.copyPath`),
                  icon: `link`,
                  command: verbs.copyPath,
              },
          ];

// Changes nothing, so a reader keeps it too; one file only, since the conversation it starts is about that file.
const askRow = ({ target, multi, verbs }: EntryMenuInput): MenuItem[] =>
    target?.type === `file` && !multi && verbs.ask !== undefined ? [{ label: t(`local.entryMenu.askAgent`), icon: `robot`, command: verbs.ask }] : [];

// A download changes nothing, so a reader keeps it.
const readOnlyMenu = (input: EntryMenuInput): MenuItem[] => {
    const { head = [], lead = [], tail = [] } = input;
    return joinGroups(head, askRow(input), lead, [...copyPathRow(input), ...downloadRow(input)], tail, [readOnlyNote()]);
};

// Joins the groups that have rows, a rule between them, so a menu never opens or closes on a separator.
const joinGroups = (...groups: readonly (readonly MenuItem[])[]): MenuItem[] =>
    groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? [...group] : [{ separator: true }, ...group]));

// An archive's contents: what can be read, plus the one verb that gets something out of it. A folder's own rows
// (`lead`) are dropped with the rest, since none of them mean anything about a copy the daemon keeps out of sight.
const archiveMenu = (input: EntryMenuInput): MenuItem[] => {
    const { target, multi, count, head = [], tail = [], verbs } = input;
    const copyRow: MenuItem[] = offers(input, VERB_ROUTES.copy)
        ? [{ label: multi ? t(`workspace.entryMenu.copyItems`, { count }, count) : t(`ui.action.copy`), icon: `copy`, command: verbs.copy }]
        : [];
    const reads: MenuItem[] = target === undefined ? [] : [...copyRow, ...copyPathRow(input), ...downloadRow(input)];
    return joinGroups(head, reads, tail, [archiveNote()]);
};

// The rows that can only ever name one entry, which is why a bulk selection has none of them.
const soleVerbs = (target: WorkspaceTreeEntry, input: EntryMenuInput): MenuItem[] => {
    const { barren, verbs } = input;
    const items: MenuItem[] = [];
    // Offered by the same rule the daemon unpacks by, so the row can't promise what it would then refuse.
    if (target.type === `file` && archiveFormat(target.name) !== undefined && verbs.extract !== undefined && offers(input, VERB_ROUTES.extract)) {
        items.push({ label: t(`workspace.entryMenu.extract`), icon: `box`, command: verbs.extract });
    }
    if (offers(input, VERB_ROUTES.rename) && !input.kept) {
        items.push(keyed({ label: t(`ui.action.rename`), icon: `pencil`, command: verbs.rename }, input.keys?.rename));
    }
    // Marks a barren folder intentional via a placeholder: durable, visible to git, not a private exclusion flag.
    if (target.type === `dir` && barren) {
        items.push({ label: t(`workspace.entryMenu.keepFolder`), icon: `check-circle`, command: verbs.keepFolder });
    }
    return items;
};

// Two groups, each after a rule: what changes the entry itself, then what carries it elsewhere.
const entryVerbs = (input: EntryMenuInput): MenuItem[] => {
    const { target, multi, count, verbs, keys, kept } = input;
    if (target === undefined) {
        return [];
    }
    const changes: MenuItem[] = [
        ...(multi ? [] : soleVerbs(target, input)),
        ...(offers(input, VERB_ROUTES.remove) && !kept
            ? [
                  keyed(
                      {
                          label: multi ? t(`workspace.entryMenu.deleteItems`, { count }, count) : t(`ui.action.delete`),
                          icon: `trash`,
                          command: verbs.remove,
                      },
                      keys?.remove,
                  ),
              ]
            : []),
    ];
    const carries: MenuItem[] = [
        ...(offers(input, VERB_ROUTES.cut) && !kept
            ? [
                  keyed(
                      {
                          label: multi ? t(`workspace.entryMenu.cutItems`, { count }, count) : t(`workspace.entryMenu.cut`),
                          icon: `arrows-h`,
                          command: verbs.cut,
                      },
                      keys?.cut,
                  ),
              ]
            : []),
        ...(offers(input, VERB_ROUTES.copy)
            ? [
                  keyed(
                      { label: multi ? t(`workspace.entryMenu.copyItems`, { count }, count) : t(`ui.action.copy`), icon: `copy`, command: verbs.copy },
                      keys?.copy,
                  ),
              ]
            : []),
        ...(verbs.duplicate !== undefined && offers(input, VERB_ROUTES.copy)
            ? [
                  keyed(
                      {
                          label: multi ? t(`workspace.entryMenu.duplicateItems`, { count }, count) : t(`workspace.entryMenu.duplicate`),
                          icon: `clone`,
                          command: verbs.duplicate,
                      },
                      keys?.duplicate,
                  ),
              ]
            : []),
        ...copyPathRow(input),
        ...downloadRow(input),
    ];
    return [...withSeparator(changes), ...withSeparator(carries)];
};

// What the clipboard holds, put here: Paste, and on a Mac with a copy held, Move Here.
const pasteRows = (input: EntryMenuInput): MenuItem[] => {
    const { clipboardFull, verbs, keys } = input;
    if (!clipboardFull) {
        return [];
    }
    const paste = keyed({ label: t(`ui.action.paste`), icon: `clone`, command: verbs.paste }, keys?.paste);
    const moves = input.clipboardCopied === true && verbs.moveHere !== undefined && offers(input, VERB_ROUTES.cut);
    return moves ? [paste, keyed({ label: t(`workspace.entryMenu.moveHere`), icon: `arrows-h`, command: verbs.moveHere }, keys?.moveHere)] : [paste];
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
    const { head = [], lead = [], tail = [], verbs } = input;
    const opening = [...head, ...askRow(input)];
    // A terminal is a maintainer's (components/heldPlace.ts): below one, no row opening a socket that would be refused.
    const terminal = input.target?.type === `dir` && !input.multi && verbs.openTerminal !== undefined && !belowMaintainer();
    return [
        ...opening,
        ...(opening.length > 0 ? [{ separator: true }] : []),
        { label: t(`workspace.entryMenu.newFile`), icon: `file`, command: verbs.newFile },
        ...(offers(input, VERB_ROUTES.newFolder) ? [{ label: t(`workspace.entryMenu.newFolder`), icon: `folder`, command: verbs.newFolder }] : []),
        ...lead,
        ...(terminal && offers(input, VERB_ROUTES.openTerminal)
            ? [{ label: t(`workspace.entryMenu.openTerminal`), icon: `terminal`, command: verbs.openTerminal }]
            : []),
        ...entryVerbs(input),
        ...pasteRows(input),
        ...withSeparator(tail),
        ...withSeparator(input.kept ? [keptNote()] : []),
    ];
};
