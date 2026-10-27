import { writeFile } from "../../fixture/workspace";
import { bytesOf, holdBytes, releaseBytes } from "./bytes";
import { makeFolder, noteWritten } from "./edits";
import { readTar } from "./tar";

// What a drop writes: one file per POST /workspace/upload (a big one in parts, each at its `offset`), or a whole tree
// as one tar through POST /workspace/upload-archive. Text lands as text, so it opens, searches and diffs like the
// recording's own files; anything else keeps its bytes, so it downloads and plays as what was dropped.

const strict = new TextDecoder(`utf-8`, { fatal: true });

// Text if it decodes and carries no NUL, the same sniff a viewer makes before it opens a file as code.
const store = (path: string, bytes: Uint8Array<ArrayBuffer>): void => {
    if (!bytes.includes(0)) {
        try {
            writeFile(path, strict.decode(bytes));
            releaseBytes(path);
            return;
        } catch {
            // allow(silent-catch): not UTF-8, so it is kept as the bytes it is, below.
        }
    }
    holdBytes(path, bytes);
};

// A part after the first goes on at its offset, behind the bytes already written.
const joined = (path: string, offset: number, part: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
    if (offset === 0) {
        return part;
    }
    const before = (bytesOf(path) ?? new Uint8Array()).subarray(0, offset);
    const whole = new Uint8Array(offset + part.length);
    whole.set(before);
    whole.set(part, offset);
    return whole;
};

/** POST /workspace/upload: one file, or one part of one. */
export const landUpload = (path: string, offset: number, part: Uint8Array<ArrayBuffer>): void => {
    store(path, joined(path, offset, part));
    noteWritten([path]);
};

/** POST /workspace/upload-archive: every entry of the tar where its own path says. */
export const landArchive = (archive: Uint8Array<ArrayBuffer>): number => {
    const entries = readTar(archive);
    for (const entry of entries) {
        if (entry.type === `dir`) {
            makeFolder(entry.path);
        } else {
            store(entry.path, entry.bytes);
        }
    }
    noteWritten(entries.filter((entry) => entry.type === `file`).map((entry) => entry.path));
    return entries.length;
};
