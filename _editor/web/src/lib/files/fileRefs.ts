import { rankRefCandidates, referenceTails } from "@intentic/sandbox-contract/text/path-refs";
import type { WorkspaceTreeEntry, WorkspaceTree } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { type ViewScope, workspaceScope } from "../../app/workspaceScope";
import { cachedWorkspaceTree } from "./workspaceTreeCache";

// A file reference is a suffix of the real path, matched against the fetched tree via tail + ranking rules shared with
// the daemon (@intentic/sandbox-contract). Shared grammar across terminal, markdown and tool-card links; free of the
// router and tab singleton, so markdown rendering stays decoupled.

// Needs a dir segment plus extension (bare words never match), optional line[:col] tail; avoids mid-URL match.
// The extension must hold a letter: without that, `ratio 3/4.5` and `v1.2/3.4` are references, and prose carrying a
// fraction or a version range renders as a link that opens nothing. `.7z` still is one.
export const FILE_REF = /(?<![\w./:@-])(?:[~.]{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*(?::\d+(?::\d+)?|\(\d+,\d+\))?/;

// Workspace tree already fetched by the explorer for one scope, read by containerRoot and resolveInTree; undefined
// until that scope's first fetch lands. One scope's tree only: more than one can be cached at once (workspaceScope), and
// a reference in one conversation's words must never resolve against another copy's files.
const cachedTree = (scope: ViewScope = workspaceScope()): WorkspaceTree | undefined => {
    const data = cachedWorkspaceTree(scope.agent);
    return data?.root === undefined || data.root === `` ? undefined : data;
};

// The tree a reference in `scope` would resolve against right now, as an identity: rendered prose linked against one
// tree is only good while that same tree stands (useMarkdown's parse cache keys on it).
export const fileRefTree = (scope?: ViewScope): WorkspaceTree | undefined => cachedTree(scope);

// Container workspace root (e.g. /work); empty until a tree fetches once, so absolute references don't open yet
// (relative ones still do). Every copy in one sandbox shares it, so any held tree answers when the scope's own is not.
const containerRoot = (scope?: ViewScope): string => (cachedTree(scope) ?? cachedTree() ?? cachedTree({ agent: undefined }))?.root ?? ``;

// Path set + basename→paths map resolveInTree matches against; memoized on the tree object, rebuilt only on refetch.
// Files only, but ignored dirs (node_modules) are indexed too: a dependency's stack frame is worth following.
interface FileIndex {
    readonly paths: ReadonlySet<string>;
    readonly byName: ReadonlyMap<string, string[]>;
}
let indexedFrom: WorkspaceTree | undefined;
let index: FileIndex | undefined;

const buildIndex = (tree: WorkspaceTree): FileIndex => {
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

const fileIndex = (tree: WorkspaceTree): FileIndex => {
    if (indexedFrom !== tree || index === undefined) {
        indexedFrom = tree;
        index = buildIndex(tree);
    }
    return index;
};

// Every file in the already-held tree a reference could mean, most likely first, with no round trip: the path itself
// when it names a real file, else the matches of its longest tail that has any. undefined means "not answered here"
// (the walk is capped; misses fall to the daemon's /workspace/resolve), not "no such file". `scope` names whose tree,
// the Workspace's when absent.
export const matchesInTree = (path: string, scope?: ViewScope): readonly string[] | undefined => {
    const tree = cachedTree(scope);
    if (tree === undefined) {
        return undefined;
    }
    const { paths, byName } = fileIndex(tree);
    if (paths.has(path)) {
        return [path];
    }
    const candidates = byName.get(path.slice(path.lastIndexOf(`/`) + 1)) ?? [];
    if (candidates.length === 0) {
        return undefined;
    }
    for (const tail of referenceTails(path, tree.root)) {
        const ranked = rankRefCandidates(tail, candidates);
        if (ranked.length > 0) {
            return ranked;
        }
    }
    return undefined;
};

// The one file a reference most likely means in the held tree; undefined as matchesInTree.
export const resolveInTree = (path: string, scope?: ViewScope): string | undefined => matchesInTree(path, scope)?.[0];

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
// path, or an unmappable root). `scope` is whose copy the reference is about, the Workspace's when absent.
export const toWorkspacePath = (rawPath: string, scope?: ViewScope): string | undefined => {
    if (!rawPath.startsWith(`/`)) {
        // Explicit `./` is tool-relative, not a diff side: strip only the `./`; anything else may carry a diff prefix.
        return rawPath.startsWith(`./`) ? rawPath.slice(2) : rawPath.replace(DIFF_PREFIX, ``);
    }
    const root = containerRoot(scope);
    if (root !== `` && rawPath.startsWith(`${root}/`)) {
        return rawPath.slice(root.length + 1);
    }
    // Absolute path under another root (a worktree, a log): maps only if the workspace holds a matching file.
    return resolveInTree(rawPath, scope);
};
