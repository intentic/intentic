import { realpath } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { Pairing } from "./config.js";

// ONE FOLDER, ONE SYNC. Two pairings over the same folder, or one inside the other, are two synchronizers writing the
// same files on behalf of two sandboxes: each carries the other's writes to its own sandbox as edits, and a workspace
// folder holding a project folder puts one sandbox's /work inside the other's project. Nothing refused it while every
// folder was `~/intentic/<id>`; a project folder is picked anywhere on disk.

// The deepest existing ancestor's real path with the rest of `path` put back, so a folder `setup` has not created yet
// still resolves through whatever link its parent is.
const realOrAncestor = async (path: string, rest: readonly string[]): Promise<string> => {
    // allow(silent-catch): a folder that is not there yet, or cannot be read, is named by its nearest ancestor that resolves.
    const real = await realpath(path).catch(() => undefined);
    if (real !== undefined) {
        return join(real, ...rest);
    }
    const parent = dirname(path);
    return parent === path ? join(path, ...rest) : await realOrAncestor(parent, [basename(path), ...rest]);
};

// A folder as the filesystem resolves it, links followed, so `~/code` and a link pointing at it are one folder.
export const canonicalFolder = async (dir: string): Promise<string> => await realOrAncestor(resolve(dir), []);

// Where the platform's own volumes compare names without case (NTFS, APFS): `~/Code/app` and `~/code/app` are one
// folder there and two elsewhere.
const foldsCase = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

// Whether two absolute folders are the same one, or one holds the other. Pure, the platform passed in, so the Windows and
// macOS rules are checkable from any host.
export const foldersOverlap = (first: string, second: string, platform: NodeJS.Platform = process.platform): boolean => {
    const path = platform === "win32" ? win32 : posix;
    const fold = (dir: string): string => (foldsCase(platform) ? path.resolve(dir).toLowerCase() : path.resolve(dir));
    const within = (inner: string, outer: string): boolean => {
        const rel = path.relative(outer, inner);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    const [a, b] = [fold(first), fold(second)];
    return within(a, b) || within(b, a);
};

// The pairing of ANOTHER sandbox whose folder this one would be, hold, or sit inside; undefined when none. The same
// sandbox's own pairing is not a clash: setting it up again, here or in a new folder, replaces it.
export const overlappingPairing = async (
    folder: string,
    sandboxId: string,
    pairings: readonly Pairing[],
    platform: NodeJS.Platform = process.platform,
): Promise<(Pairing & { readonly localDir: string }) | undefined> => {
    const wanted = await canonicalFolder(folder);
    const others = await Promise.all(
        pairings
            .flatMap((held) => (held.sandboxId === sandboxId || held.localDir === undefined ? [] : [{ ...held, localDir: held.localDir }]))
            .map(async (held) => ({ held, folder: await canonicalFolder(held.localDir) })),
    );
    return others.find((other) => foldersOverlap(wanted, other.folder, platform))?.held;
};
