import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isLockedWorkspacePath, isReviewableLockedPath } from "@intentic/sandbox-contract";

// Resolves a repo-relative path against `dir`, refusing any that climbs outside via `../` or an absolute path.
// Returns undefined for the dir itself or an escaping path.
export const resolveWithin = (dir: string, relPath: string): string | undefined => {
    const base = resolve(dir);
    const target = resolve(base, relPath);
    const rel = relative(base, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
        return undefined;
    }
    return target;
};

// Resolves the real disk location of a path; resolveWithin is lexical and a symlink can point outside /work.
// A missing path resolves through its deepest existing ancestor; the root is resolved too, since /work may be a
// symlink.
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
            // Nothing on this path exists; the lexical answer is all there is to compare.
            return absPath;
        }
        missing.push(basename(head));
        head = parent;
    }
};

// The subset of relPaths that resolve inside `dir` AND exist there, in the order given, deduped. For paths nobody
// chose (a tokenizer's reading of message text): a miss is dropped, never raised.
export const resolveExistingWithin = async (dir: string, relPaths: readonly string[] = []): Promise<string[]> => {
    const found: string[] = [];
    for (const rel of relPaths) {
        const abs = resolveWithin(dir, rel);
        if (abs === undefined || found.includes(abs)) {
            continue;
        }
        if (
            await stat(abs).then(
                () => true,
                () => false,
            )
        ) {
            found.push(abs);
        }
    }
    return found;
};

// Resolves absPath for real and checks whether it lands under root's real path, or undefined if not.
export const realWithin = async (root: string, absPath: string): Promise<string | undefined> => {
    const realRoot = await realPathOf(resolve(root));
    return isUnder(realRoot, await realPathOf(absPath));
};

// Whether a resolved path is root or under it, given both sides already resolved; avoids re-resolving root per entry.
export const isUnder = (realRoot: string, real: string): string | undefined =>
    real === realRoot || real.startsWith(realRoot + sep) ? real : undefined;

// Whether absPath is under the root's locked paths (.intentic/), per isLockedWorkspacePath in the contract package.
// Blocks the generic file API from touching them, owner included; root's .git is covered too, as a file entry.
export const isControlPlanePath = (root: string, absPath: string): boolean => isLockedWorkspacePath(relative(resolve(root), absPath));

// Diff-only carve-out for a tracked control-plane entry (capabilities.json) whose change is meant to be reviewed.
// Every other surface still uses isControlPlanePath alone.
export const isReviewableStatePath = (root: string, absPath: string): boolean => isReviewableLockedPath(relative(resolve(root), absPath));
