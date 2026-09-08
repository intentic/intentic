// Shared drive loop for the three tar readers (workspace upload, environment bundle, migration home dir); each supplies
// its own onEntry. Settles exactly once, destroying both streams on the first failure so a second error can't crash the
// process. A decode-error relabeler is a parameter, since only some callers promise a specific format.
import type { Readable } from "node:stream";
import type { Extract, Headers } from "tar-stream";

/**
 * Consumes and discards an entry's body so tar-stream emits the next one; used for directory markers and skipped
 * entries.
 */
export const drain = (source: Readable): Promise<void> =>
    new Promise((resolve, reject) => {
        source.on("end", resolve);
        source.on("error", reject);
        source.resume();
    });

/**
 * Pipes `source` through `ex`, handing every entry to `onEntry`, resolving when exhausted. `asDecodeError` re-labels a
 * gunzip/tar-stream failure; entry failures propagate unchanged.
 */
export const extractAll = async (
    source: Readable,
    ex: Extract,
    onEntry: (header: Headers, stream: Readable) => Promise<void>,
    asDecodeError: (error: unknown) => unknown = (error) => error,
): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            source.destroy();
            ex.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const failDecode = (error: unknown): void => fail(asDecodeError(error));
        ex.on("entry", (header, stream, next) => {
            onEntry(header, stream).then(() => next(), fail);
        });
        ex.on("finish", () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        });
        ex.on("error", failDecode);
        source.on("error", failDecode);
        source.pipe(ex);
    });
