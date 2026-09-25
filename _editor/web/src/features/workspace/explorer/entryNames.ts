import { basename } from "@intentic/ui/path";

// Wording and checks every file surface (the tree, the home) shares for naming, creating and deleting entries, so a
// name refused in one place is refused in the other with the same words. Pure, no framework code.

export const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);

// Live validation for a name being typed; empty stays error-free, since an empty commit is a silent cancel.
export const newNameError = (draft: string, dir: string, exists: (path: string) => boolean): string | undefined => {
    const name = draft.trim();
    if (name === ``) {
        return undefined;
    }
    if (name === `.` || name === `..` || /[/\\]/.test(name)) {
        return `Invalid name.`;
    }
    if (exists(joinPath(dir, name))) {
        return `"${name}" already exists.`;
    }
    return undefined;
};

// The receipt once a delete lands; said after, never before, since a failed delete must not report what can't be undone.
export const deletedReceipt = (paths: readonly string[]): string => {
    const only = paths.length === 1 ? paths[0] : undefined;
    return only === undefined ? `${paths.length} items deleted` : `${basename(only)} deleted`;
};

// The receipt once an undo lands. `from` is where each came from; `landed` where each came back, which differs only
// when something new took the name meanwhile, and then the new name is the news. `gone` counts what had aged out of
// the trash. Undefined when nothing came back at all, which is a warning's to say.
export const restoredReceipt = (from: readonly string[], landed: readonly string[], gone: number): string | undefined => {
    const [only] = landed;
    if (only === undefined) {
        return undefined;
    }
    const moved = landed.length === 1 && !from.includes(only);
    const said = landed.length > 1 ? `${landed.length} items restored` : moved ? `Restored as ${basename(only)}` : `${basename(only)} restored`;
    return gone === 0 ? said : `${said}; ${gone} no longer in the trash`;
};
