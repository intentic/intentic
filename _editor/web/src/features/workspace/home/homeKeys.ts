import { letterOfCode, primaryHeld } from "@intentic/ui/keys";

// Which verb a key asks of the home's tiles, decided rather than done (treeKeys.ts is the tree's twin). Everywhere:
// Delete deletes, F2 renames, the primary modifier with A selects all. On a Mac, as in Finder: Return renames, ⌘⌫
// deletes, ⌘D duplicates, ⌥⌘V moves what was copied into this folder, ⌘↓ opens and ⌘↑ goes up a folder.

export interface HomeKeyVerbs {
    readonly remove: () => void;
    readonly rename: () => void;
    readonly selectAll: () => void;
    readonly duplicate: () => void;
    readonly moveHere: () => void;
    readonly open: () => void;
    readonly up: () => void;
}

type Press = Pick<KeyboardEvent, `key` | `code` | `ctrlKey` | `metaKey` | `altKey` | `shiftKey`>;

const plain = (press: Press): boolean => !press.metaKey && !press.ctrlKey && !press.altKey && !press.shiftKey;
// ⌘ alone, or with ⌥ where `alt` says so.
const command = (press: Press, alt: boolean): boolean => press.metaKey && !press.ctrlKey && !press.shiftKey && press.altKey === alt;

const macVerb = (press: Press, letter: string, verbs: HomeKeyVerbs): (() => void) | undefined => {
    if (press.key === `Enter` && plain(press)) {
        return verbs.rename;
    }
    if (command(press, true)) {
        return letter === `v` ? verbs.moveHere : undefined;
    }
    if (!command(press, false)) {
        return undefined;
    }
    const byKey = new Map([
        [`Backspace`, verbs.remove],
        [`ArrowDown`, verbs.open],
        [`ArrowUp`, verbs.up],
    ]);
    return byKey.get(press.key) ?? (letter === `d` ? verbs.duplicate : undefined);
};

/** The verb this key runs on the tiles, or undefined for a key the home's other handlers own. */
export const homeKeyVerb = (press: Press, isMac: boolean, verbs: HomeKeyVerbs): (() => void) | undefined => {
    const letter = letterOfCode(press.code) ?? press.key.toLowerCase();
    const mac = isMac ? macVerb(press, letter, verbs) : undefined;
    if (mac !== undefined) {
        return mac;
    }
    if (primaryHeld(press, isMac) && !press.altKey && !press.shiftKey && letter === `a`) {
        return verbs.selectAll;
    }
    return press.key === `Delete` ? verbs.remove : press.key === `F2` ? verbs.rename : undefined;
};
