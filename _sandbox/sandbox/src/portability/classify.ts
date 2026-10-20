import { AUTH_ROOT_IN_WORKSPACE, AUTH_STATE_FILES } from "@intentic/sandbox-contract/state/auth-state";
import type { BundleManifest } from "@intentic/sandbox-contract/state/definition";
import { HISTORY_STATE_FILES } from "@intentic/sandbox-contract/state/history-state";
import { type Portability, type StateFile, stateFileFor } from "@intentic/sandbox-contract/state/state-portability";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract/state/workspace-state";
import { SANDBOX_VOLUMES } from "@intentic/sandbox-run";

// Single source of truth for what happens to one path in a bundle; both the exporter and the restorer ask it, since a
// bundle is hand-editable and the restorer must re-enforce, not just trust, what was packed.
// - /work defaults to carry: mostly user content, and the coverage test guarantees every `.intentic` path the daemon
//   builds is claimed
// - /history defaults to skip: daemon machinery only, and an undeclared file there is either stale or unnamed state
// Neither default is an oversight; they're opposite because the two volumes are opposite kinds of content.

// The workspace table with the auth root's own table nested under the place the auth root sits in the workspace. The
// workspace table claims that directory whole as `secret`, so an auth path no entry names keeps that class (a provider's
// home is a login), while a named one (a keyring key, a credential gate) says for itself whether it travels.
export const WORKSPACE_STATE_WITH_AUTH: readonly StateFile[] = [
    ...WORKSPACE_STATE_FILES,
    ...AUTH_STATE_FILES.map((file) => ({ ...file, path: `${AUTH_ROOT_IN_WORKSPACE}${file.path}` })),
];

// Workspace-root-relative, forward-slash. Longest match over the table, then the default; a needed exception belongs in
// the table, not a branch here.
export const workspacePortability = (relPath: string): Portability => stateFileFor(relPath, WORKSPACE_STATE_WITH_AUTH)?.portability ?? "carry";

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

// WHAT LIES OUTSIDE THE TWO WALKED VOLUMES, SAID OUT LOUD.
//
// A bundle walks /work and /history. A volume the run contract mounts beside them (the sandbox's own Docker engine) is
// never walked, and neither is an auth root AGENT_AUTH_DIR moved off the workspace: before these entries both were left
// out silently, the second taking the owner's credential gates and guards with it even on an export with secrets.
// Each volume says why in the run contract (SANDBOX_VOLUMES' `unbundled`), so a volume added there is reported here.
export const storageExclusions = (authRootOutsideWorkspace: string | undefined): BundleManifest["excluded"] => [
    ...SANDBOX_VOLUMES.flatMap(({ destination, unbundled }) =>
        unbundled === undefined ? [] : [{ path: `${destination}/`, portability: "volume", note: unbundled }],
    ),
    ...(authRootOutsideWorkspace === undefined
        ? []
        : [
              {
                  path: `${authRootOutsideWorkspace.replace(/\/$/, "")}/`,
                  portability: "auth-root",
                  note: "This sandbox keeps its AI-provider logins, secret vaults and credential gates and guards outside the workspace (AGENT_AUTH_DIR), so none of them travel, even with secrets included. Sign in, store the secrets and set the gates and guards again on the target.",
              },
          ]),
];

// Whether to descend into a directory, not whether the directory itself travels: a skipped directory can still own a
// carried child, so this asks whether it or anything beneath it travels.
const mayContainCarried = (relPath: string, secrets: boolean, own: Portability, files: readonly StateFile[]): boolean =>
    carries(own, secrets) || files.some((file) => file.path.startsWith(`${relPath}/`) && carries(file.portability, secrets));

export const workspaceMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, workspacePortability(relPath), WORKSPACE_STATE_WITH_AUTH);

export const historyMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, historyPortability(relPath), HISTORY_STATE_FILES);
