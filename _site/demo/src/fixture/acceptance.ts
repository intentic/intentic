import { STATE_DIR } from "@intentic/constants";
import { cartPage, checkoutPage, pricingPage } from "./storefront";

/* ACCEPTANCE, RECORDED — acme-shop's user stories and the run that walked three of them through the app.
 *
 * Everything this surface shows is FILES, which is the whole reason it can be fixtured at all: the stories are
 * markdown in the repos (`docs/user-stories/**`), and a run is a directory under `.intentic/artifacts/acceptance/` holding
 * one manifest plus a result, a report and its screenshots per story. So this module contributes paths and
 * bodies to the recording's filesystem (workspace.ts) and nothing else — no route, no state, no special case in
 * the daemon. The extension walks the same directories it would walk against a real sandbox.
 *
 * THE RUN IS DELIBERATELY MIXED: one story passed, one failed with a defect, one was blocked before it could be
 * judged, and a fourth story has never been run at all. A recording where everything is green shows none of the
 * distinctions this surface exists to make — `blocked` is not `fail`, and "never tested" is not "passing".
 *
 * The screenshots are the same storefront pages the agent's browser view plays (storefront.ts), stored as files
 * the report references relatively — which is exactly how a real run's shots reach the report. */

// The story files, repo-relative under each repo's docs/user-stories. A file is one story: one test session, one
// agent, one report. Subdirectories are groups, and a group is what an address is resolved per.
const BUY_A_PLAN = `# Buy a plan

A visitor picks the Growth plan on the pricing page and pays with a card. This is the path the whole storefront
exists for, so it is the one story that must never be red.

## Acceptance criteria

- [ ] The pricing page lists Starter, Growth and Scale with their monthly prices
- [ ] "Start free trial" on Growth opens a Stripe checkout for $49.00 per month
- [ ] Paying with the test card 4242 4242 4242 4242 returns to /welcome with the subscription active
- [ ] The order confirmation email is queued exactly once
`;

const APPLY_A_COUPON = `# Apply a launch coupon

A visitor with a launch code enters it in the cart and sees the discount before paying. Marketing hands these
codes out at conferences, so a code that is rejected is a sale that does not happen.

## Acceptance criteria

- [ ] The cart shows a coupon field above the checkout button
- [ ] Entering SPRING25 reduces the total by 25% and names the discount in the summary
- [ ] An expired or unknown code is refused with a message that says which
- [ ] The discounted amount is what Stripe charges
`;

const SIGN_UP = `# Sign up for an account

Someone new creates an account with an email and a password, confirms it, and lands in the dashboard.

## Acceptance criteria

- [ ] The signup form rejects an address that is already registered
- [ ] A confirmation email arrives within a minute
- [ ] Following the link in it signs the visitor in and opens the dashboard
`;

const RESET_PASSWORD = `# Reset a forgotten password

Someone who cannot sign in asks for a reset link and sets a new password with it.

## Acceptance criteria

- [ ] Asking for a reset never reveals whether the address is registered
- [ ] The link expires after an hour and says so when it does
- [ ] Setting a new password signs every other session out
`;

const CHECKOUT_WEBHOOK = `# Checkout webhooks are recorded once

Stripe retries a webhook until it is acknowledged, so the same \`checkout.session.completed\` event can arrive
several times. The subscription must be created once regardless.

## Acceptance criteria

- [ ] A signed event creates the subscription and returns 200
- [ ] The same event id delivered twice creates nothing the second time
- [ ] An event with a bad signature is refused with 400 and logged
`;

/* The repo's own note to whoever tests it — `docs/user-stories/.acceptance.md`, inlined into every brief. It
 * exists so a repository can tune the instructions without forking the extension, and the demo carries one
 * because it is the difference between a generic tester and one that knows the test card and the seeded login. */
const WEB_BRIEF = `Use the seeded account **ada@acme.dev** / \`demo-password\` wherever a story needs someone signed in.

Stripe is in test mode: pay with 4242 4242 4242 4242, any future expiry, any CVC. Never use a real card, and
never leave a subscription active — cancel it from the dashboard when a story is done with it.

The storefront is deliberately slow on first paint (the plans are fetched). Wait for the price to render before
clicking anything, or you will report a bug that is only a race in the test.
`;

// ---- the run ---------------------------------------------------------------------------------------------

const RUNS_DIR = `${STATE_DIR}/artifacts/acceptance`;

// The stories that run covered — the slug is what `slugOf` derives from the filename, and the conversation id is
// `xt-<runId>-<slug>`. Both are stored in the manifest rather than re-derived, exactly as a real run stores them.
const RUN_STORIES = [
    { slug: `01-buy-a-plan`, repo: `web`, group: `checkout`, path: `web/docs/user-stories/checkout/01-buy-a-plan.md`, title: `Buy a plan` },
    {
        slug: `02-apply-a-coupon`,
        repo: `web`,
        group: `checkout`,
        path: `web/docs/user-stories/checkout/02-apply-a-coupon.md`,
        title: `Apply a launch coupon`,
    },
    { slug: `01-sign-up`, repo: `web`, group: `account`, path: `web/docs/user-stories/account/01-sign-up.md`, title: `Sign up for an account` },
] as const;

const BUY_A_PLAN_REPORT = `## What I did

Opened the pricing page, waited for the three plans to render, and pressed **Start free trial** on Growth.

![The pricing page with Growth highlighted](shots/01-pricing.svg)

The button opened a Stripe checkout in the same tab, for $49.00 per month against the Growth price id. I paid
with the test card and was returned to \`/welcome\` with the subscription listed as active.

![The Stripe checkout the session created](shots/02-checkout.svg)

## What I could not check

The confirmation email is queued rather than sent in this environment, so I verified the job was enqueued once
and stopped there — I have no mailbox to read.
`;

const APPLY_A_COUPON_REPORT = `## What I did

Added Growth to the cart and entered **SPRING25**, the code the story names as a valid launch coupon.

![The cart with the coupon typed in](shots/01-cart.svg)

The field refused it: *"That coupon code isn't valid."* The summary's Discount line stayed at \`—\` and the total
was unchanged at $49.00.

![The coupon rejected, with the discount line empty](shots/02-rejected.svg)

## Why it fails

\`POST /api/cart/coupon\` answers \`{"valid": false}\` for SPRING25. The coupon exists in Stripe and is active
there, so the storefront is checking a local table that was never seeded with the launch codes — every code
marketing hands out at a conference is refused the same way.

The rest of the story is unreachable behind that: with no discount applied there is nothing to compare against
what Stripe charges.
`;

const SIGN_UP_REPORT = `## Where I stopped

\`/signup\` answered **500** on first load, before the form rendered. I reloaded twice and waited out the slow
first paint the repo's note warns about; it answered 500 each time.

Nothing about the story could be judged — this is the app being down on that route, not the promise being
broken, so I am reporting it as blocked rather than failed.

The server log line, for whoever picks this up:

\`\`\`
POST /signup → 500  TypeError: Cannot read properties of undefined (reading 'plan')
    at renderSignup (src/routes/signup.tsx:41)
\`\`\`
`;

/* Every file this surface contributes to the recording, built once at page load so the run reads as "42 minutes
 * ago" whenever the visitor arrives. The seen file is deliberately ABSENT: the rail badge is meant to be lit
 * when the demo opens, because a failure nobody has acknowledged is exactly what it is for. */
export const acceptanceFiles = (now: number): [string, string][] => {
    const createdAt = now - 42 * 60_000;
    const runId = `r${createdAt.toString(36)}`;
    const run = `${RUNS_DIR}/${runId}`;
    const manifest = {
        runId,
        createdAt,
        // Per story GROUP, which is what a target is resolved per: both groups here are the same dev server.
        targets: { "web/checkout": `http://localhost:5173`, "web/account": `http://localhost:5173` },
        provider: `claude`,
        model: `claude-sonnet-5`,
        stories: RUN_STORIES.map(({ slug, repo, group, path, title }) => ({ slug, repo, group, path, title, conversationId: `xt-${runId}-${slug}` })),
    };

    return [
        [`web/docs/user-stories/.acceptance.md`, WEB_BRIEF],
        [`web/docs/user-stories/checkout/01-buy-a-plan.md`, BUY_A_PLAN],
        [`web/docs/user-stories/checkout/02-apply-a-coupon.md`, APPLY_A_COUPON],
        [`web/docs/user-stories/account/01-sign-up.md`, SIGN_UP],
        [`web/docs/user-stories/account/02-reset-password.md`, RESET_PASSWORD],
        [`api/docs/user-stories/checkout-webhook.md`, CHECKOUT_WEBHOOK],

        [`${run}/run.json`, `${JSON.stringify(manifest, undefined, 2)}\n`],

        [
            `${run}/01-buy-a-plan/result.json`,
            `${JSON.stringify(
                {
                    story: `01-buy-a-plan`,
                    title: `Buy a plan`,
                    verdict: `pass`,
                    criteria: [
                        { text: `The pricing page lists Starter, Growth and Scale with their monthly prices`, verdict: `pass` },
                        { text: `"Start free trial" on Growth opens a Stripe checkout for $49.00 per month`, verdict: `pass` },
                        { text: `Paying with the test card 4242 4242 4242 4242 returns to /welcome with the subscription active`, verdict: `pass` },
                        {
                            text: `The order confirmation email is queued exactly once`,
                            verdict: `unverified`,
                            note: `the queue was enqueued once; there is no mailbox in this environment to read`,
                        },
                    ],
                },
                undefined,
                2,
            )}\n`,
        ],
        [`${run}/01-buy-a-plan/report.md`, BUY_A_PLAN_REPORT],
        [`${run}/01-buy-a-plan/shots/01-pricing.svg`, pricingPage(1)],
        [`${run}/01-buy-a-plan/shots/02-checkout.svg`, checkoutPage(2)],

        [
            `${run}/02-apply-a-coupon/result.json`,
            `${JSON.stringify(
                {
                    story: `02-apply-a-coupon`,
                    title: `Apply a launch coupon`,
                    verdict: `fail`,
                    criteria: [
                        { text: `The cart shows a coupon field above the checkout button`, verdict: `pass` },
                        {
                            text: `Entering SPRING25 reduces the total by 25% and names the discount in the summary`,
                            verdict: `fail`,
                            note: `the code is refused as invalid and the total is unchanged`,
                        },
                        { text: `An expired or unknown code is refused with a message that says which`, verdict: `pass` },
                        {
                            text: `The discounted amount is what Stripe charges`,
                            verdict: `unverified`,
                            note: `unreachable — no discount is ever applied`,
                        },
                    ],
                    defects: [
                        {
                            severity: `high`,
                            summary: `Valid launch coupons are refused: POST /api/cart/coupon returns {"valid": false} for SPRING25`,
                            repro: `Add Growth to the cart, enter SPRING25, press Apply.`,
                            shot: `shots/02-rejected.svg`,
                        },
                    ],
                },
                undefined,
                2,
            )}\n`,
        ],
        [`${run}/02-apply-a-coupon/report.md`, APPLY_A_COUPON_REPORT],
        [`${run}/02-apply-a-coupon/shots/01-cart.svg`, cartPage({ coupon: `SPRING25`, rejected: false })],
        [`${run}/02-apply-a-coupon/shots/02-rejected.svg`, cartPage({ coupon: `SPRING25`, rejected: true })],

        [
            `${run}/01-sign-up/result.json`,
            `${JSON.stringify(
                {
                    story: `01-sign-up`,
                    title: `Sign up for an account`,
                    verdict: `blocked`,
                    criteria: [
                        {
                            text: `The signup form rejects an address that is already registered`,
                            verdict: `unverified`,
                            note: `the form never rendered`,
                        },
                        { text: `A confirmation email arrives within a minute`, verdict: `unverified` },
                        { text: `Following the link in it signs the visitor in and opens the dashboard`, verdict: `unverified` },
                    ],
                    defects: [
                        { severity: `high`, summary: `GET /signup answers 500 before the form renders`, repro: `Open /signup on a cold server.` },
                    ],
                },
                undefined,
                2,
            )}\n`,
        ],
        [`${run}/01-sign-up/report.md`, SIGN_UP_REPORT],
    ];
};
