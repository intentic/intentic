import { basename, parentDir } from "@intentic/ui/path";
// Pure paste planning for the file explorer — no Vue, so it's unit-checkable (explorerPaste.test.ts).
// `taken` is the set of names ALREADY in the target directory; the caller reads it off the loaded tree.

const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);

// Split a name at its extension the way VSCode does — at the LAST dot, and never at a leading one, so
// "a.test.ts" → "a.test" + ".ts" and a dotfile like ".gitignore" keeps its whole name as the stem.
const splitExtension = (name: string): readonly [string, string] => {
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ``];
};

/* The name a paste lands under: the original when the target dir has nothing by that name, else VSCode's
 * "<stem> copy<ext>", then "<stem> copy 2<ext>", "<stem> copy 3<ext>"… until one is free. Pasting is never
 * allowed to overwrite — the daemon's `cp` would silently replace the file, and the old explorer only
 * de-collided when the source happened to sit in the target dir itself. */
export const freeName = (name: string, taken: ReadonlySet<string>): string => {
    if (!taken.has(name)) {
        return name;
    }
    const [stem, extension] = splitExtension(name);
    for (let copy = 1; ; copy++) {
        const candidate = `${stem} copy${copy === 1 ? `` : ` ${copy}`}${extension}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
};

/* The from→to pairs a copy-paste of `paths` into `dir` should run. Each landed name joins `taken`, so pasting a
 * multi-selection of same-named files from different folders lands them side by side instead of onto each other.
 * A directory can't be pasted into itself or into its own subtree (`cp -r` would recurse forever), so those
 * sources are dropped — the rest of the selection still lands. */
export const pastePairs = (paths: readonly string[], dir: string, taken: ReadonlySet<string>): readonly { from: string; to: string }[] => {
    const claimed = new Set(taken);
    const pairs: { from: string; to: string }[] = [];
    for (const from of paths) {
        if (dir === from || dir.startsWith(`${from}/`)) {
            continue;
        }
        const name = freeName(basename(from), claimed);
        claimed.add(name);
        pairs.push({ from, to: joinPath(dir, name) });
    }
    return pairs;
};

/* The sources a cut-paste into `dir` should actually move: everything that isn't already there and isn't a
 * folder being moved into itself or its own subtree. Mirrors useWorkspaceTree's `canMoveInto` — the daemon's
 * move would either no-op or corrupt the tree for the rest. */
export const movableInto = (paths: readonly string[], dir: string): readonly string[] =>
    paths.filter((from) => !(dir === parentDir(from) || dir === from || dir.startsWith(`${from}/`)));
