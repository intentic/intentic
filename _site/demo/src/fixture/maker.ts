import type { AgentRepoChanges, AgentSummary, FileDiff, RepoChanges, SessionSummary } from "@intentic/sandbox-contract";
import { buildDocx } from "./document";

// THE MAKER RECORDING: the same app on a workspace of documents rather than code, for the reader who came from
// intentic.dev/maker. One person, Ada, who runs a small ceramics studio: a newsletter, the shop's website, letters and
// receipts. Served in place of acme-shop when the demo's mode is `maker` (mode.ts); every seam that reads a fixture
// picks this one there, so nothing here is applied by rewriting the code fixtures.

export const MAKER_SANDBOX_NAME = `my-maker`;

// One project per folder: the Projects dashboard draws a tile for each, and the maker never hears the word repository.
export const MAKER_REPOS: readonly string[] = [`newsletter`, `shop-site`, `letters`, `receipts`];

// The featured run: the plan card and the question the chat shots are pictures of.
export const MAKER_FEATURED_ID = `cnv_maker_newsletter`;
// Parked on a question: the attention lane's reason to exist.
export const MAKER_AWAITING_ID = `cnv_maker_supplier`;
// Holding a finished draft: what the review page opens on, and the one prose diff the recording carries whole.
export const MAKER_REVIEW_ID = `cnv_maker_september`;
const MAKER_RECEIPTS_ID = `cnv_maker_receipts`;

export const MAKER_FEATURED_TITLE = `Rewrite the October newsletter for the autumn sale`;
export const MAKER_FEATURED_SESSION = `ses_maker_october`;

const minutes = (count: number): number => count * 60_000;
const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false } as const;

export const makerRoster = (now: number): AgentSummary[] => [
    {
        id: MAKER_FEATURED_ID,
        startIn: `newsletter`,
        sessionId: MAKER_FEATURED_SESSION,
        title: MAKER_FEATURED_TITLE,
        status: `running`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        thinking: true,
        account: `acc_claude_demo`,
        branch: `agent/october-sale`,
        base: `2c7e91a`,
        costUsd: 0.06,
        inputTokens: 8_400,
        outputTokens: 1_120,
        contextTokens: 6_200,
        contextWindow: 200_000,
        activity: { tool: `Edit`, target: `newsletter/october.md`, todo: `Put the sale first` },
        startedAt: now - minutes(3),
        updatedAt: now - 1_200,
        seenAt: now - minutes(3),
        attention: NO_ATTENTION,
        turns: 2,
        toolUses: 6,
        diff: { files: 1, insertions: 9, deletions: 12 },
    },
    {
        id: MAKER_AWAITING_ID,
        startIn: `letters`,
        sessionId: `ses_maker_supplier`,
        title: `Reply to the supplier about the delayed delivery`,
        status: `awaiting`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        effort: `high`,
        thinking: true,
        account: `acc_claude_demo`,
        branch: `agent/supplier-reply`,
        base: `2c7e91a`,
        costUsd: 0.03,
        inputTokens: 4_100,
        outputTokens: 640,
        contextTokens: 3_800,
        contextWindow: 200_000,
        updatedAt: now - minutes(2),
        seenAt: now - minutes(8),
        attention: { ...NO_ATTENTION, question: true },
        turns: 1,
        toolUses: 3,
    },
    {
        id: MAKER_REVIEW_ID,
        startIn: `newsletter`,
        sessionId: `ses_maker_september`,
        title: `Move the September newsletter into the new template`,
        status: `ready`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-sonnet-5`,
        account: `acc_claude_demo`,
        branch: `agent/september-template`,
        base: `2c7e91a`,
        autoLand: false,
        costUsd: 0.05,
        inputTokens: 7_200,
        outputTokens: 980,
        contextTokens: 5_600,
        contextWindow: 200_000,
        updatedAt: now - minutes(14),
        seenAt: now - minutes(14),
        attention: NO_ATTENTION,
        turns: 2,
        toolUses: 5,
        diff: { files: 1, insertions: 14, deletions: 17 },
    },
    {
        id: MAKER_RECEIPTS_ID,
        startIn: `receipts`,
        sessionId: `ses_maker_receipts`,
        title: `Sort September's receipts into folders by month and supplier`,
        status: `landed`,
        provider: `claude`,
        harness: `claude-code`,
        model: `claude-haiku-4-5-20251001`,
        account: `acc_claude_demo`,
        branch: `agent/sort-receipts`,
        base: `2c7e91a`,
        costUsd: 0.02,
        inputTokens: 3_900,
        outputTokens: 410,
        contextTokens: 2_800,
        contextWindow: 200_000,
        updatedAt: now - minutes(41),
        seenAt: now - minutes(40),
        attention: NO_ATTENTION,
        turns: 1,
        toolUses: 16,
        diff: { files: 14, insertions: 0, deletions: 0 },
    },
];

// What the studio's newsletter looked like before the template: long, one paragraph after another, no headings.
export const SEPTEMBER_BEFORE = `# September at the studio

Dear friends of the studio,

I hope you all had a wonderful summer. September has arrived, the light in the workshop has gone golden in the afternoons, and we have been busy getting ready for the autumn. Here is what has been going on.

The new ceramics range is finally here. It took the whole of August to get the glaze right, but the bowls and the tall jugs are on the shelves now, in the blue and the oatmeal.

We took part in the Harbour Market on the 6th and the 7th. Thank you to everyone who came by the stall, it was lovely to meet so many of you in person.

Pottery evenings are starting again. The first one is on Tuesday the 30th, from 7 until 9, and there are eight places.

That is all for this month. See you in the shop.

Warmly,
Ada
`;

export const SEPTEMBER_AFTER = `# Studio news · September

Hello everyone,

The light in the workshop has gone golden in the afternoons, and the autumn things are arriving.

## The new ceramics

Bowls and tall jugs, in the blue and the oatmeal. The glaze took the whole of August to get right.

## Harbour Market

Thank you to everyone who came by the stall on the 6th and 7th. It was lovely to meet so many of you in person.

## Pottery evenings

Back from Tuesday the 30th, 7 until 9. Eight places, so book early.

Thank you, as always, for reading.

Ada
`;

// The featured run's file, as it stands and as the run leaves it: turn.ts shows the same edit in its tool card.
export const OCTOBER_BEFORE = `# Studio news · October

Hello everyone,

It has been a busy few weeks here at the studio and there is a lot to tell you about, so grab a cup of tea and settle in, because this one is a little longer than usual.

## Autumn sale

From the 14th until the end of the month everything in the shop is 20% off. That includes the new ceramics range, the linen aprons and the last of the summer prints. Just use the code AUTUMN at the checkout, or mention it at the counter.

## New opening hours

From November we will open at 10 rather than 9 on weekdays, and stay open until 6 on Thursdays and Fridays.

## Workshops

The beginners' pottery evening is back on the first Tuesday of each month. Places are limited to eight, so book early.

Thank you, as always, for reading.

Ada
`;

export const OCTOBER_AFTER = `# Studio news · October

Hello everyone,

**Everything in the shop is 20% off until the 31st.** Use the code AUTUMN at the checkout, or mention it at the counter.

## What is in the sale

The new ceramics range, the linen aprons and the last of the summer prints. Once the prints are gone, they are gone.

## From November

We open at 10 on weekdays, and stay open until 6 on Thursdays and Fridays.

## Workshops

The beginners' pottery evening is back on the first Tuesday of each month. Eight places, so book early.

Thank you, as always, for reading.

Ada
`;

const TEMPLATE = `# Studio news · {Month}

Hello everyone,

{One or two lines: what this month is about.}

## {First item}

{Two or three sentences.}

## {Second item}

{Two or three sentences.}

## {Third item}

{Two or three sentences.}

Thank you, as always, for reading.

Ada
`;

// The owner's own edit, uncommitted in the shop-site project: the one row the main tree's changes list holds.
const HOURS_BEFORE = `# Opening hours

Monday to Friday: 9 to 5
Saturday: 10 to 4
Sunday: closed
`;

const HOURS_AFTER = `# Opening hours

Monday to Wednesday: 10 to 5
Thursday and Friday: 10 to 6
Saturday: 10 to 4
Sunday: closed
`;

const README = `# my-maker

Ada's maker: the studio newsletter, the shop's website, letters and receipts.

This workspace is a **recording**. Every panel around it is the real intentic UI, wired to a fixture
instead of an assistant, so you can open anything, but nothing here runs.

Install the app on your own computer and the same screens work on your documents.
`;

/** A letter as the Word document it would be on a maker, drawn by the viewer from its real bytes. */
export const SUPPLIER_LETTER_PATH = `letters/supplier-delay.docx`;
export const SUPPLIER_LETTER_DOCX = buildDocx(`Re: order 2318, delivery date`, [
    `Dear Mr Hendriks,`,
    `Thank you for letting us know that the glaze order will be late. We understand that the kiln at your end has been out of action, and we appreciate you telling us before the date rather than after it.`,
    `We do need a firm date, though. The autumn sale opens on the 14th and the new range cannot go on the shelves without the blue.`,
    `Could you confirm by Friday whether the 10th is possible? If it is not, we will need to hold the sale back a week, and we would rather know now.`,
    `With thanks,`,
    `Ada Lovelace`,
]);

/** Every document on the maker, in the shape workspace.ts's table takes: a body, or a size for one it does not carry. */
export const MAKER_SOURCES: readonly [string, string | number][] = [
    [`README.md`, README],

    [`newsletter/october.md`, OCTOBER_BEFORE],
    [`newsletter/september.md`, SEPTEMBER_BEFORE],
    [`newsletter/august.md`, 2_860],
    [`newsletter/template.md`, TEMPLATE],
    [`newsletter/subscribers.csv`, 41_200],
    [`newsletter/images/autumn-sale.jpg`, 384_000],
    [`newsletter/images/blue-jug.jpg`, 512_400],

    [`shop-site/index.html`, 4_120],
    [`shop-site/about.html`, 2_480],
    [`shop-site/opening-hours.md`, HOURS_AFTER],
    [`shop-site/style.css`, 3_910],
    [`shop-site/images/storefront.jpg`, 641_000],
    [`shop-site/images/workshop.jpg`, 588_200],
    // What a site is made of underneath, which is what a maker's tree leaves out: the chip counts these.
    [`shop-site/package.json`, 512],
    [`shop-site/.gitignore`, 24],
    [`shop-site/vite.config.ts`, 180],
    [`shop-site/node_modules/vite/package.json`, 4_040],

    [SUPPLIER_LETTER_PATH, SUPPLIER_LETTER_DOCX.length],
    [`letters/landlord-notice.docx`, 21_800],
    [`letters/market-application.pdf`, 148_600],

    [`receipts/2026-09/hendriks-glazes.pdf`, 92_400],
    [`receipts/2026-09/clay-supplies.pdf`, 61_200],
    [`receipts/2026-09/harbour-market-stall.pdf`, 38_900],
    [`receipts/2026-09/rent.pdf`, 44_100],
    [`receipts/2026-08/hendriks-glazes.pdf`, 90_800],
    [`receipts/2026-08/rent.pdf`, 44_100],
];

// The main tree's own uncommitted work: one edit the owner made by hand.
export const MAKER_CHANGES: RepoChanges[] = [
    {
        repo: `shop-site`,
        branch: `main`,
        conflicted: [],
        staged: [],
        unstaged: [{ path: `opening-hours.md`, status: `modified`, additions: 2, deletions: 1 }],
    },
];

export const MAKER_ORIGIN_AGENTS: Record<string, { title: string; provider: string }> = {
    [MAKER_REVIEW_ID]: { title: `Move the September newsletter into the new template`, provider: `claude` },
};

// The finished draft, and the sorting that already landed. No `modules`: a folder of documents declares no package.
export const MAKER_AGENT_DELTAS: Record<string, AgentRepoChanges[]> = {
    [MAKER_REVIEW_ID]: [
        {
            repo: `newsletter`,
            branch: `agent/september-template`,
            changes: [{ path: `september.md`, status: `modified`, additions: 14, deletions: 17, landed: false }],
            modules: [],
        },
    ],
    [MAKER_RECEIPTS_ID]: [
        {
            repo: `receipts`,
            branch: `agent/sort-receipts`,
            changes: [
                { path: `2026-09/hendriks-glazes.pdf`, status: `renamed`, from: `IMG_2041.pdf`, additions: 0, deletions: 0, landed: true },
                { path: `2026-09/clay-supplies.pdf`, status: `renamed`, from: `scan 3.pdf`, additions: 0, deletions: 0, landed: true },
                { path: `2026-09/harbour-market-stall.pdf`, status: `renamed`, from: `receipt.pdf`, additions: 0, deletions: 0, landed: true },
                { path: `2026-09/rent.pdf`, status: `renamed`, from: `rent sept.pdf`, additions: 0, deletions: 0, landed: true },
            ],
            modules: [],
        },
    ],
};

// Keyed `repo/path`, like workspace.ts's own table; a prose file's diff reads as tracked changes for a maker.
export const MAKER_DIFFS: Record<string, FileDiff> = {
    "newsletter/september.md": { before: SEPTEMBER_BEFORE, after: SEPTEMBER_AFTER },
    "newsletter/october.md": { before: OCTOBER_BEFORE, after: OCTOBER_AFTER },
    "shop-site/opening-hours.md": { before: HOURS_BEFORE, after: HOURS_AFTER },
};

export const makerSessions = (now: number): SessionSummary[] => {
    const hour = 3_600_000;
    return [
        { id: MAKER_FEATURED_SESSION, title: MAKER_FEATURED_TITLE, updatedAt: now - 60_000 },
        { id: `ses_maker_supplier`, title: `Reply to the supplier about the delayed delivery`, updatedAt: now - 2 * 60_000 },
        { id: `ses_maker_september`, title: `Move the September newsletter into the new template`, updatedAt: now - 14 * 60_000 },
        { id: `ses_maker_receipts`, title: `Sort September's receipts into folders by month and supplier`, updatedAt: now - 41 * 60_000 },
        { id: `ses_maker_hours`, title: `Update the opening hours on the website`, updatedAt: now - 5 * hour },
        { id: `ses_maker_landlord`, title: `Draft the notice to the landlord about the leak`, updatedAt: now - 26 * hour },
        { id: `ses_maker_market`, title: `Fill in the Harbour Market application`, updatedAt: now - 3 * 24 * hour },
        { id: `ses_maker_august`, title: `Write the August newsletter`, updatedAt: now - 33 * 24 * hour },
    ];
};
