// A turbo cache directory as turbo's own filesystem cache lays it out: `<hash>.tar.zst` beside `<hash>-meta.json`. The
// meta file is what turbo looks for first (an entry without one is a miss); the `-manifest.json` turbo writes beside
// them is optional, and turbo writes it back itself on the first hit, so this module never does.
//
// Writes go through a temporary name in the same directory and a rename, tarball first and meta last, so a reader on
// another runner sees a whole entry or none: /ci-cache/turbo is shared by every job on the fleet host while they run.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Turbo's task hashes are 16 hex digits; the range leaves room for a longer one without admitting a path.
export const HASH = /^[0-9a-f]{16,64}$/;

const filesOf = (dir, hash) => ({ tar: join(dir, `${hash}.tar.zst`), meta: join(dir, `${hash}-meta.json`) });

/** Whether `dir` holds a whole entry for `hash`. */
export const hasEntry = (dir, hash) => {
    const { tar, meta } = filesOf(dir, hash);
    return existsSync(meta) && existsSync(tar);
};

/** `{ body, durationMs }` for a whole entry, or undefined. */
export const readEntry = (dir, hash) => {
    if (!HASH.test(hash) || !hasEntry(dir, hash)) {
        return undefined;
    }
    const { tar, meta } = filesOf(dir, hash);
    try {
        const duration = Number(JSON.parse(readFileSync(meta, "utf8")).duration);
        return { body: readFileSync(tar), durationMs: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0 };
    } catch {
        // allow(silent-catch): an entry pruned or half-written between the check and the read is a miss, as turbo reads it.
        return undefined;
    }
};

const writeAtomically = (path, dir, bytes) => {
    const temporary = join(dir, `.tmp-${randomBytes(6).toString("hex")}-${path.slice(dir.length + 1)}`);
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
};

/** Writes one entry, whole or not at all as far as a reader can tell. */
export const writeEntry = (dir, hash, body, durationMs) => {
    if (!HASH.test(hash)) {
        throw new Error(`not a turbo task hash: ${hash}`);
    }
    mkdirSync(dir, { recursive: true });
    const { tar, meta } = filesOf(dir, hash);
    writeAtomically(tar, dir, body);
    // `sha` and `dirty_hash` name the commit a local run happened on; an uploaded entry has none to give.
    writeAtomically(meta, dir, JSON.stringify({ hash, duration: Math.max(0, Math.round(durationMs)), sha: null, dirty_hash: null }));
};

/** Removes entries untouched for `maxAgeMs`, and temporaries a crashed write left for an hour. Returns how many files. */
export const prune = (dir, maxAgeMs, now = Date.now()) => {
    if (!existsSync(dir)) {
        return 0;
    }
    let removed = 0;
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const age = now - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? now);
        if (age > (name.startsWith(".tmp-") ? 60 * 60 * 1000 : maxAgeMs)) {
            rmSync(path, { force: true });
            removed += 1;
        }
    }
    return removed;
};
