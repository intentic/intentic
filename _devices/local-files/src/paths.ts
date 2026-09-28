import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
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

// Why a write is refused at a link that resolves to nothing (dangling, or a loop): where it would land is unknowable
// until the write creates it, and a link can name any place on the disk.
export const BROKEN_LINK = `a link that points at nothing cannot be written through`;

const entryOf = (abs: string): Promise<Stats | undefined> =>
    // allow(silent-catch): nothing at the path at all, not even a link, is the undefined its caller walks past.
    lstat(abs).catch(() => undefined);

// Where a write to `path` lands, as a path with no link anywhere in it: the real path of the file when it exists, else
// the real path of its nearest existing ancestor with the missing names below it, which the write creates fresh. The
// ancestor is found by lstat, so a link that resolves to nothing is met as the thing it is and refused rather than
// walked past: a write through it would create whatever it names, anywhere on the disk.
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
    for (let probe = abs; ; probe = dirname(probe)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one ancestor at a time, nearest first, stopping at the first that exists
        const entry = await entryOf(probe);
        if (entry !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- runs once, for the ancestor that ends the walk
            return landingUnder(root, probe, relative(probe, abs), entry);
        }
        if (probe === root || dirname(probe) === probe) {
            return { kind: `refused`, why: `outside this folder` };
        }
    }
};

// The write's landing below the nearest thing that exists on its path: that thing must be a folder, really inside the
// root, and not a link to nothing.
const landingUnder = async (root: string, ancestor: string, rest: string, entry: Stats): Promise<Resolved> => {
    const real = await realOf(ancestor);
    if (real === undefined) {
        return { kind: `refused`, why: entry.isSymbolicLink() ? BROKEN_LINK : `invalid path` };
    }
    if (!within(root, real)) {
        return { kind: `refused`, why: `outside this folder` };
    }
    // allow(silent-catch): an ancestor gone since it was resolved holds nothing to write into.
    const folder = await stat(real).catch(() => undefined);
    return folder?.isDirectory() === true ? { kind: `found`, abs: join(real, rest) } : { kind: `refused`, why: `not a folder` };
};
