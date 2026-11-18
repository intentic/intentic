import type { CDPSession, Page, Request } from "playwright";

// What a tab is doing between two addresses: the part of a browser's own chrome the picture crops away (region.ts keeps
// the page's viewport alone). Chromium draws a turning tab, a stop button and "Waiting for host…" while a navigation is
// in flight; without them, a click that sent the page to an address that never answers looked like a click that did
// nothing, for as long as the connection took to time out (2026-11-18, an OIDC sign-in waiting on a host behind a VPN).
// The roster carries this per tab (browser-sessions.ts summarizePage), and the view draws it as a browser would.
//
// The transitions are pure over a mutable state, so they read without a Chromium; watchNavigation and watchLoading wire
// them to Playwright's page events and to the page's own DevTools session.

// Chromium's error page: what a page reports as its address once a navigation failed and it shows why.
const ERROR_PAGE_PREFIX = "chrome-error://";

// A navigation that was called off (the stop button, another navigation taking its place, a response that became a
// download) rather than one that failed: nothing to tell anyone.
const ABORTED = "net::ERR_ABORTED";

// R is Playwright's Request in the daemon; the transitions only ever compare one by identity.
export interface PendingNavigation<R = Request> {
    // The request of the current hop, held by identity: the next hop of a redirect names it as where it came from.
    readonly request: R;
    // The address the current hop is fetching; each redirect hop replaces it.
    readonly url: string;
    // When the navigation set off: its first hop, kept through every redirect.
    readonly since: number;
}

export interface NavigationState<R = Request> {
    // Chromium's own loading flag for the main frame, the one its tab spinner follows.
    loading: boolean;
    // A main-frame navigation in flight that has not committed yet.
    pending: PendingNavigation<R> | undefined;
    // The last main-frame navigation that failed with a reason, while the page may be showing the error page for it.
    failed: { readonly url: string; readonly error: string } | undefined;
}

export const freshNavigation = <R = Request>(): NavigationState<R> => ({ loading: false, pending: undefined, failed: undefined });

/** A main-frame navigation request went out: the first hop of a navigation, or the next hop of a redirect. */
export const navigationStarted = <R>(state: NavigationState<R>, request: R, url: string, redirectedFrom: R | null, now: number): void => {
    const sameNavigation = state.pending !== undefined && redirectedFrom !== null && state.pending.request === redirectedFrom;
    state.pending = { request, url, since: sameNavigation && state.pending !== undefined ? state.pending.since : now };
};

/** The request of the navigation in flight failed; answers whether that changed anything. */
export const navigationFailed = <R>(state: NavigationState<R>, request: R, url: string, error: string | undefined): boolean => {
    if (state.pending?.request !== request) {
        return false;
    }
    state.pending = undefined;
    if (error !== undefined && error !== "" && error !== ABORTED) {
        state.failed = { url, error };
    }
    return true;
};

/** The main frame committed an address: nothing is in flight any more, and a page past an error page is past its error. */
export const navigationCommitted = <R>(state: NavigationState<R>, url: string): void => {
    state.pending = undefined;
    if (!url.startsWith(ERROR_PAGE_PREFIX)) {
        state.failed = undefined;
    }
};

/** Chromium started or stopped loading the main frame; answers whether that changed anything. */
export const loadingChanged = <R>(state: NavigationState<R>, loading: boolean): boolean => {
    // Stopped is stopped: a response that committed nothing (a 204, a download) or the stop button leaves nothing in
    // flight, and no other event says so.
    const changed = state.loading !== loading || (!loading && state.pending !== undefined);
    state.loading = loading;
    if (!loading) {
        state.pending = undefined;
    }
    return changed;
};

export interface NavigationFields {
    url: string;
    loading?: true;
    navigation?: { readonly url: string; readonly since: number };
    error?: string;
}

// What the roster says of a tab, from the address it reports and the state above. On Chromium's error page the address
// is the one that failed, as a browser's address bar keeps it, and `error` is why; anywhere else there is no error to
// tell, whatever failed before.
export const navigationFields = <R>(state: NavigationState<R>, url: string): NavigationFields => {
    const failed = url.startsWith(ERROR_PAGE_PREFIX) ? state.failed : undefined;
    const fields: NavigationFields = { url: failed?.url ?? url };
    if (state.loading || state.pending !== undefined) {
        fields.loading = true;
    }
    if (state.pending !== undefined) {
        fields.navigation = { url: state.pending.url, since: state.pending.since };
    }
    if (failed !== undefined) {
        fields.error = failed.error;
    }
    return fields;
};

// Whether a request is the page's own main-frame navigation; a service worker's request has no frame and throws.
const isMainNavigation = (page: Page, request: Request): boolean => {
    try {
        return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
        // allow(silent-catch): Playwright throws for a request with no frame (a service worker's) rather than answering
        // null, and such a request is no page's navigation.
        return false;
    }
};

/**
 * Follows a page's main-frame navigations through Playwright's network events: each hop as it goes out, and a failure
 * with Chromium's reason. The commit is the caller's (it already listens for `framenavigated`).
 */
export const watchNavigation = (page: Page, state: NavigationState, changed: () => void): void => {
    page.on("request", (request) => {
        if (isMainNavigation(page, request)) {
            navigationStarted(state, request, request.url(), request.redirectedFrom(), Date.now());
            changed();
        }
    });
    page.on("requestfailed", (request) => {
        if (navigationFailed(state, request, request.url(), request.failure()?.errorText)) {
            changed();
        }
    });
    // Belt and braces for the DevTools session's stop event, which a session that failed to attach never sends.
    page.on("load", () => {
        if (loadingChanged(state, false)) {
            changed();
        }
    });
    page.on("crash", () => {
        if (loadingChanged(state, false)) {
            changed();
        }
    });
};

interface FrameEvent {
    readonly frameId: string;
}

/**
 * Follows Chromium's own loading flag for the page's main frame over the page's DevTools session, which the caller has
 * opened and enables the Page domain on. Subframes are left out: an embed that never finishes would keep the tab
 * turning.
 */
export const watchLoading = async (session: CDPSession, state: NavigationState, changed: () => void): Promise<void> => {
    // A page target's main frame keeps its id across every navigation, cross-process ones included.
    // allow(silent-catch): a page closed before its frame tree was read has no loading left to follow; the page's own
    // load and crash events (watchNavigation) still bring its tab to rest.
    const tree = await session.send("Page.getFrameTree").catch(() => undefined);
    const main = tree?.frameTree.frame.id;
    if (main === undefined) {
        return;
    }
    const on = (loading: boolean) => (event: FrameEvent) => {
        if (event.frameId === main && loadingChanged(state, loading)) {
            changed();
        }
    };
    session.on("Page.frameStartedLoading", on(true));
    session.on("Page.frameStoppedLoading", on(false));
};

/**
 * The stop button's own call: every navigation in flight and every fetch, a navigation that has not committed yet
 * included, which `window.stop()` run in the page being left cannot reach. That page's own stop is the fallback for a
 * session that will not open.
 */
export const stopLoading = async (page: Page): Promise<void> => {
    let session: CDPSession;
    try {
        session = await page.context().newCDPSession(page);
    } catch {
        await page.evaluate(() => window.stop());
        return;
    }
    try {
        await session.send("Page.stopLoading");
    } finally {
        // allow(silent-catch): a page closed under the call has no session left to detach
        await session.detach().catch(() => undefined);
    }
};
