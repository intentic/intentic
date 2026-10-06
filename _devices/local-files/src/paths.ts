import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import hostPath, { basename, dirname, join, type PlatformPath, relative } from "node:path";

// Every path a window names is root-relative with forward slashes, as the contract carries it, and is only ever
// resolved here: lexically first (no `..`, no drive, no NUL), then on disk, where the real path of whatever exists must
// still be inside the root. The second check is the one that matters on a user's own disk, where a link inside a folder
// can point anywhere on it.

// Why a path resolved to nothing: not a path this side accepts, or nothing at it.
export type Unresolved = { readonly kind: "refused"; readonly why: string } | { readonly kind: "missing" };
export type Resolved = { readonly kind: "found"; readonly abs: string } | Unresolved;

// Whether `abs` is `root` itself or somewhere under it; both real paths. `..name` is a legal file name, so only a
// whole `..` segment counts as leaving. Read by this platform's path rules unless others are named: Windows compares
// without case.
export const within = (root: string, abs: string, rules: PlatformPath = hostPath): boolean => {
    const rel = rules.relative(root, abs);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${rules.sep}`) && !rules.isAbsolute(rel));
};

// The path's segments once it is known not to leave the root by spelling alone; undefined when it tries to. A
// backslash is refused rather than read: it is a separator on Windows and a name character elsewhere, and a path that
// means two things is not one to guess at. On Windows, so is a name Windows cannot hold (`windowsHolds`).
export const segmentsOf = (path: string, platform: NodeJS.Platform = process.platform): readonly string[] | undefined => {
    if (path.includes(`\0`) || path.includes(`\\`)) {
        return undefined;
    }
    const segments = path.split(`/`).filter((segment) => segment !== `` && segment !== `.`);
    if (segments.includes(`..`) || /^[A-Za-z]:$/.test(segments[0] ?? ``)) {
        return undefined;
    }
    return platform === `win32` && !segments.every(windowsHolds) ? undefined : segments;
};

// (2026-10-06) Whether Windows can hold a name: none of `<>:"|?*` or a control character, no trailing dot or space, and
// no device name (`CON`, `NUL`, `COM1`…, with or without an extension). Measured on NTFS: `a.txt:ads` resolved to a
// hidden stream of `a.txt`, `a.txt::$DATA` to `a.txt` itself, and a file made as `nul` could not be deleted by
// PowerShell. The machine agent's project-files.ts holds the same rule.
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const windowsHolds = (name: string): boolean => !WINDOWS_FORBIDDEN.test(name) && !/[. ]$/.test(name) && !WINDOWS_DEVICE.test(name);

// The root-relative spelling of a path, `""` for the root: the key every grant and event speaks in.
export const cleanRelPath = (path: string): string | undefined => segmentsOf(path)?.join(`/`);

// Why a path is refused whose real path leaves the folder, however it was spelled.
export const OUTSIDE = `outside this folder`;

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
    return within(root, real) ? { kind: `found`, abs: real } : { kind: `refused`, why: OUTSIDE };
};

// Why a write is refused at a link that resolves to nothing (dangling, or a loop): where it would land is unknowable
// until the write creates it, and a link can name any place on the disk.
export const brokenLink = (name: string): string => `“${name}” is a link to something that isn't there.`;

export const entryOf = (abs: string): Promise<Stats | undefined> =>
    // allow(silent-catch): nothing at the path at all, not even a link, is the undefined its caller walks past.
    lstat(abs).catch(() => undefined);

// Where a link at `abs` leads when a write names it: the real path it resolves to inside the root, never past it, and
// never a place that is not there yet.
const throughLink = async (root: string, abs: string): Promise<Resolved> => {
    const real = await realOf(abs);
    if (real === undefined) {
        return { kind: `refused`, why: brokenLink(basename(abs)) };
    }
    return within(root, real) ? { kind: `found`, abs: real } : { kind: `refused`, why: OUTSIDE };
};

// Where a write to `path` lands, as a path with no link anywhere in it: the real path of the file when it exists, else
// the real path of its nearest existing ancestor with the missing names below it, which the write creates fresh. The
// name itself is looked at by lstat first, so a link there is followed only to a real place inside the root. The
// ancestor is found by lstat too, so a link that resolves to nothing is met as the thing it is and refused rather than
// walked past: a write through it would create whatever it names, anywhere on the disk.
export const resolveWritable = async (root: string, path: string): Promise<Resolved> => {
    const segments = segmentsOf(path);
    if (segments === undefined || segments.length === 0) {
        return { kind: `refused`, why: `invalid path` };
    }
    const abs = join(root, ...segments);
    if ((await entryOf(abs))?.isSymbolicLink() === true) {
        return throughLink(root, abs);
    }
    const real = await realOf(abs);
    if (real !== undefined) {
        return within(root, real) ? { kind: `found`, abs: real } : { kind: `refused`, why: OUTSIDE };
    }
    for (let probe = abs; ; probe = dirname(probe)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one ancestor at a time, nearest first, stopping at the first that exists
        const entry = await entryOf(probe);
        if (entry !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- runs once, for the ancestor that ends the walk
            return landingUnder(root, probe, relative(probe, abs), entry);
        }
        if (probe === root || dirname(probe) === probe) {
            return { kind: `refused`, why: OUTSIDE };
        }
    }
};

// The write's landing below the nearest thing that exists on its path: that thing must be a folder, really inside the
// root, and not a link to nothing.
const landingUnder = async (root: string, ancestor: string, rest: string, entry: Stats): Promise<Resolved> => {
    const real = await realOf(ancestor);
    if (real === undefined) {
        return { kind: `refused`, why: entry.isSymbolicLink() ? brokenLink(basename(ancestor)) : `invalid path` };
    }
    if (!within(root, real)) {
        return { kind: `refused`, why: OUTSIDE };
    }
    // allow(silent-catch): an ancestor gone since it was resolved holds nothing to write into.
    const folder = await stat(real).catch(() => undefined);
    return folder?.isDirectory() === true ? { kind: `found`, abs: join(real, rest) } : { kind: `refused`, why: `not a folder` };
};

// An existing entry to move, copy or delete as itself: a link is the link, never what it points at, so a delete or a
// move never reaches past it. The folder the entry sits in is resolved by its real path, which must be inside the root,
// so the answer has no link above the entry either.
export const resolveEntry = async (root: string, path: string): Promise<Resolved> => {
    const segments = segmentsOf(path);
    const name = segments?.at(-1);
    if (segments === undefined || name === undefined) {
        return { kind: `refused`, why: `invalid path` };
    }
    const folder = await realOf(join(root, ...segments.slice(0, -1)));
    if (folder === undefined) {
        return { kind: `missing` };
    }
    if (!within(root, folder)) {
        return { kind: `refused`, why: OUTSIDE };
    }
    const abs = join(folder, name);
    return (await entryOf(abs)) === undefined ? { kind: `missing` } : { kind: `found`, abs };
};
