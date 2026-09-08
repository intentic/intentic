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

// Whether to descend into a directory, not whether the directory itself travels: a skipped directory can still own a
// carried child, so this asks whether it or anything beneath it travels.
const mayContainCarried = (relPath: string, secrets: boolean, own: Portability, files: readonly StateFile[]): boolean =>
    carries(own, secrets) || files.some((file) => file.path.startsWith(`${relPath}/`) && carries(file.portability, secrets));

export const workspaceMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, workspacePortability(relPath), WORKSPACE_STATE_FILES);

export const historyMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, historyPortability(relPath), HISTORY_STATE_FILES);
