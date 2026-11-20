import type { Browser, BrowserContext, CDPSession, Dialog, Page } from "playwright";
import type { NavigationState } from "../navigation/page-navigation.js";
import type { ClosedTab } from "./closed-tabs.js";
import type { FrontReader } from "./front-reader.js";
import type { TabHelper, TabSound } from "../tabs/tab-helper.js";

// What the daemon holds of one browser window and its tabs (browser-sessions.ts keeps them; window-summary.ts lists
// them). Here rather than there so the summary, the feed and the front reader can share the shape without importing the
// module that owns the map.

// Whether a tab's history has somewhere to go either way, read off Chromium after each arrival (page-history.ts).
export interface PageHistory {
    readonly back: boolean;
    readonly forward: boolean;
}

// One open tab: `page` is held so a bind looks it up rather than re-deriving from a possibly-stale url.
// id is minted per session (p1, p2, …), opaque, stable for the page's life, and never reused.
export interface PageRecord {
    readonly id: string;
    readonly page: Page;
    url: string;
    title: string | undefined;
    // Marked, not deleted: close/disconnect order isn't guaranteed; deletion could empty a finished session's strip.
    closed: boolean;
    // The JavaScript dialog the page has open, held for whoever answers first; see watchPage.
    dialog: Dialog | undefined;
    // What it is doing between addresses: loading, a navigation in flight, the reason the last one failed
    // (page-navigation.ts).
    readonly navigation: NavigationState;
    // The page's own DevTools session (watchPageSession), once open: what its history is read through.
    cdp: CDPSession | undefined;
    history: PageHistory | undefined;
    // Its CDP target id, read as its session opens: what Chromium's own tab list and the tab helper name it by
    // (page-favicon.ts, tab-helper.ts).
    targetId?: string | undefined;
    // The icon address Chromium settled on for it, and that icon as the editor draws it (page-favicon.ts).
    faviconUrl?: string | undefined;
    favicon?: string | undefined;
    // A tab brought back by a restore that has not loaded yet: it stands as about:blank, listed as where it was, and
    // goes there the first time it is in front (browser-tabs.ts), as a browser restores its background tabs.
    deferred?: { readonly url: string; readonly title?: string | undefined; readonly favicon?: string | undefined } | undefined;
}

// What the daemon knows about one browser; `context` is set only once the CDP attach lands. Most are an agent's; the
// person's own window (own-browser.ts) is adopted with its context already in hand and a shutdown of its own.
export interface BrowserSessionRecord {
    readonly name: string;
    // Rises on every change (window-feed.ts): which of two copies of this window is the newer.
    seq: number;
    // The person's own window rather than an agent's: never reaped for idleness, and labelled by its page alone.
    readonly own: boolean;
    // How the window is ended when it is ours to end: Chromium's orderly close for a browser this daemon started, where
    // Playwright's close() on an attached browser would only disconnect and leave the process running.
    readonly shutdown: (() => Promise<void>) | undefined;
    // Owning conversation, the reaper's key; undefined for a turn with no conversation (the bench).
    readonly owner: string | undefined;
    // MCP server driving it: `web`, or a logged-in capability's id.
    readonly server: string;
    readonly port: number;
    // Passkey store for a logged-in capability; undefined for `web`, which holds no identity.
    readonly passkeyStore: string | undefined;
    readonly startedAt: number;
    activityAt: number;
    // Open pages in the order the window's strip shows them: open order, until a tab is dragged elsewhere or reopened
    // at the place it had (tab-order.ts). The order is the daemon's, since Chromium's own strip is never seen.
    readonly pages: Map<string, PageRecord>;
    nextPageId: number;
    // The tab in front, the one the window's picture shows; falls back as tabs close, undefined once none remain.
    activePageId: string | undefined;
    // The tab in front when last known, never walked back (unlike activePageId); a finished session's label needs where
    // it ended.
    lastPageId: string | undefined;
    // Asks Chromium which tab is in front (front-reader.ts); undefined until attached, and for a window with no DevTools
    // port to ask, where the tab last driven stands in for it.
    front: FrontReader | undefined;
    // Set when the browser went away: turn ended, browser_close, or Chromium crashed.
    finishedAt: number | undefined;
    // Parked help request the agent is blocked on; cleared when the waiter settles or the session finishes.
    help: { readonly requestId: string; readonly message: string; readonly requestedAt: number } | undefined;
    // Settles that request as not-helped, bound by whoever raised it; what a closing browser owes its waiter.
    abandonHelp: ((note: string) => void) | undefined;
    browser: Browser | undefined;
    context: BrowserContext | undefined;
    // In-flight attach; a second tool call doesn't start another one, and the view route can await it.
    attaching: Promise<BrowserContext | undefined> | undefined;
    // Tabs closed while the window ran, newest first: what Reopen closed tab brings back (closed-tabs.ts).
    closed?: readonly ClosedTab[] | undefined;
    // Chromium's own tab state, for a window that loads the tab helper (the person's own); absent elsewhere.
    helper?: TabHelper | undefined;
    // Whether each tab is playing sound and whether it is muted, as the helper last said, by CDP target id. A tab is
    // given its own when the window is listed (window-summary.ts), so the report and the tab's id may arrive in either
    // order (browser-tabs.ts, followSound).
    sound?: ReadonlyMap<string, TabSound> | undefined;
    // Rises with every tab a person picks: an answer of Chromium's about the tab in front that was asked for before the
    // last pick is older than it, and is dropped rather than undoing the pick (browser-sessions.ts, readerFor).
    picks?: number | undefined;
}
