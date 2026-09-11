import { HISTORY_STATE_FILES, type Portability, type StateFile, stateFileFor, WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";

// Single source of truth for what happens to one path in a bundle; both the exporter and the restorer ask it, since a
// bundle is hand-editable and the restorer must re-enforce, not just trust, what was packed.
// - /work defaults to carry: mostly user content, and the coverage test guarantees every `.intentic` path the daemon
//   builds is claimed
// - /history defaults to skip: daemon machinery only, and an undeclared file there is either stale or unnamed state
// Neither default is an oversight; they're opposite because the two volumes are opposite kinds of content.

// Workspace-root-relative, forward-slash. Longest match over the table, then the default; a needed exception belongs in
// the table, not a branch here.
export const workspacePortability = (relPath: string): Portability => stateFileFor(relPath, WORKSPACE_STATE_FILES)?.portability ?? "carry";

// historyRoot-relative, forward-slash. Unclaimed defaults to `derived`, per the asymmetry above.
export const historyPortability = (relPath: string): Portability => stateFileFor(relPath, HISTORY_STATE_FILES)?.portability ?? "derived";

// Whether a path travels, given the secrets choice; the one rule both sides apply everywhere.
export const carries = (portability: Portability, secrets: boolean): boolean => portability === "carry" || (portability === "secret" && secrets);

// WHAT THE IGNORE SCOPE PRUNES, SAID OUT LOUD.
//
// The two tables above are not the only thing that decides a bundle's contents: the walk also runs the workspace's
// IgnoreScope, and that prunes whole subtrees the tables never mention. The manifest's `excluded` list is built from
// the tables alone, so those subtrees were left out SILENTLY — and the manifest's own contract is the opposite
// ("every path class left out … a silent skip becomes an actionable list", BundleManifestSchema).
//
// The reference shelf is the one that costs a person something: 49 repos and 15G of it on the sandbox this list was
// written for, absent from both the tar and the report, discovered only by diffing the two sandboxes afterwards.
// These cannot become WORKSPACE_STATE_FILES entries — that table is pinned by test to `.intentic/` paths — so they
// are declared here, beside the classification they belong to, and appended to the manifest by excludedEntries.
export const IGNORE_SCOPE_EXCLUSIONS: readonly { readonly path: string; readonly portability: string; readonly note: string }[] = [
    {
        path: "refs/",
        portability: "shelf",
        note: "The reference shelf does not travel: each entry is a clone with its own remote, and carrying them would dwarf the bundle. Re-clone them in the target, or copy the directory across by hand — uncommitted work in a shelf repo is only there.",
    },
    {
        path: "<ignored dirs>",
        portability: "derived",
        note: "Build and dependency output is skipped wherever it appears (node_modules, dist, .turbo, .cache, .next, .pnpm-store, .venv, __pycache__, …). A restored workspace needs its own install and build before it runs.",
    },
    {
        path: "<.gitignore>",
        portability: "derived",
        note: "Anything a .gitignore in the workspace excludes is skipped too, which includes real configuration a repo keeps untracked — a repo's own .env does not travel.",
    },
];

// Whether to descend into a directory, not whether the directory itself travels: a skipped directory can still own a
// carried child, so this asks whether it or anything beneath it travels.
const mayContainCarried = (relPath: string, secrets: boolean, own: Portability, files: readonly StateFile[]): boolean =>
    carries(own, secrets) || files.some((file) => file.path.startsWith(`${relPath}/`) && carries(file.portability, secrets));

export const workspaceMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, workspacePortability(relPath), WORKSPACE_STATE_FILES);

export const historyMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, historyPortability(relPath), HISTORY_STATE_FILES);
