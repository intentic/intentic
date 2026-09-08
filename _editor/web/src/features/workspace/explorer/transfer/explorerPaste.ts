import { basename, parentDir } from "@intentic/ui/path";
// Pure paste planning for the file explorer, no Vue. `taken` is the set of names already in the target directory, read
// off the loaded tree by the caller.

const joinPath = (dir: string, name: string): string => (dir === `` ? name : `${dir}/${name}`);

// Splits at the last dot, never a leading one, matching VSCode: `.gitignore` keeps its whole name as the stem.
const splitExtension = (name: string): readonly [string, string] => {
    const dot = name.lastIndexOf(`.`);
    return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ``];
};

// Name a paste lands under: original if free, else VSCode's "<stem> copy<ext>", "<stem> copy 2<ext>"... Never
// overwrites; the daemon's cp would silently replace a same-named file.
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

// from→to pairs for a copy-paste into `dir`. Each landed name joins `taken`, so same-named files from different folders
// land side by side. A directory pasted into itself or its own subtree is dropped; the rest still lands.
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

// Sources a cut-paste into `dir` should move: excludes anything already there or a folder moving into itself or its own
// subtree. Mirrors useWorkspaceTree's canMoveInto.
export const movableInto = (paths: readonly string[], dir: string): readonly string[] =>
    paths.filter((from) => !(dir === parentDir(from) || dir === from || dir.startsWith(`${from}/`)));
