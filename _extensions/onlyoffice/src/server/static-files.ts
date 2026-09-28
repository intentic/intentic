import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import type http from "node:http";
import { dirname, extname, join } from "node:path";
import type { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGzip } from "node:zlib";
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
            // SAFETY: fs rejects with a NodeJS.ErrnoException; only its code is read.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        await mkdir(dirname(copy), { recursive: true });
        const temporary = `${copy}.${randomBytes(4).toString("hex")}.tmp`;
        try {
            await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(temporary));
            await rename(temporary, copy);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    })().finally(() => compressing.delete(copy));
    compressing.set(copy, made);
    return made;
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
    const compressible = COMPRESSIBLE.has(extname(relative).toLowerCase()) && size >= MIN_COMPRESS_BYTES;
    if (!compressible || !accepts(req, "gzip")) {
        const plain: http.OutgoingHttpHeaders = { ...headers, "content-length": size };
        // A compressible file goes out compressed to others: caches must keep the two apart.
        if (compressible) {
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
