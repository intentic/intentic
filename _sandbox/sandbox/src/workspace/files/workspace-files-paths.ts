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

// Where relPath lands inside dir once every symlink on the way is followed, for reads and writes alike; undefined when
// it climbs out lexically or a symlinked folder leads out. `path` is the lexical answer callers open, `real` and
// `realRel` (relative to dir's own real path) are what they check: a folder linked elsewhere inside /work keeps the
// path inside, but can still lead somewhere a caller refuses. A write target that does not exist yet resolves through
// its deepest existing ancestor. `entry` asks about the entry itself rather than what a final symlink points at, for
// a removal, which takes the link and leaves its target alone.
export const resolveRealWithin = async (
    dir: string,
    relPath: string,
    options: { readonly entry?: boolean } = {},
): Promise<{ readonly path: string; readonly real: string; readonly realRel: string } | undefined> => {
    const path = resolveWithin(dir, relPath);
    if (path === undefined) {
        return undefined;
    }
    const realDir = await realPathOf(resolve(dir));
    const real = options.entry === true ? join(await realPathOf(dirname(path)), basename(path)) : await realPathOf(path);
    // The dir itself is refused, as resolveWithin refuses it: a symlink naming the root is not a path inside it.
    if (real === realDir || isUnder(realDir, real) === undefined) {
        return undefined;
    }
    return { path, real, realRel: relative(realDir, real) };
};

// A workspace path as every write and copy out of /work must see it: inside the root on disk, and outside the control
// plane both as spelled and as it really lands, since a symlinked folder can lead into .intentic/ without leaving /work.
export type WorkspacePath =
    | { readonly kind: "inside"; readonly path: string; readonly real: string; readonly realRel: string }
    | { readonly kind: "outside" }
    | { readonly kind: "controlPlane" };

export const resolveWorkspacePath = async (root: string, relPath: string): Promise<WorkspacePath> => {
    const lexical = resolveWithin(root, relPath);
    if (lexical === undefined) {
        return { kind: "outside" };
    }
    if (isControlPlanePath(root, lexical)) {
        return { kind: "controlPlane" };
    }
    const contained = await resolveRealWithin(root, relPath);
    if (contained === undefined) {
        return { kind: "outside" };
    }
    if (isLockedWorkspacePath(contained.realRel)) {
        return { kind: "controlPlane" };
    }
    return { kind: "inside", ...contained };
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
