import type { BrowserSession } from "@intentic/sandbox-contract";
import { checkoutPage, DOC_STEPS, docsPage, pricingPage } from "./fixture/storefront";
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

/** Recorded screencast played on the socket the Browsers view opened. */
export const browserSession: DemoSession = (socket: DemoSocket) => {
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
