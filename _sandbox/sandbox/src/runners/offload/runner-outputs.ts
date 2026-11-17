import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { isTmpOutput, type RunnerFileFrame } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";

/* THE OUTPUTS AN OFFLOADED LINE HANDS BACK WHOLE (RunnerCommand `outputs`): what a build or a render made that its caller
   needs here, which the patch never carries because git ignores it (`target/debug/integra`, a directory of frames under
   /tmp). Each file goes as `file` frames before the exit: gzip members of one MiB of it each, then its size, mode and
   sha256, so the caller writes it beside its destination, checks it, and moves it in place. A file the caller already
   holds byte for byte (`have`) is said, not sent: a test binary rebuilt from unchanged sources costs one hash. */

// One frame's worth of a file before compression; with base64 and the link's own deflate, well under any frame limit.
const PIECE_BYTES = 1024 * 1024;
// Past this much in all, the rest stays on the runner and is named in the exit: a wrong glob over a target directory
// would otherwise stream tens of gigabytes through the parent.
const OUTPUTS_CEILING_BYTES = 8 * 1024 ** 3;
// A directory output is a set of files, not a tree to mirror: past this many it was the wrong directory.
const MAX_FILES = 20_000;

export interface OutputFile {
    // As the caller names it: the declared output, or a file under a declared directory joined to it.
    readonly path: string;
    readonly absolute: string;
    readonly size: number;
    readonly mode: number;
}

// Where a declared output lives on this runner: in the line's tree, or the runner's own /tmp.
const outputLocation = (tree: string, path: string): string => (isTmpOutput(path) ? path : join(tree, path));

// Every regular file under a directory, symlinks not followed (one could point anywhere on the runner).
const filesUnder = async (absolute: string, path: string, into: OutputFile[]): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (into.length >= MAX_FILES) {
            return;
        }
        const childAbsolute = join(absolute, entry.name);
        const childPath = `${path.replace(/\/+$/u, "")}/${entry.name}`;
        if (entry.isDirectory()) {
            await filesUnder(childAbsolute, childPath, into);
        } else if (entry.isFile()) {
            const info = await lstat(childAbsolute);
            into.push({ path: childPath, absolute: childAbsolute, size: info.size, mode: info.mode & 0o777 });
        }
    }
};

/** The files the declared outputs name, and the outputs the line never made. */
export const expandOutputs = async (tree: string, outputs: readonly string[]): Promise<{ files: OutputFile[]; missing: string[] }> => {
    const files: OutputFile[] = [];
    const missing: string[] = [];
    for (const path of outputs) {
        const absolute = outputLocation(tree, path);
        // allow(silent-catch): an output the line never made is exactly what `missing` reports
        const info = await lstat(absolute).catch(() => undefined);
        if (info === undefined) {
            missing.push(path);
        } else if (info.isDirectory()) {
            await filesUnder(absolute, path, files);
        } else if (info.isFile()) {
            files.push({ path, absolute, size: info.size, mode: info.mode & 0o777 });
        } else {
            missing.push(path);
        }
    }
    return { files, missing };
};

// A read stream opened without an encoding yields Buffers; Node types its iterator `any`, so this narrows rather than casts.
const asBytes = (chunk: Buffer | string): Buffer => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

const sha256Of = async (absolute: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolute, { highWaterMark: PIECE_BYTES })) {
        hash.update(asBytes(chunk));
    }
    return hash.digest("hex");
};

/**
 * The frames that hand `files` back, read lazily so a slow link holds the runner's reading rather than its memory.
 * Returns the outputs left behind for the ceiling. A file that cannot be read mid-way ends without `end`, which the
 * caller reads as not delivered.
 */
export async function* outputFrames(
    files: readonly OutputFile[],
    have: Readonly<Record<string, string>>,
    signal: AbortSignal,
    ceiling: number = OUTPUTS_CEILING_BYTES,
): AsyncGenerator<RunnerFileFrame, string[]> {
    const tooBig: string[] = [];
    let sent = 0;
    for (const file of files) {
        if (signal.aborted) {
            break;
        }
        const known = have[file.path];
        if (known !== undefined && (await sha256Of(file.absolute)) === known) {
            yield { kind: "file", path: file.path, same: true };
            continue;
        }
        if (sent + file.size > ceiling) {
            tooBig.push(file.path);
            continue;
        }
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of createReadStream(file.absolute, { highWaterMark: PIECE_BYTES })) {
            if (signal.aborted) {
                return tooBig;
            }
            const piece = asBytes(chunk);
            hash.update(piece);
            size += piece.length;
            yield { kind: "file", path: file.path, data: gzipSync(piece, { level: 1 }).toString("base64") };
        }
        sent += size;
        yield { kind: "file", path: file.path, end: { size, mode: file.mode, sha256: hash.digest("hex") } };
    }
    return tooBig;
}
