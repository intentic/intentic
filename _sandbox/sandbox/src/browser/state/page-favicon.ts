import type { CDPSession } from "playwright";
import { z } from "zod";
import { FaviconCache } from "./favicons.js";
import { windowChanged } from "./window-feed.js";
import type { BrowserSessionRecord, PageRecord } from "./window-record.js";

// Which icon a tab has, and its bytes, both asked of the window itself. Chromium's DevTools endpoint lists every tab
// with the icon address it settled on (`faviconUrl` on /json/list: the page's own <link rel=icon> that suits a tab, else
// the site's /favicon.ico), and the bytes come through the tab's own network stack (`Network.loadNetworkResource`), with
// its cookies, its cache and its way out, so an icon behind a sign-in or a bound exit arrives as the page's did. Nothing
// is fetched from the daemon's own address and nothing from the person's browser. Measured on Chromium 156,
// 2026-11-19: both answer for a page on another origin as well as its own.

// One icon is never worth more of a window's time than this.
const LIST_TIMEOUT_MS = 1000;
const LOAD_TIMEOUT_MS = 5000;
// Read no further than this into what an icon address answers: a multi-size .ico runs to a hundred kilobytes, and an
// address that answers with a page or a stream must not be read to its end.
const MAX_RAW_BYTES = 256 * 1024;
// How long after a page arrives its icon is looked for: Chromium settles the address once the page has parsed its
// <link>s, a beat after the load event.
const SETTLE_MS = 400;

const ListedSchema = z.array(z.object({ id: z.string(), type: z.string(), faviconUrl: z.string().optional() }));

// Icons by the address they come from, shared by every window: a site's icon is fetched once whichever tab shows it.
const cache = new FaviconCache();

// The icon address Chromium has settled on for one tab; undefined when it has none (yet), or the list did not answer.
const listedFaviconUrl = async (endpoint: string, targetId: string): Promise<string | undefined> => {
    try {
        const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
        const parsed = ListedSchema.safeParse(await response.json());
        const url = parsed.data?.find((target) => target.id === targetId && target.type === "page")?.faviconUrl;
        return url === undefined || url === "" ? undefined : url;
    } catch {
        // allow(silent-catch): a window busy or closing has no icon to say; the tab keeps the one it shows.
        return undefined;
    }
};

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
    Promise.race([work, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);

// The stream a loaded resource answers with, read to its end or to the cap; undefined past the cap.
const readStream = async (session: CDPSession, handle: string): Promise<Uint8Array | undefined> => {
    const parts: Buffer[] = [];
    let total = 0;
    try {
        for (;;) {
            const read = await session.send("IO.read", { handle, size: 64 * 1024 });
            const part = Buffer.from(read.data, read.base64Encoded === true ? "base64" : "utf8");
            parts.push(part);
            total += part.length;
            if (total > MAX_RAW_BYTES) {
                return undefined;
            }
            if (read.eof) {
                return Buffer.concat(parts);
            }
        }
    } finally {
        // allow(silent-catch): a stream already gone with its page has nothing to close.
        await session.send("IO.close", { handle }).catch(() => undefined);
    }
};

// An icon's bytes, fetched through the tab's own frame; undefined when the address does not answer with a 2xx.
const loadThroughTab = async (session: CDPSession, url: string): Promise<Uint8Array | undefined> => {
    const load = async (): Promise<Uint8Array | undefined> => {
        const { frameTree } = await session.send("Page.getFrameTree");
        const { resource } = await session.send("Network.loadNetworkResource", {
            frameId: frameTree.frame.id,
            url,
            options: { disableCache: false, includeCredentials: true },
        });
        const status = resource.httpStatusCode ?? 0;
        if (!resource.success || status < 200 || status >= 300 || resource.stream === undefined) {
            return undefined;
        }
        return readStream(session, resource.stream);
    };
    return withTimeout(load(), LOAD_TIMEOUT_MS);
};

// The tab's CDP target id, read once: the key /json/list and Chromium's own tab model name it by.
export const pageTargetId = async (entry: PageRecord): Promise<string | undefined> => {
    if (entry.targetId === undefined && entry.cdp !== undefined) {
        // allow(silent-catch): a page closing as it is asked has no icon to look for.
        entry.targetId = (await entry.cdp.send("Target.getTargetInfo").catch(() => undefined))?.targetInfo.targetId;
    }
    return entry.targetId;
};

// Looks the tab's icon up again: once its address changes, the new one is fetched (or found held) and the window told.
// An address the window names no icon for clears the one shown, so a tab that went from a site to a blank page does
// not keep the site's icon.
const refreshFavicon = async (record: BrowserSessionRecord, entry: PageRecord): Promise<void> => {
    const targetId = await pageTargetId(entry);
    if (record.port <= 0 || targetId === undefined || entry.closed || entry.cdp === undefined) {
        return;
    }
    const session = entry.cdp;
    const url = await listedFaviconUrl(`http://127.0.0.1:${record.port}`, targetId);
    if (url === entry.faviconUrl) {
        return;
    }
    entry.faviconUrl = url;
    const icon = url === undefined ? undefined : await cache.get(url, (address) => loadThroughTab(session, address));
    // Another arrival may have moved the tab on while this one fetched; the newer lookup has the say.
    if (entry.faviconUrl === url && entry.favicon !== icon && !entry.closed) {
        entry.favicon = icon;
        windowChanged(record);
    }
};

// Looks for the tab's icon a beat after each arrival and each load, once per burst.
export const watchFavicon = (record: BrowserSessionRecord, entry: PageRecord): void => {
    let timer: NodeJS.Timeout | undefined;
    const soon = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void refreshFavicon(record, entry), SETTLE_MS);
        timer.unref();
    };
    entry.page.on("load", soon);
    entry.page.on("framenavigated", (frame) => {
        if (frame.parentFrame() === null) {
            soon();
        }
    });
    entry.page.once("close", () => clearTimeout(timer));
};
