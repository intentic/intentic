import type { WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic-app/api-contract";
import { rankRefCandidates, referenceTails } from "@intentic/sandbox-contract";
import { queryClient } from "../queryPersistence";
import { workspaceAgent } from "./workspaceScope";

/* What a file reference looks like in agent and tool output, `src/foo.ts`, `./src/foo.ts:12:3`,
 * `/work/src/foo.ts(12,4)`, and how one maps onto the workspace-relative path the editor opens.
 *
 * A reference is a SUFFIX of that path, not the path itself: an agent that has been working in `_editor/web/src`
 * writes `pages/workspace/Foo.vue`, and read literally that opens nothing. So `resolveInTree` matches it
 * against the tree the explorer already fetched (the daemon's /workspace/resolve covers what the capped tree
 * left out, see resolveFileRef), using the tail + ranking rules both sides share (@intentic/sandbox-contract).
 *
 * Three surfaces speak this language: terminal output (terminalFileLinks), the assistant's markdown prose
 * (markdownFileLinks), and a tool card's location chip. They share the grammar so the same path opens the same
 * file, at the same line, wherever the user clicks it.
 *
 * Deliberately free of the router and the tab singleton: markdown RENDERING pulls this in (see
 * markdownFileLinks), and that path must not drag the app graph, navigation lives one module over, in
 * openFileRef. */

// A file reference: an optional /, ./, ../ or ~/ lead, one or more directory segments (so a bare word is never a
// link, a reference needs a slash), a filename with an extension, and an optional line[:col] or (line,col) tail
// (the forms tsc / eslint / vitest / node stack traces emit). The leading boundary lookbehind keeps the match
// from starting mid-token, e.g. inside a URL's `example.com/foo.ts` tail, which the URL addon already owns.
export const FILE_REF = /(?<![\w./:@-])(?:[~.]{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?|\(\d+,\d+\))?/;

// The workspace tree the file explorer has already fetched, the client's own copy of what exists, and what
// both the container root and the reference matcher below read. Undefined until the first fetch lands.
// getQueriesData prefix-matches, so the sandbox-id suffix on the key doesn't matter, but the SCOPE does: with
// more than one tree cached (the shared one and a conversation's own, see workspaceScope), taking whichever
// came back first would match references against a workspace nobody is looking at.
const cachedTree = (): WorkspaceTreeResponse | undefined => {
    const prefix = [`workspace`, `tree`, workspaceAgent.value ?? `shared`];
    for (const [, data] of queryClient.getQueriesData<WorkspaceTreeResponse>({ queryKey: prefix })) {
        if (data?.root !== undefined && data.root !== ``) {
            return data;
        }
    }
    return undefined;
};

// The container workspace root (e.g. /work). Empty until the tree has been fetched once, until then an
// absolute reference simply isn't opened (relative ones still are).
const containerRoot = (): string => cachedTree()?.root ?? ``;

/* Every file in that tree, as a path set plus a basename → paths map, the index `resolveInTree` matches a
 * reference against. Memoized on the response OBJECT, so it is rebuilt exactly when the query refetches into a
 * new one and never on a click.
 *
 * Files only: a reference names a file, and the dirs are half the entries. Ignored entries (node_modules, …)
 * ARE indexed, the tree lists them, the editor opens them, and a stack frame through a dependency is a
 * reference worth following. */
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

/* The workspace file a reference names, matched against the tree the client already holds, no round trip.
 * Undefined means "not answered here", not "no such file": the tree walk is capped (5000 entries) and doesn't
 * descend ignored dirs, so a miss is handed to the daemon's /workspace/resolve (see resolveFileRef), which
 * matches the same way against the full sweep.
 *
 * All tails share the reference's filename, only leading segments are dropped, so the candidate pool is
 * whatever the basename map holds, never the whole index. */
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

// Git diff output prefixes each side of a file with a one-segment marker: `a/` `b/` by default, `i/` (index)
// `w/` (working tree) `c/` (commit) `o/` (object) under `diff.mnemonicPrefix`, and `1/` `2/` from
// `git diff --no-index`. A real workspace path effectively never starts with one of these bare single-char
// segments, so a copied `a/src/foo.ts` diff path should open the actual src/foo.ts (VS Code 1.130 parity, the
// prior code opened the literal a/… path and landed on the not-found state).
const DIFF_PREFIX = /^[abiwco12]\//;

/* Split a reference into its path and 1-based line. Every notation a line arrives in is accepted, because
 * which one shows up is not ours to decide: `foo.ts:12:3` (tsc, eslint, ripgrep, stack traces), `foo.ts(12,3)`
 * (MSBuild-style tsc output), and `foo.ts#L12` / `foo.ts#L12-L20`, the GitHub anchor, which is what a model
 * writes when it reaches for the markdown-link form IDE surfaces ask for. Left unparsed, that last one takes
 * the fragment into the path and opens nothing. */
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

// Map a matched path to the root-relative path the editor opens, or undefined if it points outside the workspace
// (a system path like /usr/lib/…, or an absolute path under some other root the client can't map).
export const toWorkspacePath = (rawPath: string): string | undefined => {
    if (!rawPath.startsWith(`/`)) {
        // An explicit `./` lead is a tool-emitted relative path, never a diff side, strip only the `./`.
        // Anything else may carry a git-diff prefix (a/ b/ i/ w/ …), which is stripped to the real path.
        return rawPath.startsWith(`./`) ? rawPath.slice(2) : rawPath.replace(DIFF_PREFIX, ``);
    }
    const root = containerRoot();
    if (root !== `` && rawPath.startsWith(`${root}/`)) {
        return rawPath.slice(root.length + 1);
    }
    // An absolute path under SOME OTHER root: an isolated turn's worktree (/history/worktrees/<id>/…, which
    // mirrors the workspace layout below its own lead) or a machine path from a pasted log. It maps only if the
    // workspace really holds a file that path ends in: /usr/lib/… never will, which is what keeps a system
    // path plain prose instead of a link to nothing.
    return resolveInTree(rawPath);
};
