import { type McpAppData, pageHead, type PageTheme, placePageMedia, readMcpAppData, readPageMedia, sealedPagePolicy } from "@intentic/sandbox-contract/text/pages";
import type { Page } from "@intentic/sandbox-contract/events/requests";
import { watch } from "vue";
import { sandboxBlob, sandboxRequest } from "../../../../client/sandbox/sandboxClient";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useSandboxSession } from "../../../../client/session/sandboxSession";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useEndpoint } from "../../../../client/endpoint/useEndpoint";
import { elementAddress } from "../../../../client/endpoint/elementAddress";
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

// The video and audio a page names on disk stream from the sandbox (the daemon's agent/pages/page-media.ts): a player
// sends no header, so each address carries a ticket the window mints through its own signed-in session, bound to this
// one page and covering only the files it named when it was shown. A ticket lives for a sitting, so one is kept per page
// and sandbox while it has a good while left, and a page drawn again (scrolled back, opened alone) reuses it. The daemon
// keeps tickets in memory and drops them when it restarts or a person is signed out, so every kept ticket is let go when
// the sandbox comes back online or the session's person changes, and a page's own when its media fails to load on a
// ticket the daemon no longer takes: the next drawing mints afresh.
const TICKET_SPARE_MS = 30 * 60 * 1000;
const tickets = new Map<string, { readonly ticket: string; readonly expiresAt: number }>();
const keyOf = (base: string, path: string): string => `${base} ${path}`;

// Watched from the first ticket on, not at import, so a window that never shows a page with media watches nothing.
let watching = false;
const forgetOnChange = (): void => {
    if (watching) {
        return;
    }
    watching = true;
    const { reachable } = useSandbox();
    const { presentedEmail } = useSandboxSession();
    watch(reachable, (online, was) => {
        if (online && !was) {
            tickets.clear();
        }
    });
    watch(presentedEmail, () => tickets.clear());
};

const ticketFor = async (base: string, path: string): Promise<string> => {
    forgetOnChange();
    const held = tickets.get(keyOf(base, path));
    if (held !== undefined && held.expiresAt > Date.now() + TICKET_SPARE_MS) {
        return held.ticket;
    }
    const minted = await sandboxRpc.pages.mediaTicket({ page: path });
    tickets.set(keyOf(base, path), minted);
    return minted.ticket;
};

// A page's player failed to load: whether the ticket it streamed on is still taken is asked of the daemon through the
// window's own transport (the frame cannot see a status across its seal), and a refused one is let go. A missing or
// changed file answers otherwise and keeps the ticket, which is still good for the page's other files.
export const mediaFailed = async (path: string): Promise<void> => {
    const base = useEndpoint().daemonBase.value;
    const held = base === undefined ? undefined : tickets.get(keyOf(base, path));
    if (base === undefined || held === undefined) {
        return;
    }
    try {
        // allow(daemon-doors): the media route answers bytes, not JSON, and only its status is read here.
        const answer = await sandboxRequest(`/pages/media/${encodeURIComponent(held.ticket)}/0`, { headers: { range: `bytes=0-0` } });
        await answer.body?.cancel();
        if (answer.status === 401 && tickets.get(keyOf(base, path)) === held) {
            tickets.delete(keyOf(base, path));
        }
    } catch {
        // allow(silent-catch): a sandbox that cannot be asked keeps the ticket; reconnecting lets every ticket go anyway.
    }
};

// The address of each of the page's `count` media files, as the element will load it (elementAddress.ts); none when the
// sandbox cannot be reached or will not mint, and then the page still draws, its players empty.
const mediaAddresses = async (path: string, count: number): Promise<readonly string[]> => {
    const base = useEndpoint().daemonBase.value;
    if (count === 0 || base === undefined || base === ``) {
        return [];
    }
    try {
        const ticket = encodeURIComponent(await ticketFor(base, path));
        return Array.from({ length: count }, (_, index) => elementAddress(`${base}/pages/media/${ticket}/${index}`));
    } catch {
        // allow(silent-catch): a page whose media cannot be streamed still draws; each player shows its own error.
        return [];
    }
};

// The page, sealed and themed, for the frame's `srcdoc`; for an MCP server's app, the call it shows as well. A page that
// streams video or audio has its references swapped for their addresses, and its seal opens `media-src` to exactly
// those addresses and nothing else.
export const buildPageDocument = async (page: Page, theme: PageTheme): Promise<{ readonly html: string; readonly app?: McpAppData }> => {
    const source = await pageSource(page.path);
    const addresses = await mediaAddresses(page.path, readPageMedia(source)?.files.length ?? 0);
    const built = await buildPreviewDocument(source, page.source ?? page.path, loadAsset, pageHead(theme) + BLEED_CSS, sealedPagePolicy(addresses));
    const html = addresses.length === 0 ? built.html : placePageMedia(built.html, addresses.length, (index) => addresses[index] ?? ``);
    const app = page.app === undefined ? undefined : readMcpAppData(source);
    return app === undefined ? { html } : { html, app };
};
