import { STATE_DIR } from "@intentic/constants";
/* DOCUMENTATION, RECORDED — what agents wrote about acme-shop, and one draft still waiting to be read.
 *
 * Like every other surface in this recording, the documents ARE the state: a published set is
 * `<repo>/docs/architecture/**` (in the repo, reviewable in the same diff as the code it describes) and a draft
 * is `.intentic/config/docs/<repo>/**` mirroring the same tails. So this module contributes files and nothing else, and
 * the extension reads them exactly as it would against a real sandbox.
 *
 * BOTH TREES ARE PRESENT ON PURPOSE. `web` is published — it is what the area looks like once a set has landed:
 * a map, a reading order, a page per part, and one page marked stale because the code moved under it (the
 * checkout agent is editing that very directory in the fleet board next door). `api` is staged, which is what
 * makes the rail badge and the draft banner real: an agent generated it, nobody has read it, and the choice to
 * publish is still the owner's.
 *
 * WHAT IS DELIBERATELY ABSENT is a run manifest. A run that is still in flight is one the extension would try to
 * ADVANCE — starting a turn per undocumented package, which is the one thing a recording must never do. The
 * documents are the finished artifact; the run that made them is over. */

const ARCHITECTURE = `docs/architecture`;
const STAGING = `${STATE_DIR}/config/docs`;

/* What a page carries before it becomes a README. Authored here only so the fixture can compose the page and the
 * index from ONE source; neither shape exists on disk in a real repository. */
interface PageDoc {
    readonly dir: string;
    readonly oneLiner: string;
    readonly keyFiles: readonly { readonly path: string; readonly line?: number; readonly what: string }[];
}

const WEB_REV = `4f1c8ab2d9e6f0713c5a8b47d1e2f9c0a6b3d84e`;
const API_REV = `9b2d10e4c7a1f3b85d6e0c29a4f7b1d3e8c05a26`;

// ---- web: the published set ---------------------------------------------------------------------------------

const WEB_REPO_DOC = (generatedAt: number): string =>
    `${JSON.stringify(
        {
            repo: `web`,
            components: [
                {
                    id: `storefront`,
                    name: `The storefront`,
                    oneLiner: `The pages a customer actually sees.`,
                    packages: [`src/pricing`],
                    accent: `1`,
                },
                {
                    id: `checkout`,
                    name: `Checkout`,
                    oneLiner: `Turning a chosen plan into a paid subscription.`,
                    packages: [`src/lib`],
                    accent: `2`,
                },
                {
                    id: `suite`,
                    name: `The test suite`,
                    oneLiner: `What has to pass before any of this ships.`,
                    packages: [`tests`],
                    accent: `4`,
                },
            ],
            glossary: [
                { term: `plan`, means: `One of Starter, Growth or Scale — what a customer picks on the pricing page.` },
                {
                    term: `price id`,
                    means: `Stripe's identifier for a plan's monthly price. The storefront never hardcodes an amount; it sends one of these.`,
                },
                {
                    term: `checkout session`,
                    means: `A short-lived Stripe page that takes the card. The API creates it, the browser opens it, and it expires within the hour.`,
                },
                { term: `launch coupon`, means: `A discount code handed out at conferences. Real in Stripe; checked by the storefront first.` },
            ],
            reading: [`src/pricing`, `src/lib`, `tests`],
            provenance: { generatedAt, sourceRev: WEB_REV, model: `claude-opus-5` },
        },
        undefined,
        2,
    )}\n`;

const WEB_REPO_PROSE = `# The storefront, in pictures

Three plans, one checkout, and a small test suite that guards the path between them.

\`\`\`stats
{ "items": [
    {"label": "Parts", "value": "3", "note": "grouped below"},
    {"label": "Files", "value": "11"},
    {"label": "Lines of code", "value": "2.4k"},
    {"label": "With tests", "value": "2 of 3"}
  ] }
\`\`\`

## How a sale actually happens

\`\`\`dag
{ "title": "From the pricing page to a paid subscription",
  "direction": "LR",
  "nodes": [
    {"id": "visitor", "label": "Visitor", "note": "a browser", "accent": "neutral"},
    {"id": "pricing", "label": "Pricing page", "note": "src/pricing", "accent": "1"},
    {"id": "lib", "label": "Checkout client", "note": "src/lib", "accent": "2"},
    {"id": "api", "label": "acme API", "note": "another repo", "accent": "neutral"},
    {"id": "stripe", "label": "Stripe", "note": "hosted checkout", "accent": "5"},
    {"id": "tests", "label": "Test suite", "note": "tests", "accent": "4"}
  ],
  "edges": [
    {"from": "visitor", "to": "pricing"},
    {"from": "pricing", "to": "lib"},
    {"from": "lib", "to": "api"},
    {"from": "api", "to": "stripe"},
    {"from": "stripe", "to": "visitor", "dashed": true},
    {"from": "tests", "to": "pricing", "dashed": true}
  ] }
\`\`\`

Notice that the storefront never talks to Stripe directly. It asks our own API for a **checkout session** and
then hands the visitor to the URL that comes back — which is why no card number is ever handled by this repo,
and why the only secret it needs is nothing at all.

## What each part is for

**The storefront** — The pages a customer actually sees. · \`src/pricing\` · 1.1k lines

**Checkout** — Turning a chosen plan into a paid subscription. · \`src/lib\` · 0.6k lines

**The test suite** — What has to pass before any of this ships. · \`tests\` · 0.7k lines

\`\`\`bars
{ "title": "Where the code is",
  "items": [
    {"label": "src/pricing", "value": 1120, "accent": "1"},
    {"label": "src/lib", "value": 640, "accent": "2"},
    {"label": "tests", "value": 660, "accent": "4"}
  ] }
\`\`\`

## What surprised me

The plan list is fetched rather than hardcoded, so the first paint of the pricing page has no prices in it. Every
test that clicks a plan has to wait for that fetch, and the two flaky tests this repo has ever had were both this
same race written twice.
`;

const WEB_PAGES: readonly { readonly dir: string; readonly doc: PageDoc; readonly prose: string }[] = [
    {
        dir: `src/pricing`,
        doc: {
            dir: `src/pricing`,
            oneLiner: `The three plans, and the button that starts a subscription.`,
            keyFiles: [
                { path: `src/pricing/PricingPage.tsx`, what: `The page itself: fetches the plans, renders the three cards.` },
                { path: `src/pricing/CheckoutPanel.tsx`, line: 27, what: `The Growth card's call to action — where a sale begins.` },
                { path: `src/pricing/plans.ts`, what: `Plan names and the price ids they map to.` },
            ],
        },
        prose: `# The storefront

The pricing page is the only page in this repository a customer is ever sent a link to, and everything else here
exists to make its one button work.

## What it does

Fetches the plan list from the API, renders a card per plan, and marks Growth as the recommended one. Pressing a
card's call to action asks \`src/lib\` for a checkout session and sends the browser to the URL it returns.

## What to read first

\`PricingPage.tsx\` top to bottom — it is short, and the fetch at the top explains the loading state that every
test here has to wait for. \`CheckoutPanel.tsx\` is where the button lives; it is the file most likely to be
different by the time you read this.

## Worth knowing

Prices are never rendered from a constant. \`plans.ts\` maps a plan name to a Stripe **price id** and the amount
comes back with the plan, so a price change in Stripe is live here without a deploy — and a plan missing from
Stripe renders as a card with no price rather than as an error.
`,
    },
    {
        dir: `src/lib`,
        doc: {
            dir: `src/lib`,
            oneLiner: `The thin client between the pages and our own API.`,
            keyFiles: [
                { path: `src/lib/checkout.ts`, what: `Creates a checkout session and redirects to it.` },
                { path: `src/lib/api.ts`, what: `fetch() with the base URL, credentials and error shape applied once.` },
            ],
        },
        prose: `# Checkout

Two files, one job: turn "the visitor chose Growth" into "the visitor is on Stripe's payment page".

## What it does

\`checkout.ts\` posts the chosen price id to \`/checkout/session\` and navigates to the URL that comes back.
\`api.ts\` is the only place a base URL, a credentials mode or an error shape is written down, so no page has to
know how to talk to the API.

## Worth knowing

Nothing here handles a card, and nothing here holds a Stripe key. The session is created by the API — this
repository's whole part in taking money is one POST and one redirect, which is the reason a compromise of the
storefront cannot leak a payment.
`,
    },
    {
        dir: `tests`,
        doc: {
            dir: `tests`,
            oneLiner: `The end-to-end checks that guard the path to a sale.`,
            keyFiles: [
                { path: `tests/checkout.spec.ts`, what: `Buying a plan, end to end, against a test-mode Stripe.` },
                { path: `tests/signup.spec.ts`, what: `Creating an account — the suite's historically flaky one.` },
            ],
        },
        prose: `# The test suite

Playwright, two specs, run on every push and before every deploy.

## What it does

\`checkout.spec.ts\` walks the sale: load the pricing page, press Growth, pay with Stripe's test card, assert the
subscription is active. \`signup.spec.ts\` does the same for account creation.

## Worth knowing

Both specs must wait for the plan fetch before clicking anything. \`signup.spec.ts\` has been quarantined twice
for exactly this and is the reason the fixture waits on a rendered price rather than a timeout.
`,
    },
];

/* The index is GENERATED in a real repository — `intentic-docs check` reads each README and the package graph and
 * writes this. The recording has no tool run, so it is authored here, but every field is one the tool would have
 * computed: the one-liners come from the pages above, and the measures are what the app draws its figures from. */
const WEB_INDEX = (generatedAt: number): string =>
    `${JSON.stringify(
        {
            repo: `web`,
            generatedAt,
            entries: [
                {
                    dir: `src/pricing`,
                    oneLiner: WEB_PAGES[0]?.doc.oneLiner,
                    component: `storefront`,
                    anchors: WEB_PAGES[0]?.doc.keyFiles,
                    files: 5,
                    loc: 1120,
                    hasTests: false,
                    readmeRev: WEB_REV,
                    updatedAt: generatedAt,
                    // The one page the recording marks stale, because the fleet board next door is editing exactly
                    // this directory — which is what staleness looks like when it is honest rather than decorative.
                    stale: true,
                    reason: `3 commits have touched this package since its README was written`,
                    behind: 3,
                },
                {
                    dir: `src/lib`,
                    oneLiner: WEB_PAGES[1]?.doc.oneLiner,
                    component: `checkout`,
                    anchors: WEB_PAGES[1]?.doc.keyFiles,
                    files: 3,
                    loc: 640,
                    hasTests: false,
                    readmeRev: WEB_REV,
                    updatedAt: generatedAt,
                    stale: false,
                    behind: 0,
                },
                {
                    dir: `tests`,
                    oneLiner: WEB_PAGES[2]?.doc.oneLiner,
                    component: `suite`,
                    anchors: WEB_PAGES[2]?.doc.keyFiles,
                    files: 3,
                    loc: 660,
                    hasTests: true,
                    readmeRev: WEB_REV,
                    updatedAt: generatedAt,
                    stale: false,
                    behind: 0,
                },
            ],
            edges: [
                { from: `src/pricing`, to: `src/lib`, dev: false },
                { from: `tests`, to: `src/pricing`, dev: true },
            ],
            orphans: [],
            undocumented: [],
        },
        undefined,
        2,
    )}\n`;

// ---- api: the draft nobody has read yet ---------------------------------------------------------------------

const API_REPO_DOC = (generatedAt: number): string =>
    `${JSON.stringify(
        {
            repo: `api`,
            components: [
                {
                    id: `http`,
                    name: `The HTTP surface`,
                    oneLiner: `Every route the storefront and Stripe can call.`,
                    packages: [`src/routes`],
                    accent: `1`,
                },
                { id: `data`, name: `The database`, oneLiner: `Where orders, users and subscriptions are kept.`, packages: [`src/db`], accent: `3` },
            ],
            glossary: [
                {
                    term: `webhook`,
                    means: `Stripe telling us something happened. Retried until we answer 200, so every handler must be safe to run twice.`,
                },
                { term: `soft delete`, means: `A row is retired by stamping deleted_at, never removed — every read filters on it.` },
            ],
            reading: [`src/routes`, `src/db`],
            provenance: { generatedAt, sourceRev: API_REV, model: `claude-opus-5` },
        },
        undefined,
        2,
    )}\n`;

const API_REPO_PROSE = `# The API, in pictures

One small service: it serves the storefront, talks to Stripe, and owns the only database in the product.

\`\`\`stats
{ "items": [
    {"label": "Parts", "value": "2"},
    {"label": "Files", "value": "6"},
    {"label": "Lines of code", "value": "1.8k"},
    {"label": "With tests", "value": "1 of 2"}
  ] }
\`\`\`

## What talks to what

\`\`\`dag
{ "title": "Requests, and where they land",
  "direction": "LR",
  "nodes": [
    {"id": "web", "label": "Storefront", "note": "the other repo", "accent": "neutral"},
    {"id": "stripe", "label": "Stripe", "note": "webhooks", "accent": "5"},
    {"id": "routes", "label": "Routes", "note": "src/routes", "accent": "1"},
    {"id": "db", "label": "Database", "note": "src/db", "accent": "3"}
  ],
  "edges": [
    {"from": "web", "to": "routes"},
    {"from": "stripe", "to": "routes"},
    {"from": "routes", "to": "db"}
  ] }
\`\`\`

Both callers arrive at the same place, and only one of them can be trusted: a webhook is signed, a storefront
request is not. That distinction is made once, at the edge, and everything behind it assumes it has been made.

## What surprised me

Deletion is not deletion. Users are retired with a \`deleted_at\` stamp and every read filters them out, so a
query written without that filter quietly returns people who asked to be forgotten. There is a helper for it, and
it is the single most important thing to know before writing a query here.
`;

const API_PAGES: readonly { readonly dir: string; readonly doc: PageDoc; readonly prose: string }[] = [
    {
        dir: `src/routes`,
        doc: {
            dir: `src/routes`,
            oneLiner: `Every route the storefront and Stripe can call.`,
            keyFiles: [
                { path: `src/routes/checkout.ts`, what: `Creates checkout sessions, and receives Stripe's webhooks.` },
                { path: `src/routes/users.ts`, what: `Sign-up, sign-in, and retiring an account.` },
            ],
        },
        prose: `# The HTTP surface

Two route files, and one rule that runs before both of them: a request either carries a session cookie or a
Stripe signature, and anything else is refused at the edge.

## What it does

\`checkout.ts\` creates a checkout session for a price id, and handles the \`checkout.session.completed\` webhook
that follows a successful payment. \`users.ts\` covers the account lifecycle.

## Worth knowing

Stripe retries a webhook until it is acknowledged, so the completion handler is written to be safe to run twice:
it keys on the event id and does nothing the second time. That is not defensive programming — it is the
documented contract, and a handler that ignores it double-charges nobody but does create two subscriptions.
`,
    },
    {
        dir: `src/db`,
        doc: {
            dir: `src/db`,
            oneLiner: `Where orders, users and subscriptions are kept.`,
            keyFiles: [
                { path: `src/db/schema.ts`, what: `The tables, and the soft-delete column every read filters on.` },
                { path: `src/db/migrations.ts`, what: `Ordered migrations — the only way the schema is allowed to change.` },
            ],
        },
        prose: `# The database

Postgres, reached through Drizzle, with the schema in one file.

## What it does

\`schema.ts\` declares every table and is the closest thing this product has to a data dictionary.
\`migrations.ts\` is an ordered list; nothing changes the schema except a migration in it.

## Worth knowing

\`users\` is soft-deleted: rows are stamped with \`deleted_at\` rather than removed, and \`liveUsers()\` is the
only read that has the filter built in. A query written by hand against \`users\` will include retired accounts
unless it repeats that filter, which is the mistake this page exists to prevent.
`,
    },
];

const API_INDEX = (generatedAt: number): string =>
    `${JSON.stringify(
        {
            repo: `api`,
            generatedAt,
            entries: [
                {
                    dir: `src/routes`,
                    oneLiner: API_PAGES[0]?.doc.oneLiner,
                    component: `http`,
                    anchors: API_PAGES[0]?.doc.keyFiles,
                    files: 6,
                    loc: 890,
                    hasTests: true,
                    readmeRev: API_REV,
                    updatedAt: generatedAt,
                    stale: false,
                    behind: 0,
                },
                {
                    dir: `src/db`,
                    oneLiner: API_PAGES[1]?.doc.oneLiner,
                    component: `data`,
                    anchors: API_PAGES[1]?.doc.keyFiles,
                    files: 4,
                    loc: 520,
                    hasTests: false,
                    readmeRev: API_REV,
                    updatedAt: generatedAt,
                    stale: false,
                    behind: 0,
                },
            ],
            edges: [{ from: `src/routes`, to: `src/db`, dev: false }],
            orphans: [],
            undocumented: [],
        },
        undefined,
        2,
    )}\n`;

/* One page → one file, because a package's document IS its README. The authored `doc` is not written anywhere:
 * in a real repository the tool READS the one-liner and the anchors back out of the README, so the fixture
 * composes them INTO the page rather than shipping them beside it. That keeps the recording honest about where
 * this data comes from, and it means the fixture's index cannot disagree with its pages.
 *
 * The one-liner goes directly under the heading, which is the position the parser takes it from, and the anchors
 * become a `## Key files` section with package-relative links — the same links that have to work on GitHub. */
const pageFiles = (base: string, pages: readonly { readonly dir: string; readonly doc: PageDoc; readonly prose: string }[]) =>
    pages.map((page): [string, string] => {
        const [heading, ...rest] = page.prose.split(`\n\n`);
        const keyFiles = page.doc.keyFiles.map((anchor) => {
            const relative = anchor.path.startsWith(`${page.dir}/`) ? anchor.path.slice(page.dir.length + 1) : anchor.path;
            const target = anchor.line === undefined ? relative : `${relative}#L${anchor.line}`;
            return `- [${relative}](${target}) — ${anchor.what}`;
        });
        return [`${base}/${page.dir}/README.md`, [heading, page.doc.oneLiner, ...rest, `## Key files`, `${keyFiles.join(`\n`)}\n`].join(`\n\n`)];
    });

export const documentationFiles = (now: number): [string, string][] => {
    // Published two days ago; the draft came out of a run twenty minutes before the visitor arrived, which is why
    // nobody has read it yet.
    const published = now - 2 * 86_400_000;
    const drafted = now - 20 * 60_000;
    return [
        [`web/${ARCHITECTURE}/repo.json`, WEB_REPO_DOC(published)],
        [`web/${ARCHITECTURE}/repo.md`, WEB_REPO_PROSE],
        [`web/${ARCHITECTURE}/index.json`, WEB_INDEX(published)],
        // A PUBLISHED package page sits on the package, not under the docs directory — that is the layout.
        ...pageFiles(`web`, WEB_PAGES),

        [`${STAGING}/api/repo.json`, API_REPO_DOC(drafted)],
        [`${STAGING}/api/repo.md`, API_REPO_PROSE],
        [`${STAGING}/api/index.json`, API_INDEX(drafted)],
        // A STAGED one still mirrors under the staging root, which is what makes publishing a copy per tail.
        ...pageFiles(`${STAGING}/api`, API_PAGES),
    ];
};
