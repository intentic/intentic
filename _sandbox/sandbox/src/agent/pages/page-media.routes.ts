import { Readable } from "node:stream";
import type { Context } from "hono";
import { webStream } from "@intentic/base/web-stream";
import type { PageMediaFile } from "@intentic/sandbox-contract/text/pages";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { parseByteRange } from "../../workspace/files/workspace-files-download.js";
import { NOT_SERVED, openRecorded, pageMediaKeyPath, pageMediaRoots, verifiedPageMedia } from "../../workspace/files/stored/stored-page-media.js";
import { readStoredPage } from "../../workspace/files/stored/stored-pages.js";

// GET /pages/media/{ticket}/{index}: a shown page's video or audio, streamed in byte ranges to the player inside the
// page's sealed frame (page-media.ts says how a file comes to be named). The frame has an opaque origin and sends no
// header, so the ticket in the path is the credential: minted by pages.mediaTicket for one stored page, through the
// reader's own authenticated session, and bound to that page, never to a file. The index names a file in the manifest
// the daemon wrote and signed into the page when it was shown, so the route serves exactly what the page named then; and
// only while that file is unchanged and still inside the workspace or the checkout of the conversation that showed it.
// Every way a file is not served short of that (no such index, a manifest that does not verify, a file outside those
// places, gone, or a link) answers the same 404 in the same words, so the route says nothing about what exists where.

export type PageMediaRoutesDeps = Pick<Services, "workspace" | "mediaTickets" | "config">;

const BINDING_PREFIX = "page-media:";

// What a ticket for a page's media is bound to in the ticket store, which other tickets share.
export const pageMediaBinding = (page: string): string => `${BINDING_PREFIX}${page}`;
const pageOfBinding = (binding: string | undefined): string | undefined =>
    binding?.startsWith(BINDING_PREFIX) === true ? binding.slice(BINDING_PREFIX.length) : undefined;

// Manifests parsed once per stored page, which is never rewritten once shown; a few dozen at most, oldest let go first.
const HELD = 64;
const manifests = new Map<string, readonly PageMediaFile[]>();
const manifestOf = async (deps: PageMediaRoutesDeps, page: string): Promise<readonly PageMediaFile[] | undefined> => {
    const held = manifests.get(page);
    if (held !== undefined) {
        return held;
    }
    const html = await readStoredPage(deps.workspace.root, page);
    const media = html === undefined ? undefined : await verifiedPageMedia(pageMediaKeyPath(deps.config.historyRoot), page, html);
    if (media !== undefined) {
        manifests.set(page, media);
        if (manifests.size > HELD) {
            manifests.delete(manifests.keys().next().value ?? "");
        }
    }
    return media;
};

const plain = (c: Context<AppEnv>, status: 401 | 404 | 409 | 415, message: string): Response =>
    c.body(message, status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });

const servePageMedia =
    (deps: PageMediaRoutesDeps) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const page = pageOfBinding(deps.mediaTickets.bound(c.req.param("ticket") ?? ""));
        if (page === undefined) {
            return plain(c, 401, "This page's pass to play its video has expired: reload the page to play it again.");
        }
        const index = Number(c.req.param("index"));
        const file = Number.isInteger(index) && index >= 0 ? (await manifestOf(deps, page))?.[index] : undefined;
        if (file === undefined) {
            return plain(c, NOT_SERVED.status, NOT_SERVED.message);
        }
        // The shared tree and the showing conversation's own checkout: where page-tools.ts records media from.
        const opened = await openRecorded(file, pageMediaRoots(deps.workspace.root, deps.config.historyRoot, page));
        if (!("handle" in opened)) {
            return plain(c, opened.status, opened.message);
        }
        const range = parseByteRange(c.req.header("range"), file.size);
        // The file is pinned to what was shown, so what a player kept of it stays true for as long as the ticket lives.
        const headers = { "Content-Type": opened.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=28800" };
        if (range === "unsatisfiable") {
            await opened.handle.close();
            // Must report the real size, or the element retries the same window forever.
            return c.body(null, 416, { ...headers, "Content-Range": `bytes */${file.size}` });
        }
        const length = range.end - range.start + 1;
        const sized = { ...headers, "Content-Length": String(length) };
        // The stream closes the handle when it ends or the player lets it go.
        const bytes = webStream<Uint8Array>(Readable.toWeb(opened.handle.createReadStream({ start: range.start, end: range.end })));
        if (!range.partial) {
            return c.body(bytes, 200, sized);
        }
        return c.body(bytes, 206, { ...sized, "Content-Range": `bytes ${range.start}-${range.end}/${file.size}` });
    };

export const pageMediaRawRoutes = defineRawRoutes((services: PageMediaRoutesDeps) => ({
    "GET /pages/media/{ticket}/{index}": servePageMedia(services),
}));
