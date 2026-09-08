import type { WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic/api-contract";
import { rankRefCandidates, referenceTails } from "@intentic/sandbox-contract";
import { queryClient } from "../../../lib/queryPersistence";
import { workspaceAgent } from "../health/workspaceScope";

// A file reference is a suffix of the real path, matched against the fetched tree via tail + ranking rules shared with
// the daemon (@intentic/sandbox-contract). Shared grammar across terminal, markdown and tool-card links; free of the
// router and tab singleton, so markdown rendering stays decoupled.

// Needs a dir segment plus extension (bare words never match), optional line[:col] tail; avoids mid-URL match.
export const FILE_REF = /(?<![\w./:@-])(?:[~.]{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?|\(\d+,\d+\))?/;

// Workspace tree already fetched by the explorer, read by containerRoot and resolveInTree; undefined until the first
// fetch lands. Filters by scope, since more than one tree can be cached at once (workspaceScope).
const cachedTree = (): WorkspaceTreeResponse | undefined => {
    const prefix = [`workspace`, `tree`, workspaceAgent.value ?? `shared`];
    for (const [, data] of queryClient.getQueriesData<WorkspaceTreeResponse>({ queryKey: prefix })) {
        if (data?.root !== undefined && data.root !== ``) {
            return data;
        }
    }
    return undefined;
};

// Container workspace root (e.g. /work); empty until the tree fetches once, so absolute references don't open yet
// (relative ones still do).
const containerRoot = (): string => cachedTree()?.root ?? ``;

// Path set + basename→paths map resolveInTree matches against; memoized on the tree object, rebuilt only on refetch.
// Files only, but ignored dirs (node_modules) are indexed too: a dependency's stack frame is worth following.
interface FileIndex {
    readonly paths: ReadonlySet<string>;
    readonly byName: ReadonlyMap<string, string[]>;
}
let indexedFrom: WorkspaceTreeResponse | undefined;
let index: FileIndex | undefined;

const buildIndex = (tree: WorkspaceTreeResponse): FileIndex => {
    const paths = new Set<string>();
    const byName = new Map<string, string[]>();
    const walk = (entries: readonly WorkspaceTreeEntry[]): void => {
        for (const entry of entries) {
            if (entry.type === `dir`) {
                walk(entry.children ?? []);
                continue;
            }
            paths.add(entry.path);
            const same = byName.get(entry.name);
            if (same === undefined) {
                byName.set(entry.name, [entry.path]);
                continue;
            }
            same.push(entry.path);
        }
    };
    walk(tree.tree);
    return { paths, byName };
};

const fileIndex = (tree: WorkspaceTreeResponse): FileIndex => {
    if (indexedFrom !== tree || index === undefined) {
        indexedFrom = tree;
        index = buildIndex(tree);
    }
    return index;
};

// Matches a reference against the already-held tree, no round trip. undefined means "not answered here" (the walk is
// capped; misses fall to the daemon's /workspace/resolve), not "no such file".
export const resolveInTree = (path: string): string | undefined => {
    const tree = cachedTree();
    if (tree === undefined) {
        return undefined;
    }
    const { paths, byName } = fileIndex(tree);
    if (paths.has(path)) {
        return path;
    }
    const candidates = byName.get(path.slice(path.lastIndexOf(`/`) + 1)) ?? [];
    if (candidates.length === 0) {
        return undefined;
    }
    for (const tail of referenceTails(path, tree.root)) {
        const [best] = rankRefCandidates(tail, candidates);
        if (best !== undefined) {
            return best;
        }
    }
    return undefined;
};

// Git diff side prefixes: a/b default, i/w/c/o mnemonicPrefix, 1/2 --no-index; real paths never start this way.
const DIFF_PREFIX = /^[abiwco12]\//;

// Splits a reference into path and 1-based line: `:12:3` (tsc/eslint/traces), `(12,3)` (MSBuild-style), or
// `#L12`/`#L12-L20` (GitHub anchor). Unparsed, the anchor form takes the fragment into the path and opens nothing.
export const parseRef = (ref: string): { readonly path: string; readonly line?: number } => {
    const anchor = /^(.*?)#L(\d+)(?:-L?\d+)?$/.exec(ref);
    if (anchor?.[1] !== undefined) {
        return { path: anchor[1], line: Number(anchor[2]) };
    }
    const colon = /^(.*?):(\d+)(?::\d+)?$/.exec(ref);
    if (colon?.[1] !== undefined) {
        return { path: colon[1], line: Number(colon[2]) };
    }
    const paren = /^(.*?)\((\d+),\d+\)$/.exec(ref);
    if (paren?.[1] !== undefined) {
        return { path: paren[1], line: Number(paren[2]) };
    }
    return { path: ref };
};

// Maps a matched path to the root-relative path the editor opens; undefined if it's outside the workspace (a system
// path, or an unmappable root).
export const toWorkspacePath = (rawPath: string): string | undefined => {
    if (!rawPath.startsWith(`/`)) {
        // Explicit `./` is tool-relative, not a diff side: strip only the `./`; anything else may carry a diff prefix.
        return rawPath.startsWith(`./`) ? rawPath.slice(2) : rawPath.replace(DIFF_PREFIX, ``);
    }
    const root = containerRoot();
    if (root !== `` && rawPath.startsWith(`${root}/`)) {
        return rawPath.slice(root.length + 1);
    }
    // Absolute path under another root (a worktree, a log): maps only if the workspace holds a matching file.
    return resolveInTree(rawPath);
};
