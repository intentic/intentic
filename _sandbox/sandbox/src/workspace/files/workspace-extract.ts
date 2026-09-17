import { spawn } from "node:child_process";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ArchiveFormat, archiveFormat, archiveStem, wrapsItsOwnName } from "@intentic/sandbox-contract";

// Unpacking an archive the way someone means it: one new folder beside the archive, named after it, holding what was
// inside. Nothing is overwritten, an archive that is one folder doesn't land as that folder twice, and a failure
// takes its own half-written folder with it.

/** A format this sandbox holds no tool for (.7z, .rar), or a name that isn't an archive at all. */
export class UnknownArchiveError extends Error {
    constructor(file: string) {
        super(`nothing here unpacks ${file}`);
    }
}

// The child that does the unpacking; stdin is closed, so a tool that wants an answer fails instead of hanging.
const TOOLS: Readonly<Record<ArchiveFormat, (archive: string, target: string) => readonly [string, string[]]>> = {
    zip: (archive, target) => ["unzip", ["-qq", "-o", archive, "-d", target]],
    // GNU tar sniffs the compression itself, and refuses a member whose path climbs out of the target.
    tar: (archive, target) => ["tar", ["-x", "--no-same-owner", "-f", archive, "-C", target]],
    gzip: (archive) => ["gzip", ["-d", "-c", archive]],
    bzip2: (archive) => ["bzip2", ["-d", "-c", archive]],
    xz: (archive) => ["xz", ["-d", "-c", archive]],
    zstd: (archive) => ["zstd", ["-d", "-c", "-q", archive]],
};

// Longer than any honest archive in a workspace takes; a bomb or a corrupt file ends here rather than forever.
const EXTRACT_TIMEOUT_MS = 2 * 60_000;
// Enough of the tool's complaint to act on, without carrying a thousand skipped-member lines into an error.
const STDERR_TAIL = 2_000;
// `name 2`, `name 3` … before giving up: a folder holding this many extractions of one archive wants none.
const MAX_FREE_NAMES = 100;

// unzip exits 1 for warnings it recovered from (a skipped unsafe path, a duplicate member): the extraction happened.
const succeeded = (format: ArchiveFormat, code: number | null): boolean => code === 0 || (format === "zip" && code === 1);

/**
 * Spawns the tool for `format` over `archive`; `stdout` is the fd a single-file format decompresses into. Aborting
 * `abort` kills the tool mid-write, which is how a caller watching the bytes land stops one that won't fit.
 */
export const unpack = (format: ArchiveFormat, archive: string, target: string, stdout: number | "ignore", abort?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const [command, args] = TOOLS[format](archive, target);
        const child = spawn(command, args, { stdio: ["ignore", stdout, "pipe"], timeout: EXTRACT_TIMEOUT_MS, ...(abort === undefined ? {} : { signal: abort }) });
        let complaint = ``;
        child.stderr?.setEncoding(`utf8`);
        child.stderr?.on(`data`, (chunk: string) => {
            complaint = (complaint + chunk).slice(-STDERR_TAIL);
        });
        // The image bakes every tool named above, so a missing one is a broken image rather than a bad archive:
        // say which binary is gone instead of leaving "spawn ENOENT" as the whole account.
        child.on(`error`, (failure: NodeJS.ErrnoException) =>
            reject(failure.code === `ENOENT` ? new Error(`${command} is not installed in this sandbox`) : failure),
        );
        child.on(`close`, (code, signal) => {
            if (succeeded(format, code)) {
                resolve();
                return;
            }
            const why = signal === null ? complaint.trim() : `it took longer than ${EXTRACT_TIMEOUT_MS / 1000}s`;
            reject(new Error(`${command} could not unpack ${basename(archive)}${why === `` ? `` : `: ${why}`}`));
        });
    });

// Claims the first free `name`, `name 2`, … by creating it: the create is the claim, so two extractions at once can't
// pick the same name.
const claim = async <T>(parent: string, base: string, create: (path: string) => Promise<T>): Promise<{ path: string; claimed: T }> => {
    for (let index = 1; index <= MAX_FREE_NAMES; index++) {
        const path = join(parent, index === 1 ? base : `${base} ${index}`);
        try {
            return { path, claimed: await create(path) };
        } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== `EEXIST`) {
                throw failure;
            }
        }
    }
    throw new Error(`there are already ${MAX_FREE_NAMES} folders named like ${base}`);
};

// Resource forks a Mac's zip carries beside the real tree. Junk everywhere else, and the usual reason an archive that
// is one folder doesn't look like one.
const MAC_JUNK = `__MACOSX`;

/** Drops the junk and flattens the doubled folder, so an unpacked tree reads the way its archive was meant to. */
export const tidyUnpacked = async (target: string, stem: string): Promise<void> => {
    await rm(join(target, MAC_JUNK), { recursive: true, force: true });
    await unwrapSoleRoot(target, stem);
};

// `site.zip` holding a single `site/` is the doubled folder every zip tool makes; its contents move up so the
// extraction is one folder deep instead of two.
const unwrapSoleRoot = async (target: string, stem: string): Promise<void> => {
    const roots = await readdir(target, { withFileTypes: true });
    const sole = roots.length === 1 ? roots[0] : undefined;
    if (sole === undefined || !sole.isDirectory() || !wrapsItsOwnName(sole.name, stem)) {
        return;
    }
    const inner = join(target, sole.name);
    const children = await readdir(inner);
    // A child under its own folder's name would be renamed onto the folder it is being lifted out of; leave it nested.
    if (children.includes(sole.name)) {
        return;
    }
    for (const child of children) {
        await rename(join(inner, child), join(target, child));
    }
    await rm(inner, { recursive: true });
};

/**
 * Unpacks one archive beside itself and answers with the absolute path of what landed: a folder for a zip or tar, the
 * decompressed file for a lone .gz/.bz2/.xz/.zst. Both paths are new, never an existing entry written over.
 */
export const extractArchive = async (absArchive: string): Promise<string> => {
    const name = basename(absArchive);
    const format = archiveFormat(name);
    const stem = archiveStem(name);
    if (format === undefined || stem === undefined) {
        throw new UnknownArchiveError(name);
    }
    const parent = dirname(absArchive);
    if (format === `gzip` || format === `bzip2` || format === `xz` || format === `zstd`) {
        // The stem is the file the archive was made from, so it lands as itself. `wx` fails on an existing name, which
        // is what walks `claim` on to the next one.
        const { path, claimed } = await claim(parent, stem, (candidate) => open(candidate, `wx`));
        try {
            await unpack(format, absArchive, parent, claimed.fd);
        } catch (failure) {
            await rm(path, { force: true });
            throw failure;
        } finally {
            await claimed.close();
        }
        return path;
    }
    const { path } = await claim(parent, stem, (candidate) => mkdir(candidate));
    try {
        await unpack(format, absArchive, path, `ignore`);
        await tidyUnpacked(path, stem);
    } catch (failure) {
        await rm(path, { recursive: true, force: true });
        throw failure;
    }
    return path;
};
