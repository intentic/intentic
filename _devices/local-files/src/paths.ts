import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// Every path a window names is root-relative with forward slashes, as the contract carries it, and is only ever
// resolved here: lexically first (no `..`, no drive, no NUL), then on disk, where the real path of whatever exists must
// still be inside the root. The second check is the one that matters on a user's own disk, where a link inside a folder
// can point anywhere on it.

// Why a path resolved to nothing: not a path this side accepts, or nothing at it.
export type Unresolved = { readonly kind: "refused"; readonly why: string } | { readonly kind: "missing" };
export type Resolved = { readonly kind: "found"; readonly abs: string } | Unresolved;

// Whether `abs` is `root` itself or somewhere under it; both real paths. `..name` is a legal file name, so only a
// whole `..` segment counts as leaving.
export const within = (root: string, abs: string): boolean => {
    const rel = relative(root, abs);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// The path's segments once it is known not to leave the root by spelling alone; undefined when it tries to. A
// backslash is refused rather than read: it is a separator on Windows and a name character elsewhere, and a path that
// means two things is not one to guess at.
export const segmentsOf = (path: string): readonly string[] | undefined => {
    if (path.includes(`\0`) || path.includes(`\\`)) {
        return undefined;
    }
    const segments = path.split(`/`).filter((segment) => segment !== `` && segment !== `.`);
    if (segments.includes(`..`) || /^[A-Za-z]:$/.test(segments[0] ?? ``)) {
        return undefined;
    }
    return segments;
};

// The root-relative spelling of a path, `""` for the root: the key every grant and event speaks in.
export const cleanRelPath = (path: string): string | undefined => segmentsOf(path)?.join(`/`);

const realOf = (abs: string): Promise<string | undefined> =>
    // allow(silent-catch): a path that does not resolve is the undefined its callers read as "nothing there".
    realpath(abs).catch(() => undefined);

// An existing file or folder to read, as its real path.
export const resolveExisting = async (root: string, path: string): Promise<Resolved> => {
    const segments = segmentsOf(path);
    if (segments === undefined) {
        return { kind: `refused`, why: `invalid path` };
    }
    const real = await realOf(join(root, ...segments));
    if (real === undefined) {
        return { kind: `missing` };
    }
    return within(root, real) ? { kind: `found`, abs: real } : { kind: `refused`, why: `outside this folder` };
};

// Where a write to `path` lands: the real path of the file when it exists, else the path under its nearest existing
// ancestor, which must itself be inside the root, since a linked folder half way down could lead out of it.
export const resolveWritable = async (root: string, path: string): Promise<Resolved> => {
    const segments = segmentsOf(path);
    if (segments === undefined || segments.length === 0) {
        return { kind: `refused`, why: `invalid path` };
    }
    const abs = join(root, ...segments);
    const real = await realOf(abs);
    if (real !== undefined) {
        return within(root, real) ? { kind: `found`, abs: real } : { kind: `refused`, why: `outside this folder` };
    }
    for (let probe = dirname(abs); ; probe = dirname(probe)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one ancestor at a time, nearest first, stopping at the first that exists
        const ancestor = await realOf(probe);
        if (ancestor !== undefined) {
            return within(root, ancestor) ? { kind: `found`, abs } : { kind: `refused`, why: `outside this folder` };
        }
        if (probe === root || dirname(probe) === probe) {
            return { kind: `refused`, why: `outside this folder` };
        }
    }
};
