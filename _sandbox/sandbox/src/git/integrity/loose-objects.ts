import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";

// Loose objects a crash left unreadable, found by reading them rather than asking git: `cat-file -e` and
// `fsck --connectivity-only` only ask whether an object's file exists, and an all-NUL one does (measured on git 2.47:
// both pass, and the first `diff` that reads it dies on "inflate: data stream error"). Each file is inflated and hashed
// against its own name, which is the one test that cannot be fooled by a file of the right size.

// allow(silent-catch): a directory missing or gone mid-scan (a gc packing it) holds nothing left to read.
const namesIn = async (dir: string): Promise<string[]> => readdir(dir).catch((): string[] => []);

// Past this a file is only checked for a zlib header: inflating every large blob would make the scan cost what a gc does.
const INFLATE_LIMIT = 4 * 1024 * 1024;
const FANOUT = /^[0-9a-f]{2}$/;
const REST = /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/;

export interface BadObject {
    readonly sha: string;
    // Relative to the git dir: `objects/ff/5612…`, as it is filed in quarantine.
    readonly path: string;
}

// A zlib stream's two-byte header: deflate (CM 8) and a check value that makes the pair a multiple of 31.
const zlibHeader = (bytes: Buffer): boolean => bytes.length >= 2 && (bytes[0]! & 0x0f) === 8 && ((bytes[0]! << 8) | bytes[1]!) % 31 === 0;

/** Whether a loose object's bytes are the object its name says. */
export const looseObjectSound = (bytes: Buffer, sha: string): boolean => {
    if (!zlibHeader(bytes)) {
        return false;
    }
    if (bytes.length > INFLATE_LIMIT) {
        return true;
    }
    try {
        return createHash(sha.length === 40 ? "sha1" : "sha256").update(inflateSync(bytes)).digest("hex") === sha;
        // allow(silent-catch): a stream that does not inflate (truncated, zeroed past its header) is the damage this looks for.
    } catch {
        return false;
    }
};

export interface LooseScan {
    readonly scanned: number;
    readonly bad: readonly BadObject[];
    // The deadline came first: what was not read is neither vouched for nor set aside.
    readonly cut: boolean;
}

/** Reads every loose object under `commonDir`, until `deadline` (epoch ms). */
export const scanLooseObjects = async (commonDir: string, deadline: number, now: () => number = Date.now): Promise<LooseScan> => {
    const objects = join(commonDir, "objects");
    const fanouts = (await namesIn(objects)).filter((name) => FANOUT.test(name)).toSorted();
    const bad: BadObject[] = [];
    let scanned = 0;
    for (const fanout of fanouts) {
        const names = (await namesIn(join(objects, fanout))).filter((name) => REST.test(name));
        for (const name of names) {
            if (now() > deadline) {
                return { scanned, bad, cut: true };
            }
            const path = join("objects", fanout, name);
            // one read per loose object: the whole point is to look at the bytes, and a repo holds a few thousand
            // allow(silent-catch): an object packed and pruned between the listing and the read is not damage.
            const bytes = await readFile(join(commonDir, path)).catch(() => undefined);
            scanned += 1;
            if (bytes !== undefined && !looseObjectSound(bytes, `${fanout}${name}`)) {
                bad.push({ sha: `${fanout}${name}`, path });
            }
        }
    }
    return { scanned, bad, cut: false };
};

/** Where this repair sets damaged files aside: inside the git dir, outside anything git reads. */
export const quarantineDir = (commonDir: string, stamp: string): string => join(commonDir, "intentic-quarantine", stamp);

/** Moves a git-dir-relative file into the quarantine, keeping its relative path; git then reads it as absent. */
export const quarantine = async (commonDir: string, stamp: string, path: string): Promise<void> => {
    const target = join(quarantineDir(commonDir, stamp), path);
    await mkdir(dirname(target), { recursive: true });
    await rename(join(commonDir, path), target);
};
