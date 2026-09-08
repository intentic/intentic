import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { extract, type Headers } from "tar-stream";
import { ArrivalFormatError } from "../arrival-error.js";
import { drain, extractAll } from "../tar-extract.js";
import { skipReason } from "./scan-policy.js";

// Reads a gzipped tar of a foreign home directory into a bounded in-memory file map adapters can be pure over. Held in
// memory, not on disk: the archive is a credential store, and a temp file would be a second place those bytes live.
// Decoder failures are the caller's fault (400), never a 500, matching bundle-arrival.ts.

export class MigrationFormatError extends ArrivalFormatError {}

export interface ForeignArchive {
    // Archive-relative, forward-slash, `./` stripped. Values are the raw bytes; adapters decode.
    readonly files: ReadonlyMap<string, Buffer>;
    // What the reader declined, merged into the plan's `refused` so the owner sees it wasn't read wholesale.
    readonly skipped: readonly string[];
}

const MAX_FILES = 5000;

const normalize = (name: string): string | undefined => {
    const parts = name
        .replaceAll("\\", "/")
        .split("/")
        .filter((part) => part !== "" && part !== ".");
    // An absolute path or `..` is an escape attempt; refusing it keeps the skip list honest.
    if (name.startsWith("/") || parts.includes("..")) {
        return undefined;
    }
    return parts.join("/");
};


const readEntry = (source: Readable): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        source.on("data", (chunk: Buffer) => chunks.push(chunk));
        source.on("end", () => resolve(Buffer.concat(chunks)));
        source.on("error", reject);
    });

export const readForeignArchive = async (body: ReadableStream<Uint8Array>, limit: number): Promise<ForeignArchive> => {
    const ex = extract();
    const files = new Map<string, Buffer>();
    const skipped = new Set<string>();
    let remaining = limit;

    const handleEntry = async (header: Headers, stream: Readable): Promise<void> => {
        if (header.type !== "file") {
            await drain(stream);
            return;
        }
        const relPath = normalize(header.name);
        if (relPath === undefined || relPath === "") {
            skipped.add(header.name);
            await drain(stream);
            return;
        }
        const reason = skipReason(relPath, header.size ?? 0);
        if (reason !== undefined) {
            skipped.add(reason);
            await drain(stream);
            return;
        }
        if (files.size >= MAX_FILES) {
            throw new MigrationFormatError(`the archive holds more than ${MAX_FILES} files: pack just the tool's home directory`);
        }
        const content = await readEntry(stream);
        remaining -= content.byteLength;
        if (remaining < 0) {
            throw new MigrationFormatError("the archive is too large: pack just the tool's home directory, without sessions or logs");
        }
        files.set(relPath, content);
    };

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>).pipe(createGunzip());
    await extractAll(
        source,
        ex,
        handleEntry,
        (error) => new MigrationFormatError(`the upload could not be read: it is not a gzipped tar archive (${String(error)})`),
    );

    return { files, skipped: [...skipped].toSorted((left, right) => left.localeCompare(right)) };
};

// Rebases the map onto the directory holding `anchor`, so packing with -C, from inside it, or via a GUI archiver's own
// folder all read the same. Shortest match wins, so a nested lookalike can't claim the root.
export const rebaseArchive = (files: ReadonlyMap<string, Buffer>, anchor: string): ReadonlyMap<string, Buffer> | undefined => {
    const prefixes = [...files.keys()]
        .filter((path) => path === anchor || path.endsWith(`/${anchor}`))
        .map((path) => path.slice(0, path.length - anchor.length))
        .toSorted((left, right) => left.length - right.length);
    const prefix = prefixes[0];
    if (prefix === undefined) {
        return undefined;
    }
    if (prefix === "") {
        return files;
    }
    const rebased = new Map<string, Buffer>();
    for (const [path, content] of files) {
        if (path.startsWith(prefix)) {
            rebased.set(path.slice(prefix.length), content);
        }
    }
    return rebased;
};
