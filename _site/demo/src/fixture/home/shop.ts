import { STATE_DIR } from "@intentic/constants";
import { act, ask, closing, type HomeStory, opening, said, say, text } from "./story";

// THE SHOP'S HOME: the owner asks for the checkout to be checked, and the agent walks it in the browser, finds Germany
// shipping free, fixes the rate table, tests it, pays with a test card and puts the fix live once the owner says so.
// It opens where the landing page's poster stops (_site/site/src/assets/product/hero-home.png): the first two rows are
// the history, the last two the turn this plays, and the work starts a moment after the poster's last line.

export const SHIPPING_PATH = `web/src/checkout/shipping.ts`;

const SHIPPING_BEFORE = `// What an order pays to ship, by the country it goes to.
export const SHIPPING_RATES: Record<string, number> = {
    PL: 4.9,
    CZ: 5.9,
    AT: 6.9,
    NL: 6.9,
};

// A country missing from the table ships free.
export const shippingFor = (country: string): number => SHIPPING_RATES[country] ?? 0;
`;

export const SHIPPING_AFTER = `// What an order pays to ship, by the country it goes to.
export const SHIPPING_RATES: Record<string, number> = {
    PL: 4.9,
    CZ: 5.9,
    AT: 6.9,
    DE: 6.9,
    NL: 6.9,
};

// A country missing from the table ships free.
export const shippingFor = (country: string): number => SHIPPING_RATES[country] ?? 0;
`;

export const CHECKOUT_SHOT_PATH = `${STATE_DIR}/records/artifacts/browser/checkout-shipping-de.svg`;

// The order summary as the browser saw it: shipping to Germany at €0.00, ringed.
export const CHECKOUT_SHOT = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="560" viewBox="0 0 1200 560">
  <rect width="1200" height="560" rx="22" fill="#f6f4f1"/>
  <rect x="0" y="0" width="1200" height="52" rx="22" fill="#ebe7e1"/>
  <rect x="0" y="30" width="1200" height="22" fill="#ebe7e1"/>
  <circle cx="30" cy="26" r="6" fill="#ff6a5f"/><circle cx="50" cy="26" r="6" fill="#f6bd4f"/><circle cx="70" cy="26" r="6" fill="#4cc56a"/>
  <rect x="210" y="12" width="780" height="28" rx="9" fill="#fff"/>
  <g font-family="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">
    <text x="232" y="31" font-size="14" fill="#6f6a63">acme-shop.com/checkout</text>
    <text x="64" y="112" font-size="26" font-weight="700" fill="#2b2622">Checkout</text>
    <text x="64" y="160" font-size="14" font-weight="600" fill="#6f6a63">SHIP TO</text>
    <rect x="64" y="174" width="560" height="46" rx="10" fill="#fff" stroke="#ddd6cc"/>
    <text x="84" y="203" font-size="16" fill="#2b2622">Guest · Torstraße 101, 10119 Berlin</text>
    <rect x="64" y="232" width="560" height="46" rx="10" fill="#fff" stroke="#ddd6cc"/>
    <text x="84" y="261" font-size="16" fill="#2b2622">Germany</text>
    <path d="M598 251l7 7 7-7" fill="none" stroke="#8b847b" stroke-width="2" stroke-linecap="round"/>
    <text x="64" y="324" font-size="14" font-weight="600" fill="#6f6a63">PAYMENT</text>
    <rect x="64" y="338" width="560" height="46" rx="10" fill="#fff" stroke="#ddd6cc"/>
    <text x="84" y="367" font-size="16" fill="#2b2622">Test card ending 4242</text>
    <rect x="64" y="410" width="560" height="54" rx="12" fill="#2b2622"/>
    <text x="344" y="443" text-anchor="middle" font-size="17" font-weight="700" fill="#fff">Pay €38.00</text>

    <rect x="690" y="88" width="446" height="376" rx="16" fill="#fff" stroke="#e4ded5"/>
    <text x="718" y="130" font-size="18" font-weight="700" fill="#2b2622">Order summary</text>
    <rect x="718" y="152" width="64" height="64" rx="10" fill="#e9dfd2"/>
    <path d="M736 168h28l3 34h-34z" fill="#c9a985"/>
    <text x="798" y="178" font-size="16" font-weight="600" fill="#2b2622">Linen apron</text>
    <text x="798" y="202" font-size="14" fill="#8b847b">Natural · 1 ×</text>
    <text x="1108" y="190" text-anchor="end" font-size="16" fill="#2b2622">€38.00</text>
    <line x1="718" y1="240" x2="1108" y2="240" stroke="#eee8df"/>
    <text x="718" y="276" font-size="16" fill="#6f6a63">Subtotal</text>
    <text x="1108" y="276" text-anchor="end" font-size="16" fill="#2b2622">€38.00</text>
    <rect x="706" y="292" width="414" height="44" rx="10" fill="#fdecea" stroke="#e5484d" stroke-width="2.5"/>
    <text x="718" y="320" font-size="16" fill="#b4232a">Shipping to Germany</text>
    <text x="1108" y="320" text-anchor="end" font-size="16" font-weight="700" fill="#b4232a">€0.00</text>
    <line x1="718" y1="356" x2="1108" y2="356" stroke="#eee8df"/>
    <text x="718" y="396" font-size="18" font-weight="700" fill="#2b2622">Total</text>
    <text x="1108" y="396" text-anchor="end" font-size="18" font-weight="700" fill="#2b2622">€38.00</text>
    <text x="718" y="440" font-size="13" fill="#b4232a">Expected €6.90 for Germany</text>
  </g>
</svg>`;

export const SHOP: HomeStory = {
    history: [
        { role: `user`, text: `Morning. What should I focus on in the shop today?` },
        {
            role: `assistant`,
            text: `Morning! Three things are ready for a look:\n\n- **The new checkout** is ready to test.\n- **Friday's newsletter** needs a final read.\n- **Two customer questions** are waiting for a reply.\n\nI'd start with checkout, so customers can use it this week.`,
        },
    ],
    prompt: `Let's do that. Check the checkout flow and tell me if anything needs fixing.`,
    beats: [
        opening(),
        ...said(
            `I'll walk through it in the browser, from the product page to the order confirmation. Then I'll bring you a short report with anything that needs your attention.`,
        ),
        // Long enough after the poster's last line that the poster (capture.mts `hero-home`) is taken before any step starts.
        ...act(3_000, {
            id: `tc_shop_open`,
            name: `Browser navigate`,
            category: `fetch`,
            target: `acme-shop.com/products/linen-apron`,
            takes: 1_300,
            result: text(`Linen apron, natural · €38.00 · in stock`),
        }),
        ...act(300, { id: `tc_shop_cart`, name: `Browser click`, category: `other`, target: `Add to cart`, takes: 900, result: text(`Cart: 1 item, €38.00`) }),
        ...act(400, {
            id: `tc_shop_guest`,
            name: `Browser type`,
            category: `other`,
            target: `Guest checkout · Torstraße 101, Berlin, Germany`,
            takes: 1_400,
        }),
        ...act(200, {
            id: `tc_shop_summary`,
            name: `Browser take screenshot`,
            category: `other`,
            target: `Order summary`,
            takes: 700,
            result: [{ type: `image`, path: CHECKOUT_SHOT_PATH }],
        }),
        ...say(
            600,
            `Found one: **shipping to Germany shows €0.00**. Germany is missing from the rate table, and a missing country ships free. Fixing that before I go on.`,
        ),
        ...act(500, {
            id: `tc_shop_read`,
            name: `Read`,
            category: `read`,
            target: SHIPPING_PATH,
            path: SHIPPING_PATH,
            takes: 700,
            result: text(`11 lines · rates for PL, CZ, AT and NL, no DE`),
        }),
        ...act(300, {
            id: `tc_shop_fix`,
            name: `Edit`,
            category: `edit`,
            target: SHIPPING_PATH,
            path: SHIPPING_PATH,
            takes: 1_000,
            result: [{ type: `diff`, path: SHIPPING_PATH, oldText: SHIPPING_BEFORE, newText: SHIPPING_AFTER }],
        }),
        ...act(300, {
            id: `tc_shop_test`,
            name: `Bash`,
            category: `execute`,
            target: `pnpm -C web test shipping`,
            takes: 1_700,
            result: text(`✓ web/tests/shipping.spec.ts (9)\n\nTest Files  1 passed (1)\n     Tests  9 passed (9)\n  Duration  1.32s`),
        }),
        ...act(400, {
            id: `tc_shop_pay`,
            name: `Browser click`,
            category: `other`,
            target: `Pay €44.90 · test card 4242`,
            takes: 1_600,
            result: text(`Order #1042 placed · shipping €6.90 · total €44.90`),
        }),
        ...act(400, {
            id: `tc_shop_mail`,
            name: `Inbox`,
            category: `fetch`,
            target: `"Your order #1042" in the test inbox`,
            takes: 1_200,
            result: text(`Arrived after 4 seconds, with the right total and a tracking link.`),
        }),
        ...say(500, `Everything else works. The fix is tested and ready.`),
        ask(400, `ask_shop_live`, `Go live`, `Put the shipping fix live on the shop now?`, [
            { label: `Put it live now (Recommended)`, description: `Orders to Germany pay €6.90 again from the next one.` },
            {
                label: `Wait for tonight`,
                description: `It goes out with tonight's release at 22:00.`,
                onPick: [
                    ...act(500, {
                        id: `tc_shop_queue`,
                        name: `Bash`,
                        category: `execute`,
                        target: `git push origin fix/shipping-de`,
                        takes: 1_200,
                        result: text(`Pushed · queued for tonight's 22:00 release`),
                    }),
                    ...say(
                        500,
                        `**Checkout works from start to finish.** One thing needed fixing:\n\n- **Shipping to Germany showed €0.00.** Germany was missing from the rate table. The fix goes out with tonight's release at 22:00; until then, orders to Germany ship free.\n\nThe cart, guest checkout, card payment and confirmation email all work.`,
                    ),
                    ...closing({ kind: `usage`, account: `ada@acme.dev`, costUsd: 0.58, inputTokens: 55_100, outputTokens: 3_900 }),
                ],
            },
        ]),
        ...act(500, {
            id: `tc_shop_deploy`,
            name: `Bash`,
            category: `execute`,
            target: `pnpm deploy`,
            takes: 1_800,
            result: text(`✓ Deployed acme-shop.com in 38s`),
        }),
        ...say(
            500,
            `**Checkout works from start to finish.** One thing needed fixing, and it's live now:\n\n- **Shipping to Germany showed €0.00.** Germany was missing from the rate table. It's back at €6.90.\n\nThe cart, guest checkout, card payment and confirmation email all work. Test order #1042 went through at the right total.`,
        ),
        ...closing({ kind: `usage`, account: `ada@acme.dev`, costUsd: 0.62, inputTokens: 58_200, outputTokens: 4_100 }),
    ],
};
