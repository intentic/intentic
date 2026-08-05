import type { BrowserSession } from "@intentic/sandbox-contract";
import { checkoutPage, DOC_STEPS, docsPage, pricingPage } from "./fixture/storefront";
import type { DemoSession, DemoSocket } from "./transport";

/* THE AGENT'S BROWSER, RECORDED. `/system/browser-view` is a WebSocket of JSON frames whose `data` is a
 * base64 image, and the view is an <img> pointed at whatever the last frame carried — so a stream of drawn
 * frames is, to that view, indistinguishable from a Chromium screencast. This is the checkout agent verifying
 * its own work: it opens the pricing page, presses the CTA it just wired, and watches the Stripe session it
 * created come back.
 *
 * The pages themselves are fixture/storefront.ts — the recorded product's screens, shared with the screenshots
 * an acceptance run's report carries, because those are pictures of the same three pages. `format` rides each
 * frame (screencast.ts switches between jpeg and webp for real), so `svg+xml` needs no cooperation from the
 * client.
 *
 * The page tabs work: the view sends `bind` when the visitor clicks one, this answers by playing THAT page's
 * loop, and an unbound stream follows the agent — the same contract the daemon's screencast has. */

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

// The page an unbound stream follows — the one the agent is driving, which is the one the roster marks active.
const FOLLOWING = `page_checkout`;

const encode = (svg: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(svg)));

/** The recorded screencast, played on the socket the Browsers view just opened. */
export const browserSession: DemoSession = (socket: DemoSocket) => {
    let pageId = FOLLOWING;
    let step = 0;
    let timer: number | undefined;

    const paint = (): void => {
        const draw = LOOPS[pageId] ?? LOOPS[FOLLOWING];
        socket.emit(JSON.stringify({ type: `frame`, format: `svg+xml`, data: encode(draw!(step)), pageId }));
        step = (step + 1) % (STEPS[pageId] ?? 1);
    };

    const play = (): void => {
        window.clearInterval(timer);
        timer = window.setInterval(paint, FRAME_MS);
    };

    socket.emit(JSON.stringify({ type: `ready` }));
    paint();
    play();

    socket.addEventListener(`client`, (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { type?: string; pageId?: string };
        if (message.type === `bind` && message.pageId !== undefined) {
            // A page the recording doesn't carry answers `gone`, which is what the view's own strip does with a
            // tab that closed between the relist and the click: drop the pin and follow the agent again.
            if (LOOPS[message.pageId] === undefined) {
                socket.emit(JSON.stringify({ type: `gone`, pageId: message.pageId }));
                return;
            }
            pageId = message.pageId;
            step = 0;
            paint();
            return;
        }
        // Nobody is looking (a background tab, or the view behind another route): stop drawing, resume where the
        // page left off. The real daemon holds the binding across the same pause.
        if (message.type === `pause`) {
            window.clearInterval(timer);
        }
        if (message.type === `resume`) {
            play();
        }
    });

    socket.addEventListener(`close`, () => window.clearInterval(timer));
};
