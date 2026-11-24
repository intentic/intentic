import { stat } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { openLog, readFrame } from "./record-log.js";
import { blobNamesIn } from "./record-rows.js";

// The blob names each record holds, kept between blob sweeps. A sweep reads every record in the sandbox, and readFrame
// decompresses on the event loop, so each sweep cost ~1.9 GB of zstd text (5,331 records, 2026-11-23). It ran on every
// purge of a recorded conversation and again ten minutes later. Most records are at rest, so a record whose file is
// unchanged since the last sweep (the same inode, size and mtime) is answered from here and not read again.
//
// The stat is taken before the read. A write that lands between the two leaves the read newer than its stamp, so the
// next sweep finds the stamp changed and reads the record again. A stale entry can only keep a blob, never drop one, and
// a write's own blobs are pinned and named by the record for the sweep that is running (transcript-record.ts).

interface Known {
    readonly stamp: string;
    readonly names: readonly string[];
}

export interface RecordBlobNames {
    // The blob names in the record at `path`, none for a file that is not there.
    readonly namesOf: (path: string) => Promise<readonly string[]>;
    // Forgets every record but these: what one sweep found, so a record that is gone no longer holds a place here.
    readonly keepOnly: (paths: ReadonlySet<string>) => void;
}

export const recordBlobNames = (): RecordBlobNames => {
    const known = new Map<string, Known>();
    return {
        namesOf: async (path) => {
            const info = await stat(path, { bigint: true }).catch(undefinedIfMissing);
            if (info === undefined) {
                known.delete(path);
                return [];
            }
            const stamp = `${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
            const held = known.get(path);
            if (held?.stamp === stamp) {
                return held.names;
            }
            const names = new Set<string>();
            // One frame at a time, so a sweep holds one decoded frame and never a whole record.
            for (const frame of (await openLog(path))?.frames ?? []) {
                for (const line of await readFrame(path, frame)) {
                    for (const hash of blobNamesIn(line)) {
                        names.add(hash);
                    }
                }
            }
            const found = [...names];
            known.set(path, { stamp, names: found });
            return found;
        },
        keepOnly: (paths) => {
            for (const path of [...known.keys()].filter((held) => !paths.has(held))) {
                known.delete(path);
            }
        },
    };
};
