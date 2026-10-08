import type { BrowserSession, OpenBrowserResult } from "@intentic/sandbox-contract";
import { FEATURED_AGENT_ID } from "./fixture/fleet";
import { checkoutPage, DOC_STEPS, docsPage, pricingPage, visitedPage } from "./fixture/storefront";
import type { DemoSession, DemoSocket } from "./transport";

// Recorded browser session for the demo. `/system/browser-view` carries binary frames (one format byte, then the
// image); a stream of drawn SVGs looks like a real screencast to the <img> view. `bind` from the view plays that page's
// loop; an unbound stream follows the agent.

const FRAME_MS = 900;

export const BROWSER_SESSIONS = (now: number): BrowserSession[] => [
    {
        name: `browser-checkout-stripe`,
        label: `Checkout · acme`,
        server: `web`,
        // The featured turn's: while it runs, the visitor watches and takes over rather than clicking straight in.
        owner: FEATURED_AGENT_ID,
        running: true,
        activityAt: now - 4_000,
        pages: [
            { id: `page_pricing`, title: `Pricing · acme`, url: `https://acme-shop.test/pricing`, active: false },
            { id: `page_checkout`, title: `Checkout · acme`, url: `https://checkout.stripe.com/c/pay/cs_test_a1F9k2`, active: true },
            { id: `page_docs`, title: `Checkout Sessions | Stripe API`, url: `https://docs.stripe.com/api/checkout/sessions`, active: false },
        ],
    },
    {
        name: `browser-flaky-signup`,
        label: `Sign up · acme`,
        server: `web`,
        running: false,
        activityAt: now - 22 * 60_000,
        finishedAt: now - 20 * 60_000,
        pages: [{ id: `page_signup`, title: `Sign up · acme`, url: `https://acme-shop.test/signup`, active: true }],
    },
];

// The visitor's own window: opened from the view, driven by their own clicks, and like the real one never an agent's.
// The demo loads nothing, so a tab is its address and a drawing of it (visitedPage); everything a browser does to its
// tabs (open, close, go somewhere) happens to this record and is pushed as a `browsers` change, as the daemon pushes.
export const OWN_SESSION = `browser-own`;

interface OwnTab {
    readonly id: string;
    url: string;
    title: string | undefined;
}

const own = { running: false, tabs: [] as OwnTab[], active: undefined as string | undefined, next: 1 };
const ownWatchers = new Set<() => void>();

/** Called on every change to the visitor's window, so the daemon can push a `browsers` refresh. */
export const watchOwnBrowser = (watcher: () => void): void => {
    ownWatchers.add(watcher);
};

const ownChanged = (): void => {
    for (const watcher of ownWatchers) {
        watcher();
    }
};

const titleOf = (url: string): string | undefined => {
    if (url === `` || url === `about:blank`) {
        return undefined;
    }
    try {
        const parsed = new URL(url);
        const query = parsed.host === `duckduckgo.com` ? parsed.searchParams.get(`q`) : null;
        return query === null ? parsed.host : `${query} at DuckDuckGo`;
    } catch {
        return url;
    }
};

const ownTab = (url: string | undefined): OwnTab => {
    const tab = { id: `own_${own.next}`, url: url ?? `about:blank`, title: titleOf(url ?? ``) };
    own.next += 1;
    own.tabs.push(tab);
    own.active = tab.id;
    return tab;
};

/** POST /system/browsers: a tab in the visitor's window, starting it first. */
export const openOwnBrowser = (url: string | undefined): OpenBrowserResult => {
    if (!own.running) {
        own.running = true;
        own.tabs = [];
    }
    const tab = ownTab(url);
    ownChanged();
    return { name: OWN_SESSION, pageId: tab.id };
};

/** Closing the visitor's window from its menu: gone, tabs and all. */
export const closeOwnBrowser = (): void => {
    own.running = false;
    own.tabs = [];
    own.active = undefined;
    ownChanged();
};

/** One tab of the visitor's window closed, over its socket or from the strip while another window is in front. */
export const closeOwnTab = (pageId: string): void => {
    const at = own.tabs.findIndex((tab) => tab.id === pageId);
    own.tabs = own.tabs.filter((tab) => tab.id !== pageId);
    if (own.active === pageId) {
        own.active = (own.tabs[at] ?? own.tabs[at - 1])?.id;
    }
    ownChanged();
};

export const ownSession = (now: number): BrowserSession | undefined =>
    own.running
        ? {
              name: OWN_SESSION,
              label: own.tabs.find((tab) => tab.id === own.active)?.title ?? `Your browser`,
              server: `_own`,
              own: true,
              running: true,
              activityAt: now,
              pages: own.tabs.map((tab) => ({
                  id: tab.id,
                  url: tab.url,
                  active: tab.id === own.active,
                  ...(tab.title === undefined ? {} : { title: tab.title }),
              })),
          }
        : undefined;

// The visitor's window on its socket: one page painted at a time, the active one, and every tab verb answered here.
const ownBrowserSession: DemoSession = (socket: DemoSocket) => {
    const paint = (): void => {
        const tab = own.tabs.find((candidate) => candidate.id === own.active);
        socket.emit(encode(visitedPage(tab?.url ?? ``)));
    };
    socket.emit(JSON.stringify({ type: `ready`, kind: `frames`, width: 1280, height: 800 }));
    paint();
    const repaint = (): void => paint();
    ownWatchers.add(repaint);
    socket.addEventListener(`client`, (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { type?: string; pageId?: string; url?: string };
        const active = own.tabs.find((tab) => tab.id === own.active);
        if (message.type === `bind` && message.pageId !== undefined) {
            if (!own.tabs.some((tab) => tab.id === message.pageId)) {
                socket.emit(JSON.stringify({ type: `gone`, pageId: message.pageId }));
                return;
            }
            own.active = message.pageId;
            ownChanged();
        } else if (message.type === `newTab`) {
            ownTab(message.url);
            ownChanged();
        } else if (message.type === `closeTab` && message.pageId !== undefined) {
            closeOwnTab(message.pageId);
        } else if (message.type === `navigate` && message.url !== undefined && active !== undefined) {
            active.url = message.url;
            active.title = titleOf(message.url);
            ownChanged();
        }
    });
    socket.addEventListener(`close`, () => ownWatchers.delete(repaint));
};

const LOOPS: Record<string, (step: number) => string> = {
    page_pricing: pricingPage,
    page_checkout: checkoutPage,
    page_docs: docsPage,
};

const STEPS: Record<string, number> = { page_pricing: 4, page_checkout: 4, page_docs: DOC_STEPS };

// Page an unbound stream follows: the one the agent is driving.
const FOLLOWING = `page_checkout`;

// Format byte for a drawn SVG frame; binary like the real stream, not base64.
const FRAME_SVG = 2;

const encode = (svg: string): ArrayBuffer => {
    const body = new TextEncoder().encode(svg);
    const wire = new Uint8Array(body.byteLength + 1);
    wire[0] = FRAME_SVG;
    wire.set(body, 1);
    return wire.buffer;
};

/** Recorded screencast played on the socket the Browsers view opened; the visitor's own window answers live. */
export const browserSession: DemoSession = (socket: DemoSocket) => {
    if (new URL(socket.url).searchParams.get(`session`) === OWN_SESSION) {
        ownBrowserSession(socket);
        return;
    }
    let pageId = FOLLOWING;
    let step = 0;
    let timer: number | undefined;

    const paint = (): void => {
        const draw = LOOPS[pageId] ?? LOOPS[FOLLOWING];
        socket.emit(encode(draw!(step)));
        step = (step + 1) % (STEPS[pageId] ?? 1);
    };

    const play = (): void => {
        window.clearInterval(timer);
        timer = window.setInterval(paint, FRAME_MS);
    };

    // `kind: frames` stops the view building a video decoder; width/height are the storefront fixture's own.
    socket.emit(JSON.stringify({ type: `ready`, kind: `frames`, width: 1280, height: 800 }));
    paint();
    play();

    socket.addEventListener(`client`, (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { type?: string; pageId?: string };
        if (message.type === `bind` && message.pageId !== undefined) {
            // Unknown page answers `gone`; the view drops the pin and follows the agent again, as for a closed tab.
            if (LOOPS[message.pageId] === undefined) {
                socket.emit(JSON.stringify({ type: `gone`, pageId: message.pageId }));
                return;
            }
            pageId = message.pageId;
            step = 0;
            paint();
            return;
        }
        // Nobody is looking (background tab, hidden route): stop drawing, resume where it left off.
        if (message.type === `pause`) {
            window.clearInterval(timer);
        }
        if (message.type === `resume`) {
            play();
        }
    });

    socket.addEventListener(`close`, () => window.clearInterval(timer));
};
