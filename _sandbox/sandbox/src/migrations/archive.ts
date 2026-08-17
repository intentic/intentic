import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { extract, type Headers } from "tar-stream";

/* READING A FOREIGN HOME DIRECTORY OFF AN UPLOAD — a gzipped tar of `~/.hermes` (or wherever the source tool
 * kept house), landed as a bounded in-memory file map the adapters can be PURE over.
 *
 * In memory rather than on disk, deliberately: the archive is a credential store (an .env, an auth.json), and
 * a temp file would be a second place those bytes live, with a lifetime somebody has to remember. A held map
 * dies with the daemon process and with the DELETE route, and nothing under /work or /history ever holds the
 * raw upload. What makes the map safe to hold is that it is BOUNDED — the caps below are not tuning, they are
 * the difference between "the user's config and notes" and "their session logs and SQLite", which the plan
 * refuses anyway and which would otherwise dominate the bytes.
 *
 * Decoder failures are the caller's fault and say so (a 400 at the route), exactly restore.ts's split: gunzip
 * answers Z_DATA_ERROR for anything that is not gzip, tar-stream throws on a malformed member, and neither may
 * escape as a 500 the owner reads as "the sandbox broke". */

export class MigrationFormatError extends Error {}

export interface ForeignArchive {
    // Archive-relative, forward-slash, `./` stripped. Values are the raw bytes; adapters decode.
    readonly files: ReadonlyMap<string, Buffer>;
    // What the reader declined to hold, as path prefixes/names — merged into the plan's `refused` so the owner
    // sees the archive was read selectively rather than trusting that it all "made it".
    readonly skipped: readonly string[];
}

// Directory SEGMENTS never worth holding, wherever they sit: session transcripts, logs, the tool's own install,
// dependency trees. These are the classes both Hermes' and OpenClaw's own export tooling excludes too.
const SKIPPED_SEGMENTS = new Set([
    "sessions",
    "logs",
    "plugins",
    "mcp-tokens",
    "plans",
    "hermes-agent",
    "node_modules",
    ".git",
    "__pycache__",
    "venv",
    ".venv",
]);
// File suffixes that mean machine state, not setup — databases and their journals.
const SKIPPED_SUFFIXES = [".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".pyc"];

// A single file larger than this is not configuration. Memory files, skills and configs are kilobytes; the
// megabyte-scale entries in these homes are exactly the state the plan refuses.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;

const normalize = (name: string): string | undefined => {
    const parts = name
        .replaceAll("\\", "/")
        .split("/")
        .filter((part) => part !== "" && part !== ".");
    // An absolute path or a `..` segment is an archive trying to name something outside itself. The map is
    // keyed relatively so nothing could escape anyway — refusing keeps the skip list honest about the attempt.
    if (name.startsWith("/") || parts.includes("..")) {
        return undefined;
    }
    return parts.join("/");
};

const skipReason = (relPath: string, size: number): string | undefined => {
    const parts = relPath.split("/");
    const segment = parts.find((part) => SKIPPED_SEGMENTS.has(part));
    if (segment !== undefined) {
        return `${parts.slice(0, parts.indexOf(segment) + 1).join("/")}/`;
    }
    if (SKIPPED_SUFFIXES.some((suffix) => relPath.endsWith(suffix))) {
        return relPath;
    }
    if (size > MAX_FILE_BYTES) {
        return `${relPath} (too large to be configuration)`;
    }
    return undefined;
};

const drain = (source: Readable): Promise<void> =>
    new Promise((resolve, reject) => {
        source.on("end", resolve);
        source.on("error", reject);
        source.resume();
    });

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
            throw new MigrationFormatError(`the archive holds more than ${MAX_FILES} files — pack just the tool's home directory`);
        }
        const content = await readEntry(stream);
        remaining -= content.byteLength;
        if (remaining < 0) {
            throw new MigrationFormatError("the archive is too large — pack just the tool's home directory, without sessions or logs");
        }
        files.set(relPath, content);
    };

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>).pipe(createGunzip());
    await new Promise<void>((resolve, reject) => {
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
        const failDecode = (error: unknown): void =>
            fail(new MigrationFormatError(`the upload could not be read — it is not a gzipped tar archive (${String(error)})`));
        ex.on("entry", (header, stream, next) => {
            handleEntry(header, stream).then(() => next(), fail);
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

    return { files, skipped: [...skipped].toSorted((left, right) => left.localeCompare(right)) };
};

/* Rebase the map onto the directory that holds `anchor` — the file that proves where the tool's home starts.
 * `tar czf setup.tar.gz -C ~ .hermes` puts everything under `.hermes/`; packing from inside the directory puts
 * `config.yaml` at the root; a GUI archiver adds its own folder. All three are the same setup, and making the
 * user re-pack over a prefix would be a formality dressed up as a format. Shortest match wins so a nested
 * lookalike (a skill that ships its own `config.yaml`) cannot claim the root from the real one. */
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
