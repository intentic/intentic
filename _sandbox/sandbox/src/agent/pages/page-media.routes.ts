import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { isInside } from "@intentic/base/contained";
import { webStream } from "@intentic/base/web-stream";
import type { PageMediaFile } from "@intentic/sandbox-contract/text/pages";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { parseByteRange } from "../../workspace/files/workspace-files-download.js";
import { holdsStreamedMedia, pageMediaKeyPath, pageMediaRoots, streamedTypeOf, verifiedPageMedia } from "./page-media.js";
import { readStoredPage } from "./page-store.js";

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

// The recorded file, opened, or why it is not served now. Asked again on every request, not trusted from the manifest
// alone: a manifest is text in the records, and the file it names may have been moved, linked elsewhere or rewritten
// since. Everything after the open is asked of the open file itself, and the bytes are streamed from that same handle:
// a name swapped for a link between a check and the read (a race an agent can run in its own checkout) would otherwise
// stream whatever the link leads to under the size and type of the take that passed.
type Refusal = { readonly status: 404 | 409 | 415; readonly message: string };
type Opened = { readonly handle: FileHandle; readonly type: string } | Refusal;
// The one answer for a file that is not served, whatever the reason short of a change to the very file the page showed.
const NOT_SERVED = {
    status: 404,
    message: "This page has no such video or audio to play: the agent may have moved or removed it after showing the page.",
} as const satisfies Refusal;
const openRecorded = async (file: PageMediaFile, roots: readonly string[]): Promise<Opened> => {
    const inside = (path: string): boolean => roots.some((root) => isInside(root, path));
    // Asked of the recorded path before anything is asked of the disk, so a path outside is never looked at.
    if (!inside(file.path)) {
        return NOT_SERVED;
    }
    // allow(silent-catch): a file that cannot be resolved is not served, in the one answer every such file gets.
    const real = await realpath(file.path).catch(() => undefined);
    // Served as the type its name says, never the manifest's word for it.
    const type = real === undefined ? undefined : streamedTypeOf(real);
    if (real === undefined || real !== file.path || type === undefined || !inside(real)) {
        return NOT_SERVED;
    }
    // Without following a link, and without waiting: a pipe named like a take would otherwise hold the open, and a thread of
    // the daemon's file I/O with it, until something wrote to it. Neither changes how a regular file reads.
    // allow(silent-catch): a file that cannot be opened (gone, or its last part now a link) is answered as gone.
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (handle === undefined) {
        return NOT_SERVED;
    }
    let refused: Awaited<ReturnType<typeof refusalOf>> | "unasked" = "unasked";
    try {
        refused = await refusalOf(handle, file);
    } finally {
        if (refused !== undefined) {
            await handle.close();
        }
    }
    return refused === undefined ? { handle, type } : refused;
};

// Why the open file is not the one recorded, or undefined when it is: unchanged since the page was shown (its size and
// modification time, which only its writer sets) and still holding the format its name says.
const refusalOf = async (handle: FileHandle, file: PageMediaFile): Promise<Refusal | undefined> => {
    const info = await handle.stat();
    if (!info.isFile()) {
        return NOT_SERVED;
    }
    if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        return { status: 409, message: "This file changed after the page was shown, so it no longer plays here: ask the agent to show the new version." };
    }
    return (await holdsStreamedMedia(file.path, handle)) ? undefined : { status: 415, message: "This file is not the video or audio its name says." };
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
