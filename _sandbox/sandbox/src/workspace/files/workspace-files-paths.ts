import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isLockedWorkspacePath, isReviewableLockedPath } from "@intentic/sandbox-contract";

// Resolve a repo-relative path to an absolute one, guarding against escaping the repo dir: the daemon serves
// file reads/writes for the workspace repos, so a `../` or absolute path must not reach outside them. Returns
// undefined for the dir itself or any path that climbs out (the daemon answers 400 rather than touching it).
export const resolveWithin = (dir: string, relPath: string): string | undefined => {
    const base = resolve(dir);
    const target = resolve(base, relPath);
    const rel = relative(base, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
        return undefined;
    }
    return target;
};

/* THE SAME QUESTION, ASKED OF THE DISK, where a path's bytes actually live once symlinks are followed.
 *
 * resolveWithin above is a string operation, and a string cannot see a link: `/work/x` is inside /work by every
 * lexical measure even when it is `ln -s` to somewhere else entirely. That was harmless while the explorer
 * filtered symlinks out of every listing and nothing in the UI could name one. It stops being harmless the
 * moment the tree LISTS them, a link is then something a person clicks, and there is real state one directory
 * up: the capability secret vault and every agent-provider login live under AGENT_AUTH_DIR, off /work
 * specifically so the file routes, the tree walk and the search index cannot reach them (composition.ts).
 *
 * So reads, listings and writes resolve for real and re-check. Same guard the public outbox already applies to
 * every request it serves (public-files.ts rule 1), for the same reason and by the same means.
 *
 * A path that does not exist yet resolves through its deepest existing ANCESTOR, a write creating a new file
 * must still be checked, and the segments below that ancestor cannot be links precisely because they are not
 * there. And the ROOT is resolved too: on the hosted VM /work is itself a symlink onto the persistent volume,
 * so comparing a real path against a symlinked root would refuse every legitimate path under it. */
export const realPathOf = async (absPath: string): Promise<string> => {
    const missing: string[] = [];
    let head = absPath;
    for (;;) {
        const real = await realpath(head).catch(() => undefined);
        if (real !== undefined) {
            return missing.length === 0 ? real : join(real, ...missing.toReversed());
        }
        const parent = dirname(head);
        if (parent === head) {
            // Nothing on this path exists, not even a root, the lexical answer is all there is to compare.
            return absPath;
        }
        missing.push(basename(head));
        head = parent;
    }
};

// Where `absPath` really is, or undefined when that turns out to be outside `root`. Callers that need the
// resolved path (the tree's cycle guard) get it; callers that only need the verdict test for undefined.
export const realWithin = async (root: string, absPath: string): Promise<string | undefined> => {
    const realRoot = await realPathOf(resolve(root));
    return isUnder(realRoot, await realPathOf(absPath));
};

// Whether a REAL path (both sides already resolved) is the root or under it. Split out because a caller
// listing a directory resolves the root once and then asks this of every entry, realpath'ing the root per
// entry would be a syscall storm on a folder full of links, which pnpm's node_modules is.
export const isUnder = (realRoot: string, real: string): string | undefined =>
    real === realRoot || real.startsWith(realRoot + sep) ? real : undefined;

// Whether an absolute path lands in the daemon's control plane, its credential, authorization and private
// runtime state, all of it directly under the WORKSPACE ROOT's .intentic/. Which entries those are is declared
// once in the contract package (isLockedWorkspacePath), because the explorer draws the same rule as a padlock;
// this function is the half that enforces it, and it is the only half that touches the disk.
//
// owner.json and members.json ARE the answer to "who may drive this sandbox", re-read from disk on every
// request, ci.json carries the CI webhook secret, and auth/ holds every agent-provider runtime home plus the
// capability and extension-settings credential vaults (AGENT_AUTH_DIR moves that tree out of /work entirely, and
// then none of it is reachable to begin with). sessions/ holds provider-native conversation state, and browser/
// holds logged-in Chromium profiles.
//
// capabilities.json is the one entry here that is NOT a secret and is locked anyway, so it is worth saying why
// rather than leaving the next reader to assume the old reason: its credentials moved to the vault, and it is
// tracked in the root repo now. What it still is, is the list of things this sandbox may reach, an ssh host, an
// mcp server and the command it runs, so a member who could PUT one through the generic file API would be
// granting themselves a capability the owner never approved. The lock is about that write, not about the read. Protecting whole lifecycle roots keeps a new provider or session artifact from
// becoming readable merely because that list was not updated with its leaf name. Retired provider roots stay
// denied even though no producer reads them: an abandoned credential must not become downloadable merely
// because its active path moved.
//
// Every one of those files has a purpose-built, owner-gated route, so the GENERIC file API must not tunnel
// around them: a member, someone the owner invited to collaborate, could otherwise upload their own owner.json
// and take the sandbox, or read the owner's provider token straight back out of the raw route. Denied for
// everyone, the owner included: no flow needs to reach a token through the file API, and a rule with no role in
// it cannot be got wrong at a call site.
//
// The ROOT's own .git is covered too, subtree included. It is the --separate-git-dir pointer to
// /history/gits/root, the handle to the shadow history repo, which lives off /work precisely so the agent can't
// tamper with it (see git/root-repo.ts). It is also a FILE where a client that drops a repo's CONTENTS at the
// root tries to write a directory: without this floor, writeWorkspaceFileStream's mkdir throws ENOTDIR/EEXIST
// per entry and the upload route 500s the whole drop instead of skipping the handful of paths that were never
// writable to begin with.
export const isControlPlanePath = (root: string, absPath: string): boolean => isLockedWorkspacePath(relative(resolve(root), absPath));

// The one carve-out, and it applies to DIFFS ONLY, a control-plane entry the root repo tracks, whose change is
// meant to be reviewed (isReviewableLockedPath holds the full reasoning; capabilities.json is the only one).
// Asked alongside the check above by the two git review routes, so a row the Changes panel lists because git
// reports it can actually be opened. Reading the diff publishes nothing the tracking did not: those bytes are in
// `git log` and in every clone. Every other surface asks isControlPlanePath alone and still refuses.
export const isReviewableStatePath = (root: string, absPath: string): boolean => isReviewableLockedPath(relative(resolve(root), absPath));
