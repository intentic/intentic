import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/* The substrate under every `*-store.ts` in the daemon: one JSON file on disk, read through a schema and
 * written whole. Each store used to hand-roll this cycle — try/readFile/JSON.parse/safeParse/fallback on the
 * way in, mkdir/writeFile on the way out — nineteen times, and the copies disagreed on the two things that
 * decide whether the file survives being written to:
 *
 * ATOMICITY. A bare `writeFile` truncates first and fills after, so any reader landing in that window gets
 * half a file. Every store's read path treats unparseable content as "absent" and falls back — which is right
 * for a file that was never written and catastrophic for one being written right now: a concurrent read of
 * capabilities.json returned `[]`, and `[]` there means every MCP server, connector and SSH entry in the
 * sandbox is inactive. Writing to a sibling temp file and `rename`-ing it over the target closes that window
 * (rename is atomic within a filesystem, and the temp is in the target's own directory to guarantee that):
 * a reader sees either the whole previous file or the whole next one, never a seam.
 *
 * LOST UPDATES. Nearly every mutation here is read-modify-write with an `await` in the middle, so two
 * overlapping ones both read the old state and the second's write erases the first's entry. `update` runs the
 * change function inside a per-file promise queue, which is the whole concurrency story: these files are
 * kilobytes and their writes are user-gesture rare, so serializing them costs nothing worth measuring.
 *
 * ponytail: the queue is per file OBJECT, so it orders this daemon's own handlers and nothing else. The agent
 *           can write /work/.intentic files with its own tools, and a write of its that lands between our read
 *           and our rename is still lost. Atomicity means it loses a whole update rather than corrupting the
 *           file; ordering the two writers would need a real lockfile, which nothing has yet needed. */

export interface JsonFile<T> {
    // The file's contents, or the fallback when it is absent, unreadable, or fails the schema. Not serialized
    // against writes — it doesn't need to be, because a write is never observable half-done.
    readonly read: () => Promise<T>;
    /* Read, change, write — serialized against every other update of this file, and returning what was
     * written so a read-or-init (mint a secret on first use, generate a keypair once) is one call.
     *
     * Returning the current value UNCHANGED (by reference) skips the write, which is what makes read-or-init
     * free on the overwhelmingly common already-initialized path. */
    readonly update: (change: (current: T) => T) => Promise<T>;
}

export interface JsonFileOptions<T> {
    // Whatever `JSON.parse` produced, or `undefined` when the file was absent or not JSON at all. Returning
    // undefined selects the fallback. Typically a Zod `safeParse`, but a store that must keep unreadable
    // entries rather than drop them (capabilities) validates per entry in here instead.
    readonly parse: (raw: unknown) => T | undefined;
    // What an absent, unreadable or rejected file reads as. A function because the value may be mutable
    // (an array a caller then filters) and callers must never share one instance.
    readonly fallback: () => T;
    // File mode for the write, for the files carrying a secret (ci.json's webhook secret, push.json's VAPID
    // private key). Absent leaves it to the process umask, like every other manifest.
    readonly mode?: number;
}

/* One whole JSON file, written where no reader can catch it half-done — the ATOMICITY half above, on its own
 * because two callers need it without the rest. `jsonFile` is one; the other is a store that must own its read
 * path (agents.json sets an unparseable roster aside rather than reading it as an empty fleet, which no
 * `parse`/`fallback` pair can express) and would otherwise hand-roll this cycle beside it. */
export const writeJsonFile = async (path: string, value: unknown, mode?: number): Promise<void> => {
    /* Sibling of the target so the rename never crosses a filesystem (rename is only atomic within one), and
     * pid-tagged so a second daemon on the same volume — a dev sandbox pointed at the same /history — can't
     * land in the middle of ours.
     *
     * The tag goes in FRONT of the name, not after it. The watcher's manifest→query table (sandbox-contract's
     * workspace-state.ts) matches changed paths by PREFIX, so a trailing-tag temp of `settings.json` would
     * read as a write to `.intentic/settings.json` itself and bill every browser an extra refetch for a file
     * that is still mid-swap. A leading dot cannot prefix-match the target, and hides the temp besides. */
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(value, undefined, 2)}\n`, mode === undefined ? undefined : { mode });
    await rename(tempPath, path);
};

export const jsonFile = <T>(path: string, { parse, fallback, mode }: JsonFileOptions<T>): JsonFile<T> => {
    const read = async (): Promise<T> => {
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(path, "utf8"));
        } catch {
            return fallback();
        }
        return parse(raw) ?? fallback();
    };

    // Chained rather than a lock object: `update` is the only writer, so the tail of this promise IS the queue.
    // It never rejects — a failed update settles the chain so the next one still runs — while the caller of
    // that update still sees its own error.
    let queue: Promise<unknown> = Promise.resolve();

    return {
        read,
        update: (change) => {
            const next = queue.then(async () => {
                const current = await read();
                const updated = change(current);
                if (updated !== current) {
                    await writeJsonFile(path, updated, mode);
                }
                return updated;
            });
            queue = next.catch(() => undefined);
            return next;
        },
    };
};
