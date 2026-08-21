import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { encryptSecret } from "../crypto.js";
import { poolEnabled } from "./pool-membership.js";

/* THE DEMO SERVICE, a complete, working premium service the platform itself hosts, so the catalog is never
 * an empty promise and the whole metered path (spend → signed forward → answer → credits header; refund on
 * failure) is demonstrable end to end without recruiting a provider. Its upstream is the platform's own
 * /pool/demo/upstream, which verifies the forwarded signature exactly as a real provider would, making it
 * doubly useful as living documentation of what a provider implements.
 *
 * THE REQUEST PICKS THE OUTCOME, test-card style: `scenario` selects which side of the metered contract to
 * demonstrate (the happy stream, a slow run, a paid refusal, a refunded failure, a refunded broken stream),
 * and `paceMs` sets how fast the stream breathes, because the flow's every look (the live status line, the
 * receipt that says charged, the receipt that says refunded) should be reproducible on demand rather than
 * waiting for a real provider to fail interestingly.
 *
 * Seeded at boot behind POOL_DEMO_SERVICE, the trial's off-by-default posture: on, the row is (re)activated
 * with a per-platform random secret minted once and stored encrypted like any service secret; off, the row
 * is delisted rather than deleted, so its run history stays on the ledger. */

export const DEMO_SLUG = `demo-research`;

export const seedDemoService = async (prisma: PrismaClient, config: Config): Promise<void> => {
    if (!poolEnabled(config)) {
        return;
    }
    const existing = await prisma.service.findUnique({ where: { slug: DEMO_SLUG } });
    if (!config.pool.demoService) {
        // Back to `draft` rather than `suspended`: the flag being off is an operator's choice, and the
        // suspended state is the watch's word for a provider that failed. The row and its runs stay either way.
        if (existing !== null && existing.status !== `draft`) {
            await prisma.service.update({ where: { slug: DEMO_SLUG }, data: { status: `draft` } });
        }
        return;
    }
    const state = {
        publisher: `intentic`,
        name: `Demo Research`,
        description:
            `A demonstration research run: answers a canned summary for any query, so you can watch the metered flow end to end. ` +
            `The request's optional "scenario" picks the outcome (ok, slow, refuse, fail, broken) and "paceMs" the stream's tempo.`,
        // Named for what it is, though a demo run never crosses a socket: the route dispatches the demo's
        // forward into its own app (pool.routes.ts), because the platform's public address is not reliably
        // reachable from the platform itself. Signing and verification are the real thing either way.
        upstreamUrl: new URL(`/pool/demo/upstream`, config.api.url).toString(),
        creditsPerRun: 5,
        sampleRequest: JSON.stringify({ query: `which subreddits fit a self-hosted agent workspace?`, scenario: `ok` }),
        // An operator row, owned by nobody: exempt from the admission gates it never passed and from the
        // watch that governs the providers who did.
        status: `listed`,
    };
    if (existing === null) {
        await prisma.service.create({ data: { slug: DEMO_SLUG, secret: encryptSecret(config, randomBytes(24).toString(`hex`)), ...state } });
        return;
    }
    // Keep the minted secret; refresh everything else, so a flag flip or a copy change never rotates what a
    // running platform signs with mid-flight.
    await prisma.service.update({ where: { slug: DEMO_SLUG }, data: state });
};

/* ── The scenarios, every way a metered run can settle, each reproducible on demand ─────────────────────
 *
 *   ok      the happy path: paced status lines, then the result (charged; the receipt says ok)
 *   slow    the long run: many status lines at a slower pace, what five patient minutes look like
 *   refuse  a provider 4xx: a complete, PAID answer ("your query was malformed"), relayed verbatim
 *   fail    a provider 5xx: no answer at all, the platform refunds before anyone sees a body
 *   broken  a stream that dies without its result, the mid-stream refund and the `refunded` receipt trailer
 *
 * Anything unrecognized reads as `ok`, because a demo that punishes a typo demonstrates nothing. */

const SCENARIOS = [`ok`, `slow`, `refuse`, `fail`, `broken`] as const;
export type DemoScenario = (typeof SCENARIOS)[number];

// The stream's tempo: enough gap for a human to see a status line replace the last, bounded so no request
// can hold the upstream anywhere near the forward's five-minute run deadline.
const PACE_DEFAULT_MS: Record<DemoScenario, number> = { ok: 800, slow: 2500, refuse: 0, fail: 0, broken: 800 };
const PACE_MAX_MS = 3000;

export interface DemoRequest {
    readonly query: string;
    readonly scenario: DemoScenario;
    readonly paceMs: number;
}

export const parseDemoRequest = (body: string): DemoRequest => {
    let raw: { query?: unknown; scenario?: unknown; paceMs?: unknown } = {};
    try {
        raw = JSON.parse(body === `` ? `{}` : body) as typeof raw;
    } catch {
        // An unparseable body still demos: the platform forwards bytes, and the demo's job is to answer.
    }
    const scenario = SCENARIOS.find((known) => known === raw.scenario) ?? `ok`;
    const pace = typeof raw.paceMs === `number` && Number.isFinite(raw.paceMs) ? raw.paceMs : PACE_DEFAULT_MS[scenario];
    return {
        query: typeof raw.query === `string` ? raw.query : `(no query)`,
        scenario,
        paceMs: Math.min(Math.max(Math.trunc(pace), 0), PACE_MAX_MS),
    };
};

// The canned answer the demo upstream serves, deliberately shaped like a real research result, so an agent
// quoting it in chat reads plausibly, and deliberately labelled, so nobody mistakes it for one.
const demoAnswer = (query: string): object => ({
    demo: true,
    query,
    summary: `Demo summary for "${query}": this canned answer proves the metered path end to end, your credits were spent, the call was signature-verified, and a real provider would answer here.`,
    sources: [{ title: `The creator pool, documented`, url: `https://intentic.dev/api/earn/` }],
});

// The stream's lines per scenario. NDJSON events in the contract's ServiceStreamEvent vocabulary, status
// lines then the one `result`. `broken` is the contract violated on purpose: statuses, then silence.
const demoLines = ({ query, scenario }: DemoRequest): readonly object[] => {
    if (scenario === `slow`) {
        return [
            { event: `status`, text: `Warming the demo corpus…` },
            { event: `status`, text: `Reading the first shelf…` },
            { event: `status`, text: `Reading the second shelf…` },
            { event: `status`, text: `Cross-checking sources…` },
            { event: `status`, text: `Discarding the weak ones…` },
            { event: `status`, text: `Ranking what held up…` },
            { event: `status`, text: `Composing the summary…` },
            { event: `result`, data: demoAnswer(query) },
        ];
    }
    if (scenario === `broken`) {
        return [
            { event: `status`, text: `Searching the demo corpus…` },
            { event: `status`, text: `About to misbehave: this stream ends without a result, and the platform refunds the run…` },
        ];
    }
    return [
        { event: `status`, text: `Searching the demo corpus…` },
        { event: `status`, text: `Composing the summary…` },
        { event: `result`, data: demoAnswer(query) },
    ];
};

/* What the demo upstream answers, decided per scenario, either a complete HTTP answer (the paid 4xx, the
 * refunded 5xx) or a paced NDJSON stream. Being the living reference of the wire format is half this
 * service's job: the platform's own forward parses these exact lines, so the documented shape cannot drift
 * from the enforced one. */
export type DemoResponse =
    | { readonly kind: `answer`; readonly status: 400 | 500; readonly body: string }
    | { readonly kind: `stream`; readonly stream: ReadableStream<Uint8Array> };

export const demoRespond = (request: DemoRequest): DemoResponse => {
    if (request.scenario === `refuse`) {
        return {
            kind: `answer`,
            status: 400,
            body: JSON.stringify({
                error: {
                    type: `demo_refusal`,
                    message: `The demo declined this query on purpose (scenario "refuse"), a provider's 4xx is a complete, paid answer, relayed verbatim.`,
                },
            }),
        };
    }
    if (request.scenario === `fail`) {
        return {
            kind: `answer`,
            status: 500,
            body: JSON.stringify({ error: `the demo fell over on purpose (scenario "fail"), the platform refunds a run nobody served` }),
        };
    }
    const lines = demoLines(request);
    const encoder = new TextEncoder();
    return {
        kind: `stream`,
        stream: new ReadableStream<Uint8Array>({
            async start(controller) {
                for (const [index, line] of lines.entries()) {
                    if (index > 0 && request.paceMs > 0) {
                        await sleep(request.paceMs);
                    }
                    controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
                }
                controller.close();
            },
        }),
    };
};
