import { type McpAppData, pageHead, type PageTheme, readMcpAppData } from "@intentic/sandbox-contract/text/pages";
import type { Page } from "@intentic/sandbox-contract/events/requests";
import { sandboxBlob } from "../../../../client/sandbox/sandboxClient";
import { buildPreviewDocument } from "../../../../models/workspace/viewers/htmlDocument";

// A page the agent showed, as the frame draws it: the stored file (never rewritten, so read once per window), sealed the
// way every workspace page is (htmlDocument.ts), with the chat's theme and the bridge first in its head.

// Pages live in the workspace's shared records, never in a conversation's own checkout: read with no scope.
const readShared = (path: string): Promise<Blob> => sandboxBlob(`/workspace/raw?${new URLSearchParams({ path }).toString()}`);

// A stored page never changes, so its text is kept for the window's life; a few dozen at most, oldest let go first.
const KEPT = 48;
const sources = new Map<string, Promise<string>>();

export const pageSource = (path: string): Promise<string> => {
    const held = sources.get(path);
    if (held !== undefined) {
        // Moved to the back, so the pages still being read are the last to go.
        sources.delete(path);
        sources.set(path, held);
        return held;
    }
    const reading = readShared(path).then((blob) => blob.text());
    // A failed read is not kept: the next mount asks again.
    reading.catch(() => sources.delete(path));
    sources.set(path, reading);
    for (const stale of sources.keys()) {
        if (sources.size <= KEPT) {
            break;
        }
        sources.delete(stale);
    }
    return reading;
};

// What a file beside the page reads as: everything was carried in when the page was shown, so this reaches only a page
// built from a file (`source`), whose own relative links still name files beside it.
// allow(silent-catch): a file the page names that cannot be read draws as missing, as a broken link does on the web.
const loadAsset = (path: string): Promise<Blob | undefined> => readShared(path).catch(() => undefined);

// How far a page may draw past its own edges, in px. Pages lay cards flush with their edges and mark the chosen one with
// a ring outside its box (an outline with an offset, a `0 0 0 3px` shadow, a focus ring), which a frame exactly the
// column's size cut off on the outer side. So the page's root is inset by this much on every side and the frame is that
// much wider than the column (ChatPageFrame), so the content still lines up with the prose and a ring has room to show.
// `:root` rather than `html`, so a page's own `html,body{padding:0}` reset does not take the room away.
export const PAGE_BLEED = 6;
const BLEED_CSS = `<style id="intentic-bleed">:root{padding:${PAGE_BLEED}px}</style>`;

// The page, sealed and themed, for the frame's `srcdoc`; for an MCP server's app, the call it shows as well.
export const buildPageDocument = async (page: Page, theme: PageTheme): Promise<{ readonly html: string; readonly app?: McpAppData }> => {
    const source = await pageSource(page.path);
    const built = await buildPreviewDocument(source, page.source ?? page.path, loadAsset, pageHead(theme) + BLEED_CSS);
    const app = page.app === undefined ? undefined : readMcpAppData(source);
    return app === undefined ? { html: built.html } : { html: built.html, app };
};
