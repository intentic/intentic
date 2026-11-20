import type { VisitKind } from "./browsing-index.js";
import type { BrowsingStore } from "./browsing-store.js";

// The navigations the daemon watches (browser-sessions.ts calls `noteBrowsing` each time it re-reads a tab), turned into
// visits of the window's profile: a tab whose address changed went somewhere, one whose title changed is only news for
// the page it is on. Whether a visit was typed or followed is Chromium's to say, off the tab's own history list: an
// address sent from the editor's address bar arrives as `Page.navigate`, which Chromium records as typed.
//
// The store is started with the daemon's routes (browsing.routes.ts); until then, and in a process that never starts
// it (a test of the sessions alone), a tab's changes go nowhere.

let store: BrowsingStore | undefined;

export const startBrowsingFeed = (target: BrowsingStore | undefined): void => {
    store = target;
};

// The address last recorded for each tab, by the daemon's own record of the tab.
const recorded = new WeakMap<object, string>();

// Chromium's transition types (Page.TransitionType), by what they make of a visit.
const TYPED: ReadonlySet<string> = new Set(["typed", "address_bar", "generated", "keyword", "keyword_generated"]);

// The one DevTools call the feed makes, which a tab's own CDP session answers.
export interface NavigationHistoryReader {
    send(method: "Page.getNavigationHistory"): Promise<{ readonly currentIndex: number; readonly entries: readonly { readonly transitionType: string }[] }>;
}

const transitionOf = async (cdp: NavigationHistoryReader | undefined): Promise<VisitKind> => {
    if (cdp === undefined) {
        return "link";
    }
    try {
        const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
        const type = entries[currentIndex]?.transitionType;
        return type === undefined ? "link" : TYPED.has(type) ? "typed" : type === "reload" ? "reload" : "link";
    } catch {
        // allow(silent-catch): a tab closed or gone elsewhere mid-read still went where it went; a link is the safe guess.
        return "link";
    }
};

export interface ObservedTab {
    readonly url: string;
    readonly title: string | undefined;
    readonly cdp: NavigationHistoryReader | undefined;
}

/** One tab of a window on `profile` as it stands now; called on every re-read, so it is cheap when nothing moved. */
export const noteBrowsing = (profile: string, tab: ObservedTab): void => {
    const target = store;
    if (target === undefined) {
        return;
    }
    if (recorded.get(tab) !== tab.url) {
        recorded.set(tab, tab.url);
        const { url, title } = tab;
        void transitionOf(tab.cdp).then((kind) => target.visit(profile, url, kind, title));
        return;
    }
    if (tab.title !== undefined) {
        target.retitle(profile, tab.url, tab.title);
    }
};
