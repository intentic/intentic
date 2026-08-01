import type { BrowserSession } from "@intentic/sandbox-contract";
import type { DemoSession, DemoSocket } from "./transport";

/* THE AGENT'S BROWSER, RECORDED. `/system/browser-view` is a WebSocket of JSON frames whose `data` is a
 * base64 image, and the view is an <img> pointed at whatever the last frame carried — so a stream of drawn
 * frames is, to that view, indistinguishable from a Chromium screencast. This is the checkout agent verifying
 * its own work: it opens the pricing page, presses the CTA it just wired, and watches the Stripe session it
 * created come back.
 *
 * The frames are SVG rather than captured PNGs, which is the whole reason this is affordable: three pages of
 * plausible product UI cost a few kilobytes of markup, weigh nothing in the bundle, and stay legible at any
 * size the overlay gives them. `format` rides each frame (screencast.ts switches between jpeg and webp for
 * real), so `svg+xml` needs no cooperation from the client.
 *
 * The page tabs work: the view sends `bind` when the visitor clicks one, this answers by playing THAT page's
 * loop, and an unbound stream follows the agent — the same contract the daemon's screencast has. */

const WIDTH = 1280;
const HEIGHT = 800;
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

// ---- the drawing kit ----------------------------------------------------------------------------------------
// Small on purpose: a page is a background, some blocks of text, a few cards and one cursor. Anything more and
// this stops being a fixture and starts being a rendering engine.

const escape = (text: string): string => text.replaceAll(`&`, `&amp;`).replaceAll(`<`, `&lt;`).replaceAll(`>`, `&gt;`);

const text = (x: number, y: number, body: string, options: { size?: number; fill?: string; weight?: number; anchor?: string } = {}): string =>
    `<text x="${x}" y="${y}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${options.size ?? 16}" font-weight="${options.weight ?? 400}" fill="${options.fill ?? `#1b1a19`}" text-anchor="${options.anchor ?? `start`}">${escape(body)}</text>`;

const box = (x: number, y: number, width: number, height: number, fill: string, radius = 12, stroke = `none`): string =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" />`;

// The pointer the agent is driving. Drawn by the fixture because a screencast carries the real one in its
// pixels — without it the page just changes by itself, which reads as a video rather than as something acting.
const cursor = (x: number, y: number): string =>
    `<g transform="translate(${x} ${y})"><path d="M0 0 L0 18 L5 14 L8 21 L11 20 L8 13 L14 13 Z" fill="#111" stroke="#fff" stroke-width="1.2" /></g>`;

const page = (body: string, background = `#ffffff`): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${background}" />${body}</svg>`;

const siteHeader = (active: string): string =>
    `${box(0, 0, WIDTH, 64, `#faf9f8`)}${box(0, 63, WIDTH, 1, `#e6e3e0`, 0)}${text(48, 40, `acme`, { size: 22, weight: 700, fill: `#e2582a` })}${text(
        180,
        40,
        `Shop`,
        { size: 15, fill: active === `shop` ? `#1b1a19` : `#6c6862` },
    )}${text(250, 40, `Pricing`, { size: 15, weight: active === `pricing` ? 600 : 400, fill: active === `pricing` ? `#1b1a19` : `#6c6862` })}${text(
        340,
        40,
        `Docs`,
        { size: 15, fill: `#6c6862` },
    )}`;

const planCard = (x: number, name: string, price: string, highlight: boolean): string =>
    `${box(x, 260, 300, 340, `#ffffff`, 16, highlight ? `#e2582a` : `#e6e3e0`)}${text(x + 32, 310, name, { size: 18, weight: 600 })}${text(
        x + 32,
        368,
        price,
        { size: 34, weight: 700 },
    )}${text(x + 32, 400, `per month`, { size: 14, fill: `#6c6862` })}${[`Unlimited orders`, `Stripe payouts`, `Priority support`]
        .map((feature, index) => text(x + 32, 448 + index * 30, `· ${feature}`, { size: 14, fill: `#4a4744` }))
        .join(``)}`;

// ---- the pricing page: the CTA the agent just wired ----------------------------------------------------------

// Inside the highlighted plan card (378 + its 32px padding), which is where the CTA the agent just wired sits.
const CTA_X = 410;
const CTA_Y = 530;

const pricingPage = (step: number): string => {
    const pressed = step >= 2;
    const cta = `${box(CTA_X, CTA_Y, 236, 46, pressed ? `#c94a20` : `#e2582a`)}${text(CTA_X + 118, CTA_Y + 29, step >= 3 ? `Redirecting…` : `Start free trial`, {
        size: 15,
        weight: 600,
        fill: `#fff`,
        anchor: `middle`,
    })}`;
    const spinner = step >= 3 ? `<circle cx="${CTA_X + 30}" cy="${CTA_Y + 23}" r="8" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="12 8" />` : ``;
    const pointer = cursor(step === 0 ? 900 : step === 1 ? CTA_X + 150 : CTA_X + 118, step === 0 ? 640 : step === 1 ? CTA_Y + 60 : CTA_Y + 24);
    return page(
        `${siteHeader(`pricing`)}${text(48, 160, `Plans that grow with your shop`, { size: 34, weight: 700 })}${text(
            48,
            196,
            `Every plan includes the storefront, the API and unlimited products.`,
            { size: 16, fill: `#6c6862` },
        )}${planCard(48, `Starter`, `$0`, false)}${planCard(378, `Growth`, `$49`, true)}${planCard(708, `Scale`, `$149`, false)}${cta}${spinner}${pointer}`,
    );
};

// ---- the Stripe checkout the session created ------------------------------------------------------------------

const checkoutPage = (step: number): string => {
    const typed = [``, `4242 4242 4242 4242`, `4242 4242 4242 4242`, `4242 4242 4242 4242`][step] ?? ``;
    const paying = step >= 3;
    return page(
        `${box(0, 0, 640, HEIGHT, `#f6f9fc`)}${text(80, 96, `acme`, { size: 20, weight: 700, fill: `#e2582a` })}${text(80, 168, `Subscribe to Growth`, {
            size: 15,
            fill: `#4a4744`,
        })}${text(80, 216, `$49.00`, { size: 40, weight: 700 })}${text(80, 246, `per month`, { size: 14, fill: `#6c6862` })}${box(
            80,
            300,
            480,
            1,
            `#dfe6ee`,
            0,
        )}${text(80, 340, `Growth plan`, { size: 15 })}${text(540, 340, `$49.00`, { size: 15, anchor: `end` })}${text(80, 380, `Billed monthly`, {
            size: 13,
            fill: `#6c6862`,
        })}${text(760, 120, `Pay with card`, { size: 20, weight: 600 })}${text(760, 176, `Email`, { size: 13, fill: `#6c6862` })}${box(
            760,
            190,
            420,
            44,
            `#ffffff`,
            8,
            `#dfe6ee`,
        )}${text(776, 218, `ada@acme.dev`, { size: 15, fill: `#1b1a19` })}${text(760, 268, `Card information`, { size: 13, fill: `#6c6862` })}${box(
            760,
            282,
            420,
            44,
            `#ffffff`,
            8,
            step === 1 ? `#635bff` : `#dfe6ee`,
        )}${text(776, 310, typed === `` ? `1234 1234 1234 1234` : typed, { size: 15, fill: typed === `` ? `#a3acb9` : `#1b1a19` })}${box(
            760,
            370,
            420,
            46,
            paying ? `#4b45c6` : `#635bff`,
            8,
        )}${text(970, 399, paying ? `Processing…` : `Subscribe`, { size: 15, weight: 600, fill: `#fff`, anchor: `middle` })}${text(
            760,
            440,
            `Test mode · no card is charged`,
            { size: 12, fill: `#8792a2` },
        )}${cursor(step === 0 ? 1_000 : step === 1 ? 800 : 970, step === 0 ? 500 : step === 1 ? 300 : 395)}`,
        `#ffffff`,
    );
};

// ---- the docs page the agent read the contract off -------------------------------------------------------------

const DOC_LINES = [
    `POST /v1/checkout/sessions`,
    ``,
    `line_items[0][price]   The ID of the price object.`,
    `line_items[0][quantity]   The quantity of the line item.`,
    `mode   payment | setup | subscription`,
    `success_url   The URL to redirect after payment.`,
    `cancel_url   The URL to redirect on cancel.`,
];

const docsPage = (step: number): string =>
    page(
        `${box(0, 0, WIDTH, 60, `#0a2540`)}${text(48, 38, `Stripe API reference`, { size: 17, weight: 600, fill: `#ffffff` })}${text(
            48,
            120,
            `Create a Checkout Session`,
            { size: 30, weight: 700 },
        )}${box(48, 150, 760, 1, `#e6e3e0`, 0)}${DOC_LINES.map((line, index) =>
            text(48, 196 + index * 34, line, { size: 15, fill: index === 0 ? `#635bff` : `#4a4744`, weight: index === 0 ? 600 : 400 }),
        ).join(``)}${box(860, 180, 380, 300, `#f6f9fc`, 12, `#dfe6ee`)}${text(884, 216, `RESPONSE`, { size: 12, weight: 600, fill: `#6c6862` })}${[
            `{`,
            `  "id": "cs_test_a1F9k2",`,
            `  "url": "https://checkout…",`,
            `  "mode": "subscription",`,
            `  "status": "open"`,
            `}`,
        ]
            .map((line, index) => text(884, 250 + index * 26, line, { size: 13, fill: `#0a2540` }))
            .join(``)}${box(48, 196 + step * 34 - 20, 700, 26, `#fff4d6`, 4)}${DOC_LINES.map((line, index) =>
            index === step ? text(48, 196 + index * 34, line, { size: 15, weight: 600, fill: `#1b1a19` }) : ``,
        ).join(``)}${cursor(700, 196 + step * 34)}`,
    );

const LOOPS: Record<string, (step: number) => string> = {
    page_pricing: pricingPage,
    page_checkout: checkoutPage,
    page_docs: docsPage,
};

const STEPS: Record<string, number> = { page_pricing: 4, page_checkout: 4, page_docs: DOC_LINES.length };

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
