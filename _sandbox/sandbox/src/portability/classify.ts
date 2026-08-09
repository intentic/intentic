import { STATE_DIR } from "@intentic/constants";
import {
    HISTORY_STATE_FILES,
    type Portability,
    RETIRED_WORKSPACE_STATE_DIRS,
    type StateFile,
    stateFileFor,
    WORKSPACE_STATE_FILES,
} from "@intentic/sandbox-contract";

/* WHAT HAPPENS TO ONE PATH IN A BUNDLE — the manifests turned into a decision, in the one place both sides read.
 *
 * The bundler asks this on the way out and the restorer asks it again on the way in. Asking twice is the point:
 * a bundle is a file the owner can hand around and hand-edit, so "this entry is an identity file" has to be
 * enforced where it is WRITTEN, not merely where it was packed. A tar carrying `history/session-secret` is
 * refused by the restorer even though no exporter this daemon runs would have produced one — the same reason
 * the generic upload route re-checks isControlPlanePath instead of trusting the browser that packed it.
 *
 * The two volumes default OPPOSITE ways, and that asymmetry is deliberate rather than an oversight:
 *
 *   /work defaults to CARRY. It is the user's content — repos, notes, whatever an agent wrote — and most of it
 *   is claimed by no manifest because most of it is not daemon state at all. An extension's own output under
 *   `.intentic/` (docs staging, acceptance reports, chore ledgers) lands here too, declared in that extension's
 *   manifest rather than the core table, and carrying it is right. What makes this default SAFE is the coverage
 *   test: every `.intentic` path the daemon itself builds is guaranteed to be claimed, so an unclaimed path is
 *   never a credential store somebody forgot to declare.
 *
 *   /history defaults to SKIP. It is daemon machinery, no part of it is user content, and an undeclared file
 *   there is either junk from a build that has moved on or state this daemon has no name for. Neither belongs
 *   in a bundle, and the manifest is small enough that declaring is cheap.
 */

// Connector gateways live in a separate package and are process-local discovery state, not a core store. They
// are the sole active generated-tree exception to the core table; extension-contributed paths otherwise all
// `carry`, which is the workspace default. Retired roots below are quarantine only: no producer reads them.
const EXTERNAL_DERIVED = [`${STATE_DIR}/runtime/`];
const retiredPrefixes = (dirs: readonly string[]): string[] => dirs.map((dir) => `.intentic/${dir}/`);
const RETIRED_SECRET = retiredPrefixes(RETIRED_WORKSPACE_STATE_DIRS.secret);
const DERIVED_PREFIXES = [...EXTERNAL_DERIVED, ...retiredPrefixes(RETIRED_WORKSPACE_STATE_DIRS.derived)];
const hasPrefix = (relPath: string, prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));

// Workspace-root-relative, forward-slash. Longest-match over the core table, then the default.
export const workspacePortability = (relPath: string): Portability => {
    if (hasPrefix(relPath, DERIVED_PREFIXES)) {
        return "derived";
    }
    if (hasPrefix(relPath, RETIRED_SECRET)) {
        return "secret";
    }
    return stateFileFor(relPath, WORKSPACE_STATE_FILES)?.portability ?? "carry";
};

// historyRoot-relative, forward-slash. Unclaimed is `derived` — see the asymmetry note above.
export const historyPortability = (relPath: string): Portability => stateFileFor(relPath, HISTORY_STATE_FILES)?.portability ?? "derived";

// Whether a path travels, given the owner's secrets choice. The single rule both sides apply, so "with secrets"
// can never mean two different sets of files.
export const carries = (portability: Portability, secrets: boolean): boolean => portability === "carry" || (portability === "secret" && secrets);

/* WHETHER TO ENTER A DIRECTORY, which is NOT the same question as whether the directory itself travels — and
 * conflating the two silently dropped the single most valuable thing in a bundle.
 *
 * Manifest entries may nest, and a directory that is itself skipped can still own a carried child. A walk that
 * asked only "does this directory carry?" would turn around before seeing such a child.
 *
 * So descent asks the broader question: does this directory, OR anything declared beneath it, travel? Files
 * still get the exact decision — this only governs whether the walk looks inside.
 */
const mayContainCarried = (relPath: string, secrets: boolean, own: Portability, files: readonly StateFile[]): boolean =>
    carries(own, secrets) || files.some((file) => file.path.startsWith(`${relPath}/`) && carries(file.portability, secrets));

export const workspaceMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, workspacePortability(relPath), WORKSPACE_STATE_FILES);

export const historyMayContain = (relPath: string, secrets: boolean): boolean =>
    mayContainCarried(relPath, secrets, historyPortability(relPath), HISTORY_STATE_FILES);
