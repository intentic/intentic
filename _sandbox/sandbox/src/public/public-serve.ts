import { createReadStream } from "node:fs";
import type http from "node:http";
import { pipeline } from "node:stream";
import { interstitial } from "../panels/interstitial.js";
import { type PublicResolution, resolvePublicFile } from "./public-files.js";

// The outbox's HTTP surface, mounted on the preview proxy with no auth in front: every response is written for a
// stranger holding a link, not the owner.
// 1. GET and HEAD only; there is no write path to the outbox from the internet.
// 2. X-Robots-Tag: noindex, since a link pasted publicly can be followed even though the hostname is unguessable.
// 3. X-Content-Type-Options: nosniff, so public-files.ts's allowlist is the last word on how a response is interpreted.
// 4. Range requests, since a published screen recording needs to seek.
// Every refusal renders the same branded 404, whatever the reason; the publisher reads the real one off the Public
// view.

// A rebuilt file overwrites in place, so nothing is cached hard; the etag keeps repeat visits cheap.
const etagOf = (resolution: Extract<PublicResolution, { kind: "file" }>): string => `W/"${resolution.size}-${Math.floor(resolution.mtimeMs)}"`;

// A single `bytes=` range; undefined for absent/malformed/multi-range, all answered with the whole file.
const parseRange = (header: string | undefined, size: number): { readonly start: number; readonly end: number } | undefined => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
    if (match === null) {
        return undefined;
    }
    const [, rawStart, rawEnd] = match;
    // `bytes=-500` means the last 500 bytes, not a range starting at 0.
    const start = rawStart === "" ? size - Number(rawEnd) : Number(rawStart);
    const end = rawStart === "" || rawEnd === "" ? size - 1 : Number(rawEnd);
    return start < 0 || end < start || start >= size ? undefined : { start, end: Math.min(end, size - 1) };
};

// CSP for SVG only: presentation intact, scripting gone. HTML pages keep scripts; that's the point of one.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const serveRefusal = (res: http.ServerResponse, status: number, title: string, message: string): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" });
    res.end(interstitial(title, message));
};

// Serves one request against the outbox at `root`, bound so the proxy needn't know the filesystem.
export const createPublicHandler =
    (root: string) =>
    async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/html; charset=utf-8" });
            res.end(interstitial("Not allowed", "Published files are read-only."));
            return;
        }
        const resolution = await resolvePublicFile(root, req.url);
        if (resolution.kind === "refused") {
            serveRefusal(res, resolution.status, resolution.title, resolution.message);
            return;
        }

        const etag = etagOf(resolution);
        const headers: http.OutgoingHttpHeaders = {
            "content-type": resolution.type,
            "x-content-type-options": "nosniff",
            "x-robots-tag": "noindex",
            "cache-control": "no-cache",
            "accept-ranges": "bytes",
            etag,
            ...(resolution.inline ? {} : { "content-disposition": "attachment" }),
            ...(resolution.type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
        };

        if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, headers);
            res.end();
            return;
        }
        if (req.method === "HEAD") {
            res.writeHead(200, { ...headers, "content-length": resolution.size });
            res.end();
            return;
        }

        const range = parseRange(req.headers.range, resolution.size);
        const [status, extra, stream] =
            range === undefined
                ? [200, { "content-length": resolution.size }, createReadStream(resolution.absPath)]
                : [
                      206,
                      { "content-length": range.end - range.start + 1, "content-range": `bytes ${range.start}-${range.end}/${resolution.size}` },
                      createReadStream(resolution.absPath, { start: range.start, end: range.end }),
                  ];
        res.writeHead(status, { ...headers, ...extra });
        // pipeline, not pipe, destroys both ends on failure, so an aborted download can't leak the read descriptor.
        pipeline(stream, res, () => undefined);
    };

export type PublicHandler = ReturnType<typeof createPublicHandler>;
