import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import type { z } from "zod";

// A small JSON file one writer leaves for a later reader (a boot marker, a claim, a host's note on /history), read in
// one place with one policy. Every such file is advice, never the only copy of anything: so a missing file, one that
// cannot be read, one too big to be what was written, one that is not JSON and one that fails its schema all read as
// undefined, the same "nothing said" every caller already handles, and none of them throws. A marker a store owns and
// converts is opened through its document instead (store/open-document.ts).

// Every marker here is a few hundred bytes; one past this is damage or a planted file, never something to parse.
export const MARKER_MAX_BYTES = 64 * 1024;

export interface JsonMarkerOptions {
    // Larger than this reads as undefined, without the rest of the file being read.
    readonly maxBytes?: number;
}

const parsedWith = <T>(schema: z.ZodType<T>, bytes: Buffer | undefined): T | undefined => {
    if (bytes === undefined) {
        return undefined;
    }
    try {
        const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): text that is not JSON (a torn or hand-edited marker) says nothing, which is this read's answer
        return undefined;
    }
};

// The size is checked on the open file before anything is read, so a huge file costs a stat; the length is checked
// again after, for one that grew in between.
const cappedBytes = async (path: string, maxBytes: number): Promise<Buffer | undefined> => {
    const handle = await open(path, "r");
    try {
        if ((await handle.stat()).size > maxBytes) {
            return undefined;
        }
        const bytes = await handle.readFile();
        return bytes.length > maxBytes ? undefined : bytes;
    } finally {
        await handle.close();
    }
};

const cappedBytesSync = (path: string, maxBytes: number): Buffer | undefined => {
    const fd = openSync(path, "r");
    try {
        if (fstatSync(fd).size > maxBytes) {
            return undefined;
        }
        const bytes = readFileSync(fd);
        return bytes.length > maxBytes ? undefined : bytes;
    } finally {
        closeSync(fd);
    }
};

export const readJsonMarker = async <T>(path: string, schema: z.ZodType<T>, { maxBytes = MARKER_MAX_BYTES }: JsonMarkerOptions = {}): Promise<T | undefined> =>
    // allow(silent-catch): absent and unreadable both read as nothing said, the policy above
    parsedWith(schema, await cappedBytes(path, maxBytes).catch(() => undefined));

// For the boot and exit paths, which run before anything is awaited or where nothing can be.
export const readJsonMarkerSync = <T>(path: string, schema: z.ZodType<T>, { maxBytes = MARKER_MAX_BYTES }: JsonMarkerOptions = {}): T | undefined => {
    let bytes: Buffer | undefined;
    try {
        bytes = cappedBytesSync(path, maxBytes);
    } catch {
        // allow(silent-catch): absent and unreadable both read as nothing said, the policy above
        return undefined;
    }
    return parsedWith(schema, bytes);
};
