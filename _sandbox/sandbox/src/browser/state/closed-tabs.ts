import type { BrowserClosedTab } from "@intentic/sandbox-contract/schemas/terminal";
import { opt } from "../../opt.js";
import { shownFavicon, shownTitle, shownUrl } from "./deferred-tabs.js";
import { indexAmong } from "./tab-order.js";
import type { BrowserSessionRecord, PageRecord } from "./window-record.js";

// The tabs a window has closed while it runs, newest first, as a browser keeps them for Reopen closed tab: where each
// was, what it was called, and the place it had on the strip, so it comes back there rather than at the end. Kept per
// window in memory: a window that ends takes its list with it, and the person's own window's open tabs are what its
// restore keeps (own-tabs.ts), not what was closed in it.

// How many are kept, and how many of them the window's state lists: a browser's own menu shows about ten.
const KEEP = 25;
export const CLOSED_LISTED = 10;

export interface ClosedTab {
    readonly id: string;
    readonly url: string;
    readonly title?: string | undefined;
    readonly favicon?: string | undefined;
    // Its place among the window's open tabs when it closed.
    readonly index: number;
    readonly closedAt: number;
}

// A tab that never went anywhere has nothing to come back to.
export const worthReopening = (url: string): boolean => url !== "" && url !== "about:blank" && !url.startsWith("chrome://");

let minted = 0;

// The list with one more closed tab on top, the oldest falling off past what is kept.
export const rememberClosed = (closed: readonly ClosedTab[] | undefined, tab: Omit<ClosedTab, "id">): readonly ClosedTab[] => {
    minted += 1;
    return [{ ...tab, id: `c${minted}` }, ...(closed ?? [])].slice(0, KEEP);
};

// The closed tab asked for (the newest when none is named), and the list without it; undefined when there is none.
export const takeClosed = (
    closed: readonly ClosedTab[] | undefined,
    id: string | undefined,
): { readonly tab: ClosedTab; readonly rest: readonly ClosedTab[] } | undefined => {
    const tab = id === undefined ? closed?.[0] : closed?.find((candidate) => candidate.id === id);
    return tab === undefined ? undefined : { tab, rest: (closed ?? []).filter((candidate) => candidate !== tab) };
};

// The list as the window's state carries it: the newest few, without the place each had, which is the daemon's to use.
export const listClosed = (closed: readonly ClosedTab[] | undefined): BrowserClosedTab[] | undefined =>
    closed === undefined || closed.length === 0
        ? undefined
        : closed.slice(0, CLOSED_LISTED).map((tab) => ({
              id: tab.id,
              url: tab.url,
              closedAt: tab.closedAt,
              ...opt("title", tab.title),
              ...opt("favicon", tab.favicon),
          }));

// What noting a closed tab reads of its window and of the tab.
export type ClosingWindow = Pick<BrowserSessionRecord, "finishedAt" | "closed"> & { readonly pages: ReadonlyMap<string, Pick<PageRecord, "closed">> };
export type ClosingTab = Pick<PageRecord, "id" | "closed" | "url" | "title" | "favicon" | "deferred">;

// A tab of a running window just closed: kept with the place it had, unless it never went anywhere. A window that is
// itself going takes its tabs with it, and those are no closed tabs (its finish is stamped before they go).
export const noteClosed = (record: ClosingWindow, entry: ClosingTab): void => {
    const url = shownUrl(entry);
    if (record.finishedAt !== undefined || entry.closed || !worthReopening(url)) {
        return;
    }
    const index = indexAmong(record.pages, entry.id, (other) => !other.closed);
    record.closed = rememberClosed(record.closed, { url, title: shownTitle(entry), favicon: shownFavicon(entry), index, closedAt: Date.now() });
};
