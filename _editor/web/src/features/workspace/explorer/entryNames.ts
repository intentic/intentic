import { basename } from "@intentic/ui/path";
import { t } from "@intentic/ui/i18n";

// Wording and checks every file surface (the tree, the home) shares for naming, creating and deleting entries, so a
// name refused in one place is refused in the other with the same words (workspace.fileVerbs in the catalog).

export const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);

// Live validation for a name being typed; empty stays error-free, since an empty commit is a silent cancel.
export const newNameError = (draft: string, dir: string, exists: (path: string) => boolean): string | undefined => {
    const name = draft.trim();
    if (name === ``) {
        return undefined;
    }
    if (name === `.` || name === `..` || /[/\\]/.test(name)) {
        return t(`workspace.fileVerbs.invalidName`);
    }
    if (exists(joinPath(dir, name))) {
        return t(`workspace.fileVerbs.alreadyExists`, { name });
    }
    return undefined;
};

// The receipt once a delete lands; said after, never before, since a failed delete must not report what can't be undone.
export const deletedReceipt = (paths: readonly string[]): string => {
    const only = paths.length === 1 ? paths[0] : undefined;
    return only === undefined ? t(`workspace.fileVerbs.deletedMany`, { count: paths.length }) : t(`workspace.fileVerbs.deleted`, { name: basename(only) });
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
    const said =
        landed.length > 1
            ? t(`workspace.fileVerbs.restoredMany`, { count: landed.length })
            : moved
              ? t(`workspace.fileVerbs.restoredAs`, { name: basename(only) })
              : t(`workspace.fileVerbs.restored`, { name: basename(only) });
    return gone === 0 ? said : t(`workspace.fileVerbs.someGone`, { said, count: gone });
};
