import { createReadStream } from "node:fs";
import type http from "node:http";
import { interstitial } from "../panels/interstitial.js";
import { type PublicResolution, resolvePublicFile } from "./public-files.js";

/* THE OUTBOX'S HTTP SURFACE, how a published file answers, once public-files.ts has decided it may.
 *
 * Mounted on the preview proxy, so it inherits that proxy's one property: no auth in front of it. Everything
 * about the response is therefore written for a stranger holding a link, not for the owner:
 *
 *   • GET and HEAD only. There is no write path to the outbox from the internet, files get there through the
 *     workspace, which is authenticated.
 *   • `X-Robots-Tag: noindex`. The hostname is unguessable, so crawlers cannot find the outbox on their own,
 *     but a link pasted into a public issue can be followed, and "I sent this to one person" should not become
 *     a search result. A user publishing a real site rather than an artifact is the case this costs, and the
 *     link-sharing case is overwhelmingly the common one.
 *   • `X-Content-Type-Options: nosniff`, always, so the allowlist in public-files.ts is the last word on how a
 *     response is interpreted rather than a suggestion the browser may re-derive from the bytes.
 *   • Range requests, because publishing a screen recording is a normal thing to do and a video element that
 *     cannot seek reads as broken.
 *
 * Every refusal, missing, blocked, or simply not published, renders the same branded 404 page the proxy uses,
 * for the same reason it says so little: a stranger is not owed the difference, and the publisher reads the
 * real reason off the Public view. */

// A published file changes in place (a rebuilt site overwrites index.html), so nothing is cached hard. The
// validator makes the repeat visit cheap without ever letting a viewer hold a stale copy.
const etagOf = (resolution: Extract<PublicResolution, { kind: "file" }>): string => `W/"${resolution.size}-${Math.floor(resolution.mtimeMs)}"`;

// A single `bytes=` range against a known length, undefined when absent, malformed, or multi-range (all of
// which are answered with the whole file, which is always a valid response to a Range request).
const parseRange = (header: string | undefined, size: number): { readonly start: number; readonly end: number } | undefined => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
    if (match === null) {
        return undefined;
    }
    const [, rawStart, rawEnd] = match;
    // "bytes=-500" is the LAST 500 bytes, not a range starting at 0, the one part of the grammar that reads
    // backwards.
    const start = rawStart === "" ? size - Number(rawEnd) : Number(rawStart);
    const end = rawStart === "" || rawEnd === "" ? size - 1 : Number(rawEnd);
    return start < 0 || end < start || start >= size ? undefined : { start, end: Math.min(end, size - 1) };
};

// The Content-Security-Policy an SVG document is served under: presentation intact, scripting gone. Applied to
// SVG alone, an HTML page in the outbox is a site the user published and needs its own scripts, whereas an SVG
// is a diagram whose ability to execute is never the reason it was shared.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const serveRefusal = (res: http.ServerResponse, status: number, title: string, message: string): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" });
    res.end(interstitial(title, message));
};

/* Serve one request against the outbox at `root`. Bound to a workspace root at construction so the proxy can
 * hand it a request without knowing anything about the filesystem. */
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
        // A read that fails after the head is written (the file was deleted mid-stream) has no way left to say
        // so, dropping the socket is the only honest signal, and the viewer's client reports a truncated
        // transfer rather than a silently short file.
        stream.on("error", () => res.destroy());
        res.writeHead(status, { ...headers, ...extra });
        stream.pipe(res);
    };

export type PublicHandler = ReturnType<typeof createPublicHandler>;
