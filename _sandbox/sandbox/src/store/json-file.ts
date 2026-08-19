import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ManifestProblem, recordManifestProblems } from "./manifest-problems.js";

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
 * DOWNGRADES. `parse` rejecting is not only damage — it is also what a build reading state written by a NEWER
 * build sees, which is the ordinary aftermath of `ic sandbox rollback`. Reading the fallback is right; letting
 * the next `update` write that fallback over the only copy of the newer bytes is the quiet half of the loss:
 * the rolled-back daemon "resets" the store, and rolling forward again finds nothing to recover. So an update
 * about to replace content that EXISTS but could not be read sets the original aside first (<name>.corrupt,
 * the agents-store convention). Absent is not unreadable — a file that never existed has nothing to protect.
 *
 * SILENCE. Falling back keeps the daemon up, and for a long time it also ended the story: a settings file with
 * one bad character read as every setting at its default, and nothing said so. The fallback is still right —
 * refusing to boot over a manifest would be worse — but it is now also REPORTED, on every read, to a registry a
 * route hands to the browser (manifest-problems.ts). The read path is the only place that can do this: it is
 * the one moment the difference between "absent" and "there but unreadable" exists.
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
    /* Whatever `JSON.parse` produced, or `undefined` when the file was absent or not JSON at all. Returning
     * undefined selects the fallback. Typically a Zod `safeParse`, but a store that must keep unreadable
     * entries rather than drop them (capabilities) validates per entry in here instead.
     *
     * `report` is for what a SUCCESSFUL parse still wants to say — a key the schema does not declare, an entry
     * it had to skip. Optional to take, so the stores with nothing to add keep their one-liner unchanged; what
     * is reported rides the same self-clearing channel as an unreadable file (manifest-problems.ts). */
    readonly parse: (raw: unknown, report: (problem: ManifestProblem) => void) => T | undefined;
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
     * read as a write to `.intentic/config/settings.json` itself and bill every browser an extra refetch for a file
     * that is still mid-swap. A leading dot cannot prefix-match the target, and hides the temp besides. */
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(value, undefined, 2)}\n`, mode === undefined ? undefined : { mode });
    await rename(tempPath, path);
};

export const jsonFile = <T>(path: string, { parse, fallback, mode }: JsonFileOptions<T>): JsonFile<T> => {
    // The file's value, and — for `update` — whether that answer stands in for CONTENT THAT EXISTS but could
    // not be read (not JSON, or rejected by `parse`). Only `update` acts on the distinction; a read's answer
    // is the same either way.
    const readState = async (): Promise<{ value: T; unreadable: boolean }> => {
        /* Recorded on EVERY read, including the healthy ones and the ABSENT ones, which is what makes the
         * registry self-clearing: a read that finds nothing wrong erases the last read's complaint.
         *
         * Absent counts as nothing wrong — a workspace that has never written a manifest is the ordinary
         * first-boot state, not a fault — and it has to go through the same recording step rather than return
         * early, which is the bug that used to make DELETING a broken file the one repair that did not work. The
         * complaint outlived the file it was about and sat on screen until the daemon restarted, which is the
         * exact outcome the replace-per-file design was chosen to rule out. */
        const problems: ManifestProblem[] = [];
        const done = <R extends { value: T; unreadable: boolean }>(state: R): R => {
            recordManifestProblems(path, problems);
            return state;
        };
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch {
            return done({ value: fallback(), unreadable: false });
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            problems.push({ kind: "unreadable", detail: "the file is not valid JSON" });
            return done({ value: fallback(), unreadable: true });
        }
        const parsed = parse(raw, (problem) => problems.push(problem));
        if (parsed === undefined) {
            // The schema rejected it whole. Everything the file says is being ignored in favour of defaults,
            // which is the one outcome a user has no other way to notice.
            problems.push({ kind: "unreadable", detail: "the file does not match what this build expects" });
            return done({ value: fallback(), unreadable: true });
        }
        return done({ value: parsed, unreadable: false });
    };

    // Chained rather than a lock object: `update` is the only writer, so the tail of this promise IS the queue.
    // It never rejects — a failed update settles the chain so the next one still runs — while the caller of
    // that update still sees its own error.
    let queue: Promise<unknown> = Promise.resolve();

    return {
        read: async () => (await readState()).value,
        update: (change) => {
            const next = queue.then(async () => {
                const { value: current, unreadable } = await readState();
                const updated = change(current);
                if (updated !== current) {
                    // What this store could not read, it must not overwrite (the DOWNGRADES rule above): the
                    // bytes move aside — recoverable by hand, or by the newer build that wrote them once a
                    // rollback rolls forward again — and only then does fallback-derived state take the name.
                    if (unreadable) {
                        await rename(path, `${path}.corrupt`).catch(() => undefined);
                    }
                    await writeJsonFile(path, updated, mode);
                }
                return updated;
            });
            queue = next.catch(() => undefined);
            return next;
        },
    };
};
