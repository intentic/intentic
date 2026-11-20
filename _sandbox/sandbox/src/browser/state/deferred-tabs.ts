import type { PageRecord } from "./window-record.js";

// A tab a restore brought back without loading it (browser-tabs.ts, restoreTabs): it stands as about:blank and is
// listed as where it was, so the strip and the next restore see the page it holds, and it loads the first time it is
// in front, the way a browser restores its background tabs without fetching every one of them at once.

// What a tab says of itself, deferred or not.
type Shown = Pick<PageRecord, "url" | "title" | "favicon" | "deferred">;

// Where the tab is, as the strip and the restore list it: its restored address until it loads.
export const shownUrl = (entry: Shown): string => entry.deferred?.url ?? entry.url;
export const shownTitle = (entry: Shown): string | undefined => entry.deferred?.title ?? entry.title;
export const shownFavicon = (entry: Shown): string | undefined => entry.deferred?.favicon ?? entry.favicon;

// Sends a deferred tab to its address, once; any other tab is left alone. Not awaited past the commit: the picture
// shows it arriving like any navigation.
export const wakeDeferred = (entry: PageRecord | undefined): void => {
    const deferred = entry?.deferred;
    if (entry === undefined || deferred === undefined || entry.closed) {
        return;
    }
    entry.deferred = undefined;
    // Listed as where it is going until it gets there, so the strip does not flash a blank tab between the two.
    entry.url = deferred.url;
    entry.title = deferred.title;
    entry.favicon = deferred.favicon;
    // allow(silent-catch): an address that no longer answers is Chromium's own error page, which the tab then shows.
    void entry.page.goto(deferred.url, { waitUntil: "commit" }).catch(() => undefined);
};
