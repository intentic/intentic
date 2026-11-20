import { copyFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { browserContract } from "@intentic/sandbox-contract/contracts/browser.contract";
import { implement, ORPCError } from "@orpc/server";
import type { Context } from "hono";
import { webStream } from "@intentic/base/web-stream";
import { STATE_DIR } from "@intentic/constants";
import type { AppEnv, OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { callerEditFence } from "../../areas/area-scope.js";
import { fenceOpens } from "../../workspace/layout/workspace-fence.js";
import { resolveWorkspacePath } from "../../workspace/files/workspace-files-paths.js";
import { browserSessionPage, browserWindowRecord } from "../sessions/browser-sessions.js";
import { addFinishedDownload, allDownloads, cancelDownload, findDownload, removeDownload } from "./browser-downloads.js";
import { wireDownload } from "./download-tracker.js";

// The routes behind a window's download list (browser-downloads.ts) and its print: the list, a finished file fetched
// onto the person's computer or copied into the workspace, a download stopped or removed, a page printed to PDF.

export type DownloadsRoutesDeps = Pick<Services, "mediaTickets" | "workspace" | "areas" | "history">;

// The ticket a download's file is opened with: minutes, since the person's own browser redeems it at once.
const TICKET_MS = 5 * 60_000;
const TICKET_PREFIX = "browser-download:";

// Where "Save to workspace" goes when no folder is named.
const DEFAULT_SAVE_FOLDER = "downloads";

const finishedFile = (id: string) => {
    const record = findDownload(id);
    if (record?.state !== "done" || record.file === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "That download has not finished, or is gone." });
    }
    return { name: record.name, file: record.file };
};

// The first of `name`, `name (1)`, `name (2)`… that is free in `folder`: a save never replaces what is there.
const freeName = async (folder: string, name: string): Promise<string> => {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 0; n < 1000; n += 1) {
        const candidate = n === 0 ? name : `${stem} (${String(n)})${ext}`;
        // allow(silent-catch): a name with nothing at it is the free one.
        if ((await stat(join(folder, candidate)).catch(() => undefined)) === undefined) {
            return candidate;
        }
    }
    throw new ORPCError("CONFLICT", { message: "That folder already holds a thousand files of that name." });
};

// What a file off the web is never saved into, though a person may edit there by hand: the sandbox's own settings and
// state, and a repository's insides.
const STATE_FOLDERS = new Set([STATE_DIR, ".git"]);

// The folder a save lands in, as the workspace's own upload decides one: inside the workspace however it is spelled or
// linked, never a locked path, and inside the caller's own folders when they are fenced; and never the folders above.
const saveFolder = async (services: DownloadsRoutesDeps, folder: string, caller: OrpcContext["identity"]): Promise<{ readonly path: string; readonly rel: string }> => {
    const resolved = await resolveWorkspacePath(services.workspace.root, folder);
    if (resolved.kind !== "inside" || resolved.realRel.split("/").some((segment) => STATE_FOLDERS.has(segment))) {
        throw new ORPCError("BAD_REQUEST", { message: "Pick a folder inside the workspace." });
    }
    const fence = callerEditFence(await services.areas.list(), caller);
    if (!fenceOpens(fence, folder) || !fenceOpens(fence, resolved.realRel)) {
        throw new ORPCError("FORBIDDEN", { message: "That folder is outside your access to this workspace." });
    }
    return { path: resolved.path, rel: relative(services.workspace.root, resolved.path) };
};

export const createDownloadsRoutes = (services: DownloadsRoutesDeps) => {
    const i = implement(browserContract).$context<OrpcContext>();
    return {
        downloads: i.downloads.handler(() => allDownloads()),
        downloadTicket: i.downloadTicket.handler(({ input, context }) => {
            finishedFile(input.id);
            return services.mediaTickets.mint(`${TICKET_PREFIX}${input.id}`, TICKET_MS, context.identity?.email);
        }),
        saveDownload: i.saveDownload.handler(async ({ input, context }) => {
            const { name, file } = finishedFile(input.id);
            const folder = await saveFolder(services, input.folder ?? DEFAULT_SAVE_FOLDER, context.identity);
            await mkdir(folder.path, { recursive: true });
            const saved = await freeName(folder.path, name);
            await copyFile(file, join(folder.path, saved));
            services.history.notifyUserWrite();
            return { path: folder.rel === "" ? saved : `${folder.rel}/${saved}` };
        }),
        cancelDownload: i.cancelDownload.handler(async ({ input }) => {
            await cancelDownload(input.id);
            return { ok: true };
        }),
        removeDownload: i.removeDownload.handler(async ({ input }) => {
            await removeDownload(input.id);
            return { ok: true };
        }),
        // Chromium's own print-to-PDF of the page as it is now, with its backgrounds, listed like any download.
        printPage: i.printPage.handler(async ({ input }) => {
            const record = browserWindowRecord(input.name);
            const entry = record?.pages.get(input.pageId);
            const page = browserSessionPage(input.name, input.pageId);
            if (record === undefined || entry?.cdp === undefined || page === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That tab is no longer open." });
            }
            const printed = await entry.cdp.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
            // allow(silent-catch): a page navigating as it prints has no title to read; its host names the file instead.
            const title = (await page.title().catch(() => "")) || new URL(page.url()).hostname || "page";
            const download = await addFinishedDownload({
                root: services.workspace.root,
                profile: record.server,
                name: `${title}.pdf`,
                url: page.url(),
                bytes: Buffer.from(printed.data, "base64"),
            });
            return wireDownload(download);
        }),
    };
};

/** GET /browser/downloads/file?ticket=: a finished download's bytes, as an attachment the person's browser saves. */
export const downloadFileRoute =
    (services: Pick<Services, "mediaTickets">) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const bound = services.mediaTickets.bound(c.req.query("ticket") ?? "");
        const record = bound?.startsWith(TICKET_PREFIX) === true ? findDownload(bound.slice(TICKET_PREFIX.length)) : undefined;
        if (record?.state !== "done" || record.file === undefined) {
            return c.json({ error: "this download link has expired; save it again" }, 401);
        }
        // allow(silent-catch): a file removed under the ticket is the 404 below.
        const info = await stat(record.file).catch(() => undefined);
        if (info === undefined) {
            return c.json({ error: "that download is gone" }, 404);
        }
        return c.body(webStream<Uint8Array>(Readable.toWeb(createReadStream(record.file))), 200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(info.size),
            // Cross-origin `download` attributes are ignored; this header names the file instead, RFC 5987-encoded.
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
            "Cache-Control": "no-store",
        });
    };

// A finished download's file, fetched by the person's own browser with a ticket browser.downloadTicket minted.
export const browserDownloadsRawRoutes = defineRawRoutes((services: Pick<Services, "mediaTickets">) => ({
    "GET /browser/downloads/file": downloadFileRoute(services),
}));
