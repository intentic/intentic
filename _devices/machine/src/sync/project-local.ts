import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";
import { type FileStamp, isPortablePath, type Listed } from "./project-files.js";

// THIS DEVICE'S SIDE of a copy-first project: its listing, the record that keeps listing it cheap, and the only writes
// `bring-back` and `restore` make into the owner's folder, each of which refuses to follow a link out of it.

// sha256 for the listings; sha1 only to compare with Mutagen's own digests (project-remote.ts ReportedConflict).
export const hashFile = async (path: string, algorithm: "sha256" | "sha1" = "sha256"): Promise<string> => {
    const digest = createHash(algorithm);
    for await (const chunk of createReadStream(path)) {
        digest.update(chunk);
    }
    return digest.digest("hex");
};

// ON THE DISK, NOT JUST WRITTEN: what a restore point needs before the folder it protects is touched, since after a crash
// a rename can be on the disk while the bytes it was meant to protect are not. A file's bytes, and a folder's entries;
// the latter on POSIX only, since Windows cannot open a folder for it and NTFS journals its entries itself.
export interface Durability {
    readonly file: (path: string) => Promise<void>;
    readonly folder: (path: string) => Promise<void>;
}

const flushed = async (path: string, flags: "r" | "r+"): Promise<void> => {
    const handle = await open(path, flags);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
};

export const realDurability: Durability = {
    file: async (path) => await flushed(path, "r+"),
    folder: async (path) => {
        if (process.platform !== "win32") {
            await flushed(path, "r");
        }
    },
};

// A file's hash as last read, good for as long as its size and both its times are unchanged: an edit moves the change
// time even where a tool puts the modification time back.
export interface CachedHash {
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly hash: string;
}

// What a pairing's listings leave behind, under the agent's own state dir: every hash read (the cache), and each path's
// content when the two copies were last seen equal (project-files.ts `classify`). Tied to the two folders it was taken
// of; a record of others is started over.
const RecordSchema = z.object({
    localDir: z.string(),
    remoteDir: z.string(),
    files: z.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.string()])),
    agreed: z.record(z.string(), z.string()),
});

export interface ListingRecord {
    readonly files: ReadonlyMap<string, CachedHash>;
    readonly agreed: ReadonlyMap<string, string>;
}

// Named for the pairing's key (config.ts `pairingKey`), the sandbox id for every pairing but a folder attached to one.
export const listingRecordPath = (stateDir: string, key: string): string => join(stateDir, "hashes", `${encodeURIComponent(key)}.json`);

// A record that is missing, unreadable or of other folders is an empty one: it only ever saves work and sharpens what
// counts as the sandbox's change, and without it every difference is offered, which is the safe way round.
export const readListingRecord = async (path: string, localDir: string, remoteDir: string): Promise<ListingRecord> => {
    const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
    const parsed = raw === undefined ? undefined : parseRecord(raw);
    if (parsed === undefined || parsed.localDir !== localDir || parsed.remoteDir !== remoteDir) {
        return { files: new Map(), agreed: new Map() };
    }
    const files = Object.entries(parsed.files).map(([file, [size, mtimeMs, ctimeMs, hash]]) => [file, { size, mtimeMs, ctimeMs, hash }] as const);
    return { files: new Map(files), agreed: new Map(Object.entries(parsed.agreed)) };
};

const parseRecord = (raw: string): z.infer<typeof RecordSchema> | undefined => {
    try {
        return RecordSchema.safeParse(JSON.parse(raw)).data;
    } catch {
        // allow(silent-catch): a torn record is an empty one (above).
        return undefined;
    }
};

export const writeListingRecord = async (path: string, localDir: string, remoteDir: string, record: ListingRecord): Promise<void> => {
    const files = Object.fromEntries([...record.files].map(([file, held]) => [file, [held.size, held.mtimeMs, held.ctimeMs, held.hash]]));
    await writeFileAtomic(path, JSON.stringify({ localDir, remoteDir, files, agreed: Object.fromEntries(record.agreed) }), 0o600);
};

export interface LocalWalk {
    readonly root: string;
    readonly ignored: (path: string) => boolean;
    readonly cached: ReadonlyMap<string, CachedHash>;
    // Whether a file's content must be read: only where its size says nothing yet (project-transfer.ts).
    readonly wantsHash: (path: string, size: number) => boolean;
}

export interface LocalListing {
    readonly listing: ReadonlyMap<string, Listed>;
    // Every hash known after the walk, the next cache.
    readonly hashes: ReadonlyMap<string, CachedHash>;
}

// A missing folder is refused rather than listed as empty: that would offer the sandbox's every file for writing into
// wherever the folder was, a disk that is not mounted included.
export const assertFolder = async (root: string): Promise<void> => {
    const info = await stat(root).catch(undefinedIfMissing);
    if (info?.isDirectory() !== true) {
        throw new Error(`${root} is not there (moved, deleted, or on a disk that is not connected)`);
    }
};

// This device's copy, pruned by the same ignore list the sandbox's walk uses, hashed only where needed.
export const walkLocal = async (walk: LocalWalk): Promise<LocalListing> => {
    await assertFolder(walk.root);
    const listing = new Map<string, Listed>();
    const hashes = new Map<string, CachedHash>();
    // The file's hash, undefined where it is not needed, null where it could not be read: a file this device cannot read
    // is left uncompared, like a link, rather than failing the listing.
    const hashOf = async (path: string, info: { size: number; mtimeMs: number; ctimeMs: number }): Promise<string | null | undefined> => {
        const held = walk.cached.get(path);
        if (held !== undefined && held.size === info.size && held.mtimeMs === info.mtimeMs && held.ctimeMs === info.ctimeMs) {
            return held.hash;
        }
        return walk.wantsHash(path, info.size)
            ? await hashFile(join(walk.root, path)).then(
                  (hash) => hash,
                  () => null,
              )
            : undefined;
    };
    // One entry that is not a folder, as the listing holds it; undefined for one gone mid-walk.
    const entryOf = async (path: string, isFile: boolean): Promise<Listed | undefined> => {
        const info = isFile ? await lstat(join(walk.root, path)).catch(undefinedIfMissing) : undefined;
        if (info === undefined) {
            return isFile ? undefined : "other";
        }
        const hash = info.isFile() ? await hashOf(path, info) : null;
        if (hash === null) {
            return "other";
        }
        if (hash !== undefined) {
            hashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, hash });
        }
        return { size: info.size, hash };
    };
    const visit = async (relative: string): Promise<void> => {
        const entries = (await readdir(join(walk.root, relative), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
        for (const entry of entries) {
            const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
            if (!isPortablePath(path) || walk.ignored(path)) {
                continue;
            }
            if (entry.isDirectory()) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- depth-first, one directory at a time
                await visit(path);
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time keeps a large folder's walk bounded
            const listed = await entryOf(path, entry.isFile());
            if (listed !== undefined) {
                listing.set(path, listed);
            }
        }
    };
    await visit("");
    return { listing, hashes };
};

// THE ONE WAY INTO THE OWNER'S FOLDER. A relative path from the sandbox is joined onto it only after every part of the
// way has been read without following anything: a directory that is a link (an agent can make one, and copy-first
// carries nothing back to stop it) would otherwise take a write anywhere on this disk. Missing directories are fine,
// the write creates them; the file itself must be a regular file or absent.
export const localTarget = async (root: string, path: string): Promise<string> => {
    if (!isPortablePath(path)) {
        throw new Error(`${JSON.stringify(path)} is not a path inside the folder`);
    }
    const parts = path.split("/");
    let target = root;
    for (const [at, part] of parts.entries()) {
        target = join(target, part);
        // oxlint-disable-next-line eslint/no-await-in-loop -- each step is read before the next is trusted
        const info = await lstat(target).catch(undefinedIfMissing);
        if (info === undefined) {
            break;
        }
        const last = at === parts.length - 1;
        if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
            throw new Error(last ? "something other than a regular file is here" : `${parts.slice(0, at + 1).join("/")} is not a plain folder here`);
        }
    }
    return join(root, ...parts);
};

// What this device holds at a path now: absent, or a regular file's size, hash and permission bits.
export interface LocalFile extends FileStamp {
    readonly hash: string;
    readonly mode: number;
}

export const localFile = async (root: string, path: string): Promise<LocalFile | undefined> => {
    const target = await localTarget(root, path);
    const info = await lstat(target).catch(undefinedIfMissing);
    return info === undefined ? undefined : { size: info.size, hash: await hashFile(target), mode: info.mode & 0o7777 };
};

// Windows refuses a rename over a file another process holds open for a moment (an editor, an indexer); these codes are
// that moment. Anywhere else they are a permission, which waiting never changes.
const TRANSIENT_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);

const renameInto = async (from: string, to: string): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded retry of one rename
            await rename(from, to);
            return;
        } catch (error) {
            if (process.platform !== "win32" || attempt >= 10 || !TRANSIENT_RENAME.has(errnoCode(error) ?? "")) {
                throw error;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await sleep(50);
        }
    }
};

// The permission bits a written file gets: exactly those a file had (a backup put back, a file replaced), or a new
// file's, which this device's umask decides, executable where the sandbox's copy is.
export type FileMode = { readonly exact: number } | { readonly executable: boolean };

let installs = 0;

// A file put in place whole: copied into a temporary file BESIDE its target (a rename across disks is a copy, and the
// agent's state dir may be on another one), then renamed over it, so nothing ever reads it half written.
export const installFile = async (root: string, path: string, source: string, mode: FileMode): Promise<void> => {
    const target = await localTarget(root, path);
    await mkdirPlain(root, dirname(path));
    installs += 1;
    const temporary = join(dirname(target), `.${basename(target)}.intentic-${process.pid}-${installs}.tmp`);
    try {
        const handle = await open(temporary, "wx", "exact" in mode || !mode.executable ? 0o666 : 0o777);
        try {
            await pipeline(createReadStream(source), handle.createWriteStream());
        } finally {
            // allow(silent-catch): the write stream closes the handle itself once it has finished; a second close is that.
            await handle.close().catch(() => undefined);
        }
        if ("exact" in mode) {
            await chmod(temporary, mode.exact);
        }
        // Its bytes on the disk before the rename puts its name there, so a crash never leaves an empty file in its place.
        await realDurability.file(temporary);
        await localTarget(root, path);
        await renameInto(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
};

// The folders on the way to a file, made one at a time and each checked as it is reached (localTarget).
const mkdirPlain = async (root: string, relative: string): Promise<void> => {
    if (relative === "." || relative === "") {
        return;
    }
    let at = root;
    for (const part of relative.split("/")) {
        at = join(at, part);
        // oxlint-disable-next-line eslint/no-await-in-loop -- each level exists before the next is made in it
        const info = await lstat(at).catch(undefinedIfMissing);
        if (info === undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await mkdirOne(at);
        } else if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error(`${relative} is not a plain folder here`);
        }
    }
};

const mkdirOne = async (path: string): Promise<void> => {
    try {
        await mkdir(path);
    } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
            throw error;
        }
    }
};

// A file taken out of the folder, and each folder above it that this leaves empty, up to the folder itself: the
// sandbox's copy has none of them, and an empty one left here would be carried back there.
export const removeFile = async (root: string, path: string): Promise<void> => {
    await rm(await localTarget(root, path));
    const parts = path.split("/").slice(0, -1);
    while (parts.length > 0) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- innermost first, stopping at the first that holds anything
        const emptied = await rmdir(join(root, ...parts)).then(
            () => true,
            () => false,
        );
        if (!emptied) {
            return;
        }
        parts.pop();
    }
};
