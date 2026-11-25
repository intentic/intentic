import { constants, type Stats } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { isInside } from "@intentic/base/contained";

// A regular file the daemon reads from a folder somebody else can write (an agent's checkout, the records, the turn's
// own files), asked about and read through ONE descriptor: its type, its size and, given roots, where it really is are
// all asked of the file as opened, never of its name. A name checked and then read could be swapped in between, for a
// link to a file the reader must not carry, a file far past the cap, or a pipe; through the descriptor none of that
// reaches the read. Opened without waiting, so a pipe named like a file never holds the open (and a thread of the
// daemon's file I/O with it); that changes nothing about how a regular file reads.

export interface RegularFileOptions {
    // False refuses a link at the last part of the name (for a path already resolved, which a link there would leave).
    readonly follow?: boolean;
    // Where the opened file must really be; any root is enough. Unchecked when left out.
    readonly roots?: readonly string[];
}

// `use`'s answer for the regular file at `path`, or undefined when it is not one (a directory, a pipe, a device) or lies
// outside `roots`. Failing to open it throws as open does (ENOENT for a missing file, ELOOP for a refused link).
export const withRegularFile = async <T>(
    path: string,
    { follow = true, roots }: RegularFileOptions,
    use: (handle: FileHandle, info: Stats) => Promise<T>,
): Promise<T | undefined> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW));
    try {
        const info = await handle.stat();
        if (!info.isFile()) {
            return undefined;
        }
        if (roots !== undefined) {
            const opened = await realpath(`/proc/self/fd/${String(handle.fd)}`);
            if (!roots.some((root) => isInside(root, opened))) {
                return undefined;
            }
        }
        return await use(handle, info);
    } finally {
        await handle.close();
    }
};

// The bytes of the regular file at `path` with what its descriptor said of it, or undefined as above and for one past
// `maxBytes`: asked before anything is read, and again of what was read, for a file that grew in between.
export const readRegularFile = async (
    path: string,
    { maxBytes = Number.POSITIVE_INFINITY, ...options }: RegularFileOptions & { readonly maxBytes?: number },
): Promise<{ readonly bytes: Buffer; readonly info: Stats } | undefined> =>
    await withRegularFile(path, options, async (handle, info) => {
        if (info.size > maxBytes) {
            return undefined;
        }
        const bytes = await handle.readFile();
        return bytes.length > maxBytes ? undefined : { bytes, info };
    });
