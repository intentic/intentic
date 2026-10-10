import { defaultGit, type GitRunner } from "@intentic/base/git";
import { chunkPaths } from "./changes-index.js";

// The Changes panel's origin chips stage one origin's work when lit and take it back when cleared. Taking it back by
// scope ("unstage everything of that origin") also took whatever the owner had staged by hand: a file staged before the
// chip, a partial `git add -p`, a merge's clean result that git staged itself. So a chip remembers, per path, the index
// entry it found and the one it left, and clearing writes back only what it changed and nothing has changed since.
//
// The memory lives in the daemon, beside the index it describes: a reload or a second tab clears what the first one
// lit, and the commit a chip leads to is the daemon's to see. Empty again on restart, when clearing changes nothing.

// One index entry as `ls-files -s` names it ("mode sha"); a path the index does not hold has none.
export type IndexEntries = ReadonlyMap<string, string>;

// The stage-0 entries the index holds for `paths`. Unmerged entries (stages 1-3) are a conflict's, which no chip
// stages, so a path holding only those reads as absent.
export const indexEntries = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<IndexEntries> => {
    const wanted = new Set(paths);
    const entries = new Map<string, string>();
    for (const chunk of chunkPaths(paths)) {
        const { stdout } = await git(dir, ["ls-files", "-s", "-z", "--", ...chunk]);
        for (const record of stdout.split("\0")) {
            const tab = record.indexOf("\t");
            if (tab === -1) {
                continue;
            }
            const [mode, sha, stage] = record.slice(0, tab).split(" ");
            const path = record.slice(tab + 1);
            if (stage === "0" && mode !== undefined && sha !== undefined && wanted.has(path)) {
                entries.set(path, `${mode} ${sha}`);
            }
        }
    }
    return entries;
};

// Sets each path's index entry exactly: an entry is written as it was read, undefined drops the path from the index.
// Plumbing, so a mid-merge index keeps its MERGE_HEAD and every entry not named here.
export const writeIndexEntries = async (
    dir: string,
    entries: ReadonlyMap<string, string | undefined>,
    git: GitRunner = defaultGit,
): Promise<void> => {
    const dropped = [...entries].flatMap(([path, entry]) => (entry === undefined ? [path] : []));
    // `mode,sha,path` is one argument: git splits the first two commas and takes the rest whole, commas included.
    const written = [...entries].flatMap(([path, entry]) => (entry === undefined ? [] : [`${entry.replace(" ", ",")},${path}`]));
    for (const chunk of chunkPaths(dropped)) {
        await git(dir, ["update-index", "--force-remove", "--", ...chunk]);
    }
    for (const chunk of chunkPaths(written)) {
        await git(dir, ["update-index", "--add", ...chunk.flatMap((info) => ["--cacheinfo", info])]);
    }
};

// The index moves a chip needs, injectable so the memory is testable without a repository.
export interface ChipIndex {
    readonly indexEntries: (dir: string, paths: readonly string[]) => Promise<IndexEntries>;
    readonly writeIndexEntries: (dir: string, entries: ReadonlyMap<string, string | undefined>) => Promise<void>;
    readonly stagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
}

// What one lit chip changed in one repository: the commit it was lit on, and per path the entry before and after.
interface LitChip {
    readonly head: string | undefined;
    readonly paths: ReadonlyMap<string, { readonly before: string | undefined; readonly after: string | undefined }>;
}

export interface ChipStaging {
    // Stages `paths` for `origin`, remembering what the index held at each. Lit twice on one commit (a second tab),
    // the first `before` is kept, so clearing still goes back to the index as it was before either.
    readonly light: (repo: string, dir: string, origin: string, head: string | undefined, paths: readonly string[]) => Promise<void>;
    // Writes back what that chip changed, where the index still holds what the chip left. A path staged differently
    // since is the owner's newer decision, and a moved HEAD means a commit took the chip's staging, so both stay.
    readonly clear: (repo: string, dir: string, origin: string, head: () => Promise<string | undefined>) => Promise<void>;
}

export const createChipStaging = (index: ChipIndex): ChipStaging => {
    const lit = new Map<string, LitChip>();
    const keyOf = (repo: string, origin: string): string => JSON.stringify([repo, origin]);
    return {
        light: async (repo, dir, origin, head, paths) => {
            if (paths.length === 0) {
                return;
            }
            const before = await index.indexEntries(dir, paths);
            await index.stagePaths(dir, paths);
            const after = await index.indexEntries(dir, paths);
            const key = keyOf(repo, origin);
            const held = lit.get(key);
            const merged = new Map(held !== undefined && held.head === head ? held.paths : []);
            for (const path of paths) {
                const earlier = merged.get(path);
                const was = earlier === undefined ? before.get(path) : earlier.before;
                const now = after.get(path);
                if (earlier !== undefined || was !== now) {
                    merged.set(path, { before: was, after: now });
                }
            }
            lit.set(key, { head, paths: merged });
        },
        clear: async (repo, dir, origin, head) => {
            const key = keyOf(repo, origin);
            const held = lit.get(key);
            lit.delete(key);
            if (held === undefined || held.paths.size === 0 || (await head()) !== held.head) {
                return;
            }
            const current = await index.indexEntries(dir, [...held.paths.keys()]);
            const restore = new Map<string, string | undefined>();
            for (const [path, { before, after }] of held.paths) {
                if (current.get(path) === after && before !== after) {
                    restore.set(path, before);
                }
            }
            if (restore.size > 0) {
                await index.writeIndexEntries(dir, restore);
            }
        },
    };
};
