import { type McpAppData, type Page, pageHead, type PageTheme, readMcpAppData } from "@intentic/sandbox-contract";
import { sandboxBlob } from "../../../../client/sandbox/sandboxClient";
import { buildPreviewDocument } from "../../../workspace/viewers/html/htmlDocument";

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
const loadAsset = (path: string): Promise<Blob | undefined> => readShared(path).catch(() => undefined);

// The page, sealed and themed, for the frame's `srcdoc`; for an MCP server's app, the call it shows as well.
export const buildPageDocument = async (page: Page, theme: PageTheme): Promise<{ readonly html: string; readonly app?: McpAppData }> => {
    const source = await pageSource(page.path);
    const built = await buildPreviewDocument(source, page.source ?? page.path, loadAsset, pageHead(theme));
    const app = page.app === undefined ? undefined : readMcpAppData(source);
    return app === undefined ? { html: built.html } : { html: built.html, app };
};
