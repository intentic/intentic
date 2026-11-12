import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { chown, link, lstat, open, readdir, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { keyedLock } from "@intentic/base/async";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { stagingOf, syncDirectory } from "@intentic/base/fs";

/* A CLAUDE SESSION KEPT COMPRESSED WHILE NOBODY RESUMES IT, AND WHOLE AGAIN BEFORE ANYONE READS IT (2026-11-12). The
   cold-session sweep (cold-sessions.ts) replaces a session's transcript `projects/<project>/<id>.jsonl`, and its
   subagents' `projects/<project>/<id>/subagents/agent-*.jsonl`, with `<file>.zst` beside each. Claude Code and the SDK
   read only the plain names, so every daemon reader of a session calls thawClaudeSession with its id first: the files
   come back byte for byte, under their own mode and mtime, before the reader opens them. Both directions take one lock
   per session id, and a thaw notes the id as wanted before it waits on that lock, so a freeze already under way gives
   up rather than remove a file a turn is about to resume. A name found both plain and compressed (a freeze or a thaw
   stopped between its two steps, or a session the CLI started over beside its compressed copy) is left as it is by
   both: the plain file is the one the CLI writes, and nothing proves the compressed one holds nothing more. */

export const FROZEN = ".zst";

// A session id is the CLI's own UUID; anything else is refused rather than joined into a path.
const SESSION_ID = /^[\w-]+$/u;

// The level the conversations' own records use for text (record-log.ts); the checksum makes a torn file fail its thaw
// rather than come back short.
const ZSTD_PARAMS = { [constants.ZSTD_c_compressionLevel]: 6, [constants.ZSTD_c_checksumFlag]: 1 };

// One per session id, whatever store holds it: ids are the CLI's UUIDs, and a store reached by two spellings (the home
// link, the state path) is still one session.
const sessionLock = keyedLock<string>();

// When a reader in this process last asked for each session (thawClaudeSession), whether or not it was compressed.
const wanted = new Map<string, number>();

export const wantedAt = (sessionId: string): number | undefined => wanted.get(sessionId);

// Forgets what was wanted before `before`, which no longer keeps the sweep off a session; the map stays as small as
// the sessions read within that while.
export const forgetWantedBefore = (before: number): void => {
    for (const [sessionId, at] of wanted) {
        if (at < before) {
            wanted.delete(sessionId);
        }
    }
};

const present = async (path: string): Promise<boolean> => (await lstat(path).catch(undefinedIfMissing)) !== undefined;

const namesIn = async (dir: string): Promise<string[]> => (await readdir(dir).catch(undefinedIfMissing)) ?? [];

// Its bytes on the disk before a name is linked to it: the name is only as durable as what it names.
const flush = async (path: string): Promise<void> => {
    const handle = await open(path, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
};

// Mode, owner and times of `like` onto `path`: the CLI writes its transcripts 0600, and the SDK's session list sorts by
// mtime. A chown only where the owner differs, which only root may do; anyone else is refused, and the caller gives up.
const keepAttributes = async (path: string, like: Stats): Promise<void> => {
    const handle = await open(path, "r");
    try {
        await handle.chmod(like.mode & 0o7777);
    } finally {
        await handle.close();
    }
    if (like.uid !== process.getuid?.() || like.gid !== process.getgid?.()) {
        await chown(path, like.uid, like.gid);
    }
    // In seconds with their fraction: a Date would round the CLI's nanosecond mtimes to the millisecond.
    await utimes(path, like.atimeMs / 1000, like.mtimeMs / 1000);
};

interface Digest {
    readonly bytes: number;
    readonly sha256: string;
}

// A pass-through that hashes what flows through it, so a freeze checks its copy against the bytes it actually read.
const hashing = () => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            bytes += chunk.length;
            done(undefined, chunk);
        },
    });
    return { stream, digest: (): Digest => ({ bytes, sha256: hash.digest("hex") }) };
};

// What a compressed file decompresses to, hashed a chunk at a time: a transcript can run to hundreds of megabytes.
const digestOfFrozen = async (path: string): Promise<Digest> => {
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
        createReadStream(path),
        createZstdDecompress(),
        new Writable({
            write(chunk: Buffer, _encoding, done) {
                hash.update(chunk);
                bytes += chunk.length;
                done();
            },
        }),
    );
    return { bytes, sha256: hash.digest("hex") };
};

// The same file, untouched since `seen`: one write, one replace or one touch moves at least one of these.
const unchanged = (seen: Stats, now: Stats): boolean =>
    now.isFile() && now.ino === seen.ino && now.size === seen.size && now.mtimeMs === seen.mtimeMs;

// One file back from `<path>.zst`, unless its plain name is taken already. Answers whether it wrote one.
const thawFile = async (path: string): Promise<boolean> => {
    const frozen = `${path}${FROZEN}`;
    const packed = await lstat(frozen).catch(undefinedIfMissing);
    if (packed === undefined || !packed.isFile() || (await present(path))) {
        return false;
    }
    const staging = stagingOf(path);
    try {
        await pipeline(createReadStream(frozen), createZstdDecompress(), createWriteStream(staging, { flags: "wx", mode: 0o600 }));
        await flush(staging);
        // The freeze kept the plain file's own mode, owner and times on the compressed one.
        await keepAttributes(staging, packed);
        // A link, never a rename: a plain file that appeared meanwhile is never replaced (EEXIST fails this thaw).
        await link(staging, path);
    } finally {
        await rm(staging, { force: true });
    }
    await syncDirectory(dirname(path));
    await rm(frozen, { force: true });
    await syncDirectory(dirname(path));
    return true;
};

export interface Thawed {
    // Files brought back.
    readonly thawed: number;
    // Files that could not be, with why: their compressed copy is left where it was, and the reader finds no session.
    readonly failed: readonly { readonly path: string; readonly error: string }[];
}

/**
 * Brings back whatever of one session the cold-session sweep compressed, in whichever project of `store` the CLI filed
 * it: its transcript and its subagents' records. Every daemon reader of a Claude session calls this before it opens
 * one, and a turn before the CLI resumes it; a no-op for a session nothing compressed. Notes the session as wanted
 * either way, which keeps the sweep off it. Never throws: a file that cannot come back stays compressed, and its
 * reader meets a session the store does not hold, which every reader already answers (a turn opens a fresh session
 * seeded from the record).
 */
export const thawClaudeSession = async (store: string, sessionId: string): Promise<Thawed> => {
    if (!SESSION_ID.test(sessionId)) {
        return { thawed: 0, failed: [] };
    }
    // Before the lock: a freeze holding it reads this right before it would remove a plain file.
    wanted.set(sessionId, Date.now());
    return sessionLock(sessionId, async () => {
        const projects = join(store, "projects");
        const failed: { path: string; error: string }[] = [];
        let thawed = 0;
        const one = async (path: string): Promise<void> => {
            try {
                thawed += (await thawFile(path)) ? 1 : 0;
            } catch (error) {
                failed.push({ path, error: errorMessage(error) });
            }
        };
        // A folder that cannot be listed is said with the rest, and holds nothing this thaw can bring back.
        const listed = async (dir: string): Promise<string[]> => {
            try {
                return await namesIn(dir);
            } catch (error) {
                failed.push({ path: dir, error: errorMessage(error) });
                return [];
            }
        };
        await Promise.all(
            (await listed(projects)).map(async (project) => {
                await one(join(projects, project, `${sessionId}.jsonl`));
                const subagents = join(projects, project, sessionId, "subagents");
                for (const name of (await listed(subagents)).filter((entry) => entry.endsWith(`.jsonl${FROZEN}`))) {
                    // one file at a time: a session's subagents rarely number more than a handful
                    await one(join(subagents, name.slice(0, -FROZEN.length)));
                }
            }),
        );
        return { thawed, failed };
    });
};

/** A plain file the sweep judged cold, as it found it. */
export interface ColdFile {
    readonly path: string;
    readonly seen: Stats;
}

// Compresses one cold file beside itself, then removes it. Gives up, leaving the plain file as it was, the moment
// anything is in doubt: a compressed copy already sits there, the copy does not decompress to the bytes read, the file
// changed or was replaced since it was judged, or a reader wanted the session at `wantedSince` or later. Answers the
// compressed size, or undefined when it gave up.
const freezeFile = async (file: ColdFile, sessionId: string, wantedSince: number): Promise<number | undefined> => {
    const { path, seen } = file;
    const frozen = `${path}${FROZEN}`;
    if (await present(frozen)) {
        return undefined;
    }
    const staging = stagingOf(frozen);
    try {
        const read = hashing();
        await pipeline(createReadStream(path), read.stream, createZstdCompress({ params: ZSTD_PARAMS }), createWriteStream(staging, { flags: "wx", mode: 0o600 }));
        await flush(staging);
        const before = read.digest();
        const after = await digestOfFrozen(staging);
        if (before.bytes !== seen.size || after.bytes !== before.bytes || after.sha256 !== before.sha256) {
            return undefined;
        }
        await keepAttributes(staging, seen);
        const packed = await lstat(staging);
        const now = await lstat(path).catch(undefinedIfMissing);
        if (now === undefined || !unchanged(seen, now) || (wanted.get(sessionId) ?? 0) >= wantedSince) {
            return undefined;
        }
        // A link, never a rename: a compressed copy that appeared meanwhile is never replaced (EEXIST fails the freeze).
        await link(staging, frozen);
        await syncDirectory(dirname(path));
        await rm(path);
        await syncDirectory(dirname(path));
        return packed.size;
    } finally {
        await rm(staging, { force: true });
    }
};

export interface Frozen {
    readonly files: number;
    // Plain bytes compressed, and what they take now.
    readonly bytesIn: number;
    readonly bytesOut: number;
}

/**
 * Compresses one session's cold files under its lock, in the order given, stopping at the first in doubt: what is left
 * plain stays readable, and a thaw looks for every compressed file of the session whichever were done. A reader that
 * asked for the session at `wantedSince` or later keeps every file not yet done plain: the sweep passes the start of the
 * week it judged by, so a reader asking at any moment after it judged wins, even one whose thaw found nothing to do and
 * has already handed the file to the CLI. A failure to write throws, after the plain file it was compressing is left
 * untouched.
 */
export const freezeSession = async (sessionId: string, files: readonly ColdFile[], wantedSince: number): Promise<Frozen> =>
    sessionLock(sessionId, async () => {
        let done = { files: 0, bytesIn: 0, bytesOut: 0 };
        for (const file of files) {
            const packed = (wanted.get(sessionId) ?? 0) >= wantedSince ? undefined : await freezeFile(file, sessionId, wantedSince);
            if (packed === undefined) {
                break;
            }
            done = { files: done.files + 1, bytesIn: done.bytesIn + file.seen.size, bytesOut: done.bytesOut + packed };
        }
        return done;
    });
