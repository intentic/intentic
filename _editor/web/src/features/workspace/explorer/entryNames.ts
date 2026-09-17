import { basename } from "@intentic/ui/path";

// Wording and checks every file surface (the tree, the desk) shares for naming, creating and deleting entries, so a
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

// The confirm's header: names the one thing, or counts several.
export const deleteHeader = (paths: readonly string[], typeOf: (path: string) => "file" | "dir" | undefined): string => {
    const only = paths.length === 1 ? paths[0] : undefined;
    if (only === undefined) {
        return `Delete ${paths.length} items?`;
    }
    return typeOf(only) === `dir` ? `Delete folder?` : `Delete file?`;
};

// The receipt once a delete lands; said after, never before, since a failed delete must not report what can't be undone.
export const deletedReceipt = (paths: readonly string[]): string => {
    const only = paths.length === 1 ? paths[0] : undefined;
    return only === undefined ? `${paths.length} items deleted` : `${basename(only)} deleted`;
};
