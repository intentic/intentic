/* HOW A TAR ARRIVES, driven once for the three readers that take one.
 *
 * A workspace upload (workspace/files/workspace-archive.ts), an environment bundle
 * (portability/bundle-arrival.ts) and a migration's home directory (migrations/archive.ts) each walk a
 * `tar-stream` extract and each decides something different about the entries — that is their business, and it
 * stays in their files as the `onEntry` they pass. What was three copies is the DRIVING of that walk, which is
 * the same in all three and is the part that is easy to get subtly wrong.
 *
 * SETTLE EXACTLY ONCE, and tear down without re-emitting. Two streams are live (the source and the extractor)
 * and either can fail after the other already has; `destroy(err)` on the far end would surface a second,
 * unhandled `error` after the promise has been rejected, which crashes the process rather than answering the
 * request. So: a `settled` latch, a plain `destroy()` on both, and the FIRST cause is the one reported.
 *
 * WHOSE FAULT A DECODER ERROR IS, is the one thing the three do differ on, so it is a parameter. gunzip answers
 * Z_DATA_ERROR for anything that is not gzip and tar-stream throws on a truncated member: for the two readers
 * that promise a specific format, that means "this upload is not one" — a 400 in the caller's own words rather
 * than an unhandled throw the route turns into a 500. A plain workspace upload makes no such promise and lets
 * the error stand. Errors out of `onEntry` are never re-labelled by either: a full disk, a permission error or
 * a size cap belong to the sandbox, and blaming the archive for them would send the owner to the wrong file.
 *
 * It lives in a leaf module at the root of src/ for the reason arrival-error.ts states: the three callers sit
 * in three directories, and inside any one of them this would be a value edge from another subsystem
 * (_tools/checks/daemon-boundaries.mjs). */
import type { Readable } from "node:stream";
import type { Extract, Headers } from "tar-stream";

/** Fully consume (and discard) an entry's body, so tar-stream will emit the next entry. Used for directory
 *  markers and for skipped entries, which carry no bytes any reader keeps. */
export const drain = (source: Readable): Promise<void> =>
    new Promise((resolve, reject) => {
        source.on("end", resolve);
        source.on("error", reject);
        source.resume();
    });

/** Pipe `source` through `ex`, handing every entry to `onEntry`, and resolve when the archive is exhausted.
 *  `asDecodeError` re-labels a failure of gunzip or tar-stream itself; entry failures propagate unchanged. */
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
