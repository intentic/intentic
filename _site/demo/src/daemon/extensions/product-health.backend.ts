import type { RawContext } from "@intentic/contract-serve";
import { json } from "../../transport";
import { putCard, workCard } from "../board/workCards";

// The product-health extension's backend namespace (its src/server/routes.ts): what its last round of reading PostHog
// found in acme-shop's project, joined with the agents on it. The tile appears once PostHog is connected (the
// Capabilities page's copy from rog, hub.handler.ts), and reads this. A press answers as the backend would: Fix with agent
// puts a card on the board, and marking fixed, snoozing or dismissing takes the row off.
const PRODUCT_HEALTH = `/x/intentic.product-health`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HOST = `https://eu.posthog.com`;
const PROJECT = `48213`;
const page = (path: string): string => `${HOST}/project/${PROJECT}${path}`;

interface DemoFinding {
    readonly id: string;
    readonly connection: string;
    readonly source: string;
    readonly sourceId: string;
    readonly kind: string;
    readonly lane: string;
    readonly severity: string;
    readonly title: string;
    readonly summary: string;
    readonly link: string;
    readonly code: readonly { readonly repo: string; readonly path: string; readonly line?: number; readonly why: string }[];
    readonly untrusted: Readonly<Record<string, string>>;
    readonly actions: readonly string[];
    readonly impact?: Readonly<Record<string, number>>;
    readonly since?: number;
    readonly lastSeen?: number;
    readonly cameBack?: boolean;
    readonly advice?: string;
    readonly agent?: { readonly conversationId: string; readonly attempt: number; readonly stance: string; readonly label: string; readonly hint: string };
}

const finding = (source: string, sourceId: string, rest: Omit<DemoFinding, `id` | `connection` | `source` | `sourceId`>): DemoFinding => ({
    id: `posthog:${source}:${sourceId}`,
    connection: `posthog`,
    source,
    sourceId,
    ...rest,
});

// What owes the reader: an error that came back, a new one, an outdated SDK, an Inbox report its agent asks about, and an
// alert an agent is already on.
const owedSeed = (now: number): DemoFinding[] => [
    finding(`error`, `0193a1`, {
        kind: `web`,
        lane: `fix`,
        severity: `critical`,
        title: `ChunkLoadError`,
        summary: `Loading chunk 412 failed.`,
        link: page(`/error_tracking/0193a1`),
        impact: { occurrences: 642, users: 211, sessions: 238 },
        since: now - 9 * DAY,
        lastSeen: now - 0.3 * HOUR,
        cameBack: true,
        code: [{ repo: `web`, path: `.`, why: `release` }],
        untrusted: { message: `Loading chunk 412 failed. (error: https://shop.acme.example/assets/412.8c1f.js)`, release: `2026.11.24 · 7f3c9e1 · acme/web` },
        actions: [`fix`, `resolve`, `snooze`],
    }),
    finding(`error`, `0193b7`, {
        kind: `web`,
        lane: `fix`,
        severity: `warning`,
        title: `TypeError`,
        summary: `Cannot read properties of undefined (reading 'price')`,
        link: page(`/error_tracking/0193b7`),
        impact: { occurrences: 1873, users: 87, sessions: 102 },
        since: now - 2 * DAY,
        lastSeen: now - 0.1 * HOUR,
        code: [{ repo: `web`, path: `src/checkout/CartSummary.tsx`, line: 88, why: `stack-frame` }],
        untrusted: { message: `Cannot read properties of undefined (reading 'price')`, frame: `lineTotal at src/checkout/CartSummary.tsx:88` },
        actions: [`fix`, `resolve`, `snooze`],
    }),
    finding(`health`, `01a1b0`, {
        kind: `sdk_outdated`,
        lane: `fix`,
        severity: `critical`,
        title: `web SDK is outdated`,
        summary: `Latest in-use version 1.180.0 is behind 1.455.2. Outdated versions still handle over 20% of traffic.`,
        link: page(`/health/sdk-health`),
        since: now - 20 * DAY,
        advice: `Update the PostHog SDK dependency in the relevant manifest, update the lockfile, and check the SDK's changelog for required code changes. The issue clears on a later check once old traffic no longer qualifies.`,
        code: [{ repo: `web`, path: `package.json`, line: 31, why: `sdk-pin` }],
        untrusted: { title: `web SDK is outdated`, summary: `Latest in-use version 1.180.0 is behind 1.455.2.` },
        actions: [`fix`, `resolve`, `snooze`],
    }),
    finding(`report`, `r-91c2`, {
        kind: `P1`,
        lane: `fix`,
        severity: `critical`,
        title: `Apple Pay button does nothing on Safari 17`,
        summary: `Sessions on Safari 17 reach checkout, press Apple Pay and leave: no payment sheet opens, no error is logged.`,
        link: page(`/inbox/r-91c2`),
        since: now - 1 * DAY,
        code: [],
        untrusted: { title: `Apple Pay button does nothing on Safari 17` },
        actions: [`fix`, `resolve`, `snooze`],
        agent: { conversationId: `ph-applepay`, attempt: 1, stance: `needs-you`, label: `Question for you`, hint: `it has asked you something` },
    }),
    finding(`alert`, `al-77`, {
        kind: `Firing`,
        lane: `fix`,
        severity: `warning`,
        title: `Checkout conversion below 2%`,
        summary: `Checkout funnel, daily`,
        link: `${HOST}/project/${PROJECT}/alerts?alert_type=insights&alert_id=al-77`,
        since: now - 5 * HOUR,
        code: [],
        untrusted: { insight: `Checkout funnel, daily` },
        actions: [`fix`, `snooze`],
        agent: { conversationId: `ph-conversion`, attempt: 1, stance: `working`, label: `Agent working`, hint: `An agent is already working on this failure. Open the conversation to watch it.` },
    }),
];

// The rest: the owner's own step, a decision, PostHog's setup advice and an alert that is quiet.
const quietSeed = (now: number): DemoFinding[] => [
    finding(`health`, `019f42`, {
        kind: `authorized_urls`,
        lane: `step`,
        severity: `warning`,
        title: `No authorized URLs configured`,
        summary: `No authorized URLs configured. Some filters won't work correctly.`,
        link: page(`/web/health`),
        since: now - 40 * DAY,
        advice: `In PostHog, open Settings → Project → Web analytics and add every domain your site is served from to Authorized URLs.`,
        code: [],
        untrusted: {},
        actions: [`resolve`, `snooze`],
    }),
    finding(`experiment`, `311`, {
        kind: `running`,
        lane: `decide`,
        severity: `info`,
        title: `Free shipping banner`,
        summary: `free-shipping-banner`,
        link: page(`/experiments/311`),
        since: now - 23 * DAY,
        code: [],
        untrusted: { name: `Free shipping banner`, flag: `free-shipping-banner` },
        actions: [`fix`, `snooze`],
    }),
    finding(`setup`, `rec-alerts`, {
        kind: `alerts`,
        lane: `setup`,
        severity: `info`,
        title: `Error alerts are not wired`,
        summary: ``,
        link: page(`/error_tracking`),
        code: [],
        untrusted: {},
        actions: [`wire`, `dismiss`],
    }),
    finding(`alert`, `al-12`, {
        kind: `Not firing`,
        lane: `watch`,
        severity: `info`,
        title: `Weekly signups below 500`,
        summary: `Signups, weekly`,
        link: `${HOST}/project/${PROJECT}/alerts?alert_type=insights&alert_id=al-12`,
        since: now - 2 * HOUR,
        code: [],
        untrusted: { insight: `Signups, weekly` },
        actions: [],
    }),
];

const seed = (now: number): DemoFinding[] => [...owedSeed(now), ...quietSeed(now)];

let findings: DemoFinding[] | undefined;
let wired = false;
const current = (): DemoFinding[] => {
    findings ??= seed(Date.now());
    return findings;
};

const snapshot = () => ({
    connections: [{ id: `posthog`, host: HOST, project: `Acme Shop`, projectId: PROJECT, polledAt: Date.now() - 3 * 60_000, problems: [], wired }],
    findings: current(),
});

// One press on one finding, as the view sends it (`/findings/<id>/<verb>`).
const press = (id: string, verb: string): Response => {
    const target = current().find((each) => each.id === id);
    if (target === undefined) {
        return json({ error: `PostHog no longer reports that; read the board again` }, 404);
    }
    if (verb === `fix`) {
        const conversationId = `health-${target.sourceId}`;
        const title = `${target.lane === `decide` ? `Decide` : `Fix`}: ${target.title}`;
        putCard(workCard({ id: conversationId, title, now: Date.now(), startIn: `web`, todo: `Read what PostHog measured` }));
        findings = current().map((each) =>
            each.id === target.id ? { ...each, agent: { conversationId, attempt: 1, stance: `working`, label: `Agent working`, hint: `An agent is working on this.` } } : each,
        );
        return json({ conversationId });
    }
    findings = current().filter((each) => each.id !== target.id);
    return json({ ok: true });
};

// The demo's routes are exact paths, and its findings are known before anything is read: one route per finding and press,
// the id percent-encoded as the view's `encodeURIComponent` sends it.
const presses = Object.fromEntries(
    seed(0).flatMap(({ id }) =>
        [`fix`, `resolve`, `snooze`, `dismiss`].map((verb) => [`POST ${PRODUCT_HEALTH}/findings/${encodeURIComponent(id)}/${verb}`, () => press(id, verb)] as const),
    ),
);

export const productHealthBackend = {
    [`GET ${PRODUCT_HEALTH}/snapshot`]: () => json(snapshot()),
    [`POST ${PRODUCT_HEALTH}/refresh`]: () => json(snapshot()),
    [`POST ${PRODUCT_HEALTH}/connections/posthog/wire`]: () => {
        wired = true;
        findings = current().filter((each) => !(each.source === `setup` && each.kind === `alerts`));
        return json({ created: 3 });
    },
    ...presses,
} satisfies Readonly<Record<string, (context: RawContext) => Response>>;
