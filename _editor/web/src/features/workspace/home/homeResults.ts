import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { basename, parentDir } from "@intentic/ui/path";

// What the home shows for a query: matches under the open folder, flat, each knowing the folder it sits in. The tree
// answers the same query over the whole workspace; the home answers it where the reader is. Pure, no framework code.

// Enough to read, few enough to lay out at once; a query this wide wants a narrower one, not a longer page.
export const RESULTS_CAP = 400;

export interface HomeResult {
    readonly entry: WorkspaceTreeEntry;
    // The folder the entry sits in, relative to the open one; "" for the open folder itself.
    readonly where: string;
}

const relativeTo = (path: string, dir: string): string => (dir === `` ? path : path.slice(dir.length + 1));

export const whereOf = (path: string, dir: string): string => parentDir(relativeTo(path, dir));

const under = (path: string, dir: string): boolean => dir === `` || path === dir || path.startsWith(`${dir}/`);

// Name matches under the open folder, walking the listed children and whatever lazy listings the reader has opened;
// `shows` is the explorer's own filter, and a folder it hides is not walked. Stops at the cap.
export const nameMatches = (
    needle: string,
    dir: string,
    roots: readonly WorkspaceTreeEntry[],
    childrenOf: (folder: WorkspaceTreeEntry) => readonly WorkspaceTreeEntry[] | undefined,
    shows: (entry: WorkspaceTreeEntry) => boolean,
): readonly HomeResult[] => {
    const query = needle.trim().toLowerCase();
    if (query === ``) {
        return [];
    }
    const out: HomeResult[] = [];
    const walk = (entries: readonly WorkspaceTreeEntry[]): void => {
        for (const entry of entries) {
            if (out.length >= RESULTS_CAP) {
                return;
            }
            if (!shows(entry)) {
                continue;
            }
            if (entry.name.toLowerCase().includes(query)) {
                out.push({ entry, where: whereOf(entry.path, dir) });
            }
            const inside = entry.type === `dir` ? childrenOf(entry) : undefined;
            if (inside !== undefined) {
                walk(inside);
            }
        }
    };
    walk(roots);
    return out;
};

// The files a content search matched, kept to those under the open folder; a file the tree has not listed is drawn
// from its path alone, since the daemon searched the whole workspace, listed or not.
export const contentMatches = (
    paths: readonly string[],
    dir: string,
    entryAt: (path: string) => WorkspaceTreeEntry | undefined,
): readonly HomeResult[] =>
    paths
        .filter((path) => under(path, dir))
        .slice(0, RESULTS_CAP)
        .map((path) => ({ entry: entryAt(path) ?? { name: basename(path), path, type: `file` }, where: whereOf(path, dir) }));
