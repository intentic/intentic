import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type http from "node:http";
import { dirname, extname, join } from "node:path";
import { type Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGzip } from "node:zlib";
import { renameOver, stagingOf } from "@intentic/base/fs";
import { errnoCode } from "@intentic/base/errors";
import { isSafeRelative } from "./bundle.js";

// The editor's static files, served from a verified bundle or this extension's own page build. Every URL carries the
// version of what it names (the pin id, the page's content hash), so a response is cacheable for good. They cross the
// preview tunnel compressed: a gzip copy of each compressible file is made on first request and kept beside the tree,
// and the converter's brotli file goes out as brotli to a browser that takes it and decoded to one that does not.

const TYPES = new Map([
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".ico", "image/x-icon"],
    [".webp", "image/webp"],
    [".woff", "font/woff"],
    [".woff2", "font/woff2"],
    [".ttf", "font/ttf"],
    [".otf", "font/otf"],
    [".wasm", "application/wasm"],
    [".txt", "text/plain; charset=utf-8"],
    [".md", "text/plain; charset=utf-8"],
    [".xml", "application/xml"],
]);

// Worth compressing: text, the WebAssembly modules and data tables, and the font catalog's extensionless files.
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg", ".wasm", ".txt", ".md", ".xml", ".bin", ".map", ".ttf", ".otf", ""]);
const MIN_COMPRESS_BYTES = 1024;

export interface StaticRoot {
    readonly dir: string;
    // Where gzip copies are kept, by relative path; undefined compresses on every request (a small, read-only tree).
    readonly gzipCache: string | undefined;
}

const accepts = (req: http.IncomingMessage, encoding: string): boolean =>
    String(req.headers["accept-encoding"] ?? "")
        .split(",")
        .some((part) => part.trim().split(";")[0]?.trim() === encoding);

const headersFor = (relative: string, type: string | undefined): http.OutgoingHttpHeaders => ({
    "content-type": type ?? TYPES.get(extname(relative).toLowerCase()) ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
});

// Makes the gzip copy of `file` at `copy` once, however many requests ask for it at the same time.
const compressing = new Map<string, Promise<void>>();
const gzipCopy = (file: string, copy: string): Promise<void> => {
    const existing = compressing.get(copy);
    if (existing !== undefined) {
        return existing;
    }
    const made = (async () => {
        try {
            await stat(copy);
            return;
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }
        await mkdir(dirname(copy), { recursive: true });
        // Streamed, so a large asset is never held whole; staged beside the copy and renamed over it, so a reader never
        // serves half of one.
        const staging = stagingOf(copy);
        try {
            await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(staging));
            await renameOver(staging, copy);
        } finally {
            // Already gone after the rename; after a failure, a partial copy nothing would ever reuse.
            await rm(staging, { force: true });
        }
    })().finally(() => compressing.delete(copy));
    compressing.set(copy, made);
    return made;
};

// Whether `relative` goes out gzip-compressed to a browser that takes it, at `size` bytes.
const compressible = (relative: string, size: number): boolean => COMPRESSIBLE.has(extname(relative).toLowerCase()) && size >= MIN_COMPRESS_BYTES;

// Reads `path` to its end and lets the bytes go.
const readThrough = (path: string): Promise<void> =>
    pipeline(
        createReadStream(path),
        new Writable({
            write: (_chunk, _encoding, done) => done(),
        }),
    );

// Does for `relatives` under `root`, one file at a time, what a first request for each does, so that the first document
// opened does not wait for it: the gzip copy of a compressible file made, and the file a response would send read once.
// On Windows that read is when the real-time scanner looks at a file it has not seen (since its last signature update),
// which for the editor's largest scripts was seconds each, on the first open's critical path. A file that is not there,
// or fails, is passed over: this only moves work earlier. Answers how many it read.
export const warmStatic = async (root: StaticRoot, relatives: readonly string[]): Promise<number> => {
    let warmed = 0;
    for (const relative of relatives) {
        if (!isSafeRelative(relative)) {
            continue;
        }
        const file = join(root.dir, relative);
        try {
            const { size } = await stat(file);
            if (root.gzipCache !== undefined && !relative.endsWith(".br") && compressible(relative, size)) {
                const copy = join(root.gzipCache, `${relative}.gz`);
                await gzipCopy(file, copy);
                await readThrough(copy);
            } else {
                await readThrough(file);
            }
            warmed += 1;
        } catch {
            // allow(silent-catch): a file this could not warm is served the usual way on its first request.
        }
    }
    return warmed;
};

// The file and what it passes through on the way out, opened only for a request that wants a body.
type Body = () => [Readable, ...Transform[]];

const send = async (req: http.IncomingMessage, res: http.ServerResponse, headers: http.OutgoingHttpHeaders, body: Body): Promise<void> => {
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
        res.end();
        return;
    }
    await pipeline([...body(), res]);
};

// Answers `relative` under `root`: 404 for anything that is not a file inside it. Resolves once the response is sent;
// a client that goes away midway rejects, which the caller treats as the end of that request.
export const serveStatic = async (req: http.IncomingMessage, res: http.ServerResponse, root: StaticRoot, relative: string): Promise<void> => {
    const notFound = (): void => {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("not found");
    };
    if (!isSafeRelative(relative) || relative.split("/").some((segment) => segment.startsWith("."))) {
        notFound();
        return;
    }
    const file = join(root.dir, relative);
    let size: number;
    try {
        const found = await stat(file);
        if (!found.isFile()) {
            notFound();
            return;
        }
        size = found.size;
    } catch {
        // allow(silent-catch): a file the tree does not hold is the 404 this answers.
        notFound();
        return;
    }
    // The converter ships only brotli-compressed; it is served as the bytes it stands for, never as a .br download.
    if (relative.endsWith(".br")) {
        const headers = { ...headersFor(relative, "application/octet-stream"), vary: "accept-encoding" };
        if (accepts(req, "br")) {
            await send(req, res, { ...headers, "content-encoding": "br", "content-length": size }, () => [createReadStream(file)]);
            return;
        }
        await send(req, res, headers, () => [createReadStream(file), createBrotliDecompress()]);
        return;
    }
    const headers = headersFor(relative, undefined);
    const compresses = compressible(relative, size);
    if (!compresses || !accepts(req, "gzip")) {
        const plain: http.OutgoingHttpHeaders = { ...headers, "content-length": size };
        // A compressible file goes out compressed to others: caches must keep the two apart.
        if (compresses) {
            plain["vary"] = "accept-encoding";
        }
        await send(req, res, plain, () => [createReadStream(file)]);
        return;
    }
    const encoded = { ...headers, vary: "accept-encoding", "content-encoding": "gzip" };
    if (root.gzipCache === undefined) {
        await send(req, res, encoded, () => [createReadStream(file), createGzip({ level: 6 })]);
        return;
    }
    const copy = join(root.gzipCache, `${relative}.gz`);
    await gzipCopy(file, copy);
    const copied = await stat(copy);
    await send(req, res, { ...encoded, "content-length": copied.size }, () => [createReadStream(copy)]);
};
