import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/* THE EXAMPLE PROVIDER — a complete, working paid service, written to be copied.
 *
 * This is everything a third-party provider implements to be listed on intentic's services catalog: ONE
 * https endpoint that (1) verifies the platform's signature on every call — refusing forgeries and replays,
 * which is two of the three checks the admission probe runs against you — and (2) answers NDJSON, `status`
 * lines while it works and exactly one `result` that ends the run (the third check). Nothing else: no SDK,
 * no account with anyone, no inbound credentials. The platform is the only caller that can produce a valid
 * signature, so the signature IS your auth.
 *
 * It is deliberately dependency-free: the whole contract fits in the Web platform (Request/Response/
 * ReadableStream) plus node:crypto, and reference code with a framework in it documents the framework.
 *
 * Like the platform's own demo service, the request picks the outcome (`scenario`) and the stream's tempo
 * (`paceMs`) — test-card style — so a platform operator pointing a staging catalog at this endpoint can
 * reproduce every settlement on demand: the happy stream, the long run, the paid refusal (4xx), the refunded
 * failure (5xx), and the refunded broken stream. A real service would replace `answerOf` and the scenario
 * switch with actual work and keep everything else. */

// How far a call's timestamp may sit from now before it is refused as a replay — the platform signs with the
// current time and its admission probe checks that an hour-old capture dies here.
const SIGNATURE_TOLERANCE_S = 300;

/* The provider's whole verification: recompute HMAC-SHA256(secret, "{timestamp}.{body}") and compare
 * constant-time. The same scheme Stripe signs webhooks with; the platform's forward sends exactly this. */
export const verifySignature = (
    body: string,
    timestamp: string | undefined,
    signature: string | undefined,
    secret: string,
    now: () => Date = () => new Date(),
): boolean => {
    const at = Number(timestamp);
    if (timestamp === undefined || signature === undefined || !Number.isFinite(at) || Math.abs(now().getTime() / 1000 - at) > SIGNATURE_TOLERANCE_S) {
        return false;
    }
    const expected = createHmac(`sha256`, secret).update(`${timestamp}.${body}`).digest(`hex`);
    const a = Buffer.from(signature, `utf8`);
    const b = Buffer.from(expected, `utf8`);
    return a.length === b.length && timingSafeEqual(a, b);
};

/* ── The scenarios — the same request vocabulary as the platform's demo service, on purpose ──────────────
 * ok / slow stream to a result; refuse answers a complete paid 4xx; fail answers a 5xx the platform refunds;
 * broken streams and then dies without its result (also refunded). Unrecognized reads as `ok`. */

const SCENARIOS = [`ok`, `slow`, `refuse`, `fail`, `broken`] as const;
type Scenario = (typeof SCENARIOS)[number];

const PACE_DEFAULT_MS: Record<Scenario, number> = { ok: 800, slow: 2500, refuse: 0, fail: 0, broken: 800 };
// Bounded well under the platform's five-minute run deadline — a stream that outlives it is refunded.
const PACE_MAX_MS = 3000;

interface ProviderRequest {
    readonly query: string;
    readonly scenario: Scenario;
    readonly paceMs: number;
}

const parseRequest = (body: string): ProviderRequest => {
    let raw: { query?: unknown; scenario?: unknown; paceMs?: unknown } = {};
    try {
        raw = JSON.parse(body === `` ? `{}` : body) as typeof raw;
    } catch {
        // An unparseable body is still an answerable request — a real service would `refuse` it instead.
    }
    const scenario = SCENARIOS.find((known) => known === raw.scenario) ?? `ok`;
    const pace = typeof raw.paceMs === `number` && Number.isFinite(raw.paceMs) ? raw.paceMs : PACE_DEFAULT_MS[scenario];
    return {
        query: typeof raw.query === `string` ? raw.query : `(no query)`,
        scenario,
        paceMs: Math.min(Math.max(Math.trunc(pace), 0), PACE_MAX_MS),
    };
};

// The `result` event's `data` — the answer the member's agent acts on. A real service does its real work
// here; this one answers a labelled canned summary so nobody mistakes it for research.
const answerOf = (query: string): object => ({
    example: true,
    query,
    summary: `Example answer for "${query}": this endpoint is the reference implementation of a paid service — it verified the platform's signature, streamed its progress, and a real provider would answer here.`,
    sources: [{ title: `Offer a paid service`, url: `https://intentic.dev/developers/services/` }],
});

// A run's stream, per scenario: `status` lines (each replaces the last on the member's card — a progress
// label, not a log), then the one `result`. `broken` violates the contract on purpose: statuses, then silence.
const linesOf = ({ query, scenario }: ProviderRequest): readonly object[] => {
    if (scenario === `slow`) {
        return [
            { event: `status`, text: `Accepting the job…` },
            { event: `status`, text: `Fetching the first batch…` },
            { event: `status`, text: `Fetching the second batch…` },
            { event: `status`, text: `Cross-checking…` },
            { event: `status`, text: `Discarding weak sources…` },
            { event: `status`, text: `Ranking what held up…` },
            { event: `status`, text: `Writing the summary…` },
            { event: `result`, data: answerOf(query) },
        ];
    }
    if (scenario === `broken`) {
        return [
            { event: `status`, text: `Accepting the job…` },
            { event: `status`, text: `About to misbehave: this stream ends without a result, and the platform refunds the run…` },
        ];
    }
    return [
        { event: `status`, text: `Accepting the job…` },
        { event: `status`, text: `Writing the summary…` },
        { event: `result`, data: answerOf(query) },
    ];
};

const ndjson = (lines: readonly object[], paceMs: number): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const [index, line] of lines.entries()) {
                if (index > 0 && paceMs > 0) {
                    await sleep(paceMs);
                }
                controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            }
            controller.close();
        },
    });
};

const json = (body: object, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

export interface ProviderOptions {
    // The signing secret the platform answered ONCE when the listing was drafted — hold it like a password.
    readonly secret: string;
    // Test seam; the clock replays are judged against.
    readonly now?: () => Date;
}

/* The whole service as one fetch handler — servable by Bun.serve, a Node fetch adapter, or an edge runtime
 * unchanged. GET /healthz is for your own uptime checks; every POST is a metered run. */
export const createProvider = ({ secret, now = () => new Date() }: ProviderOptions): { fetch: (request: Request) => Promise<Response> } => ({
    fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (request.method === `GET` && url.pathname === `/healthz`) {
            return json({ ok: true }, 200);
        }
        if (request.method !== `POST`) {
            return json({ error: `metered runs are POSTs` }, 405);
        }
        const body = await request.text();
        /* The gate everything hangs on: an endpoint that answers an unsigned call can be billed by anyone on
         * the internet against your own upstream costs — which is why the admission probe sends a forged and
         * a replayed call and refuses to list you unless BOTH die here. */
        if (!verifySignature(body, request.headers.get(`x-intentic-timestamp`) ?? undefined, request.headers.get(`x-intentic-signature`) ?? undefined, secret, now)) {
            return json({ error: `bad signature — only calls forwarded by the platform are served` }, 401);
        }
        const parsed = parseRequest(body);
        if (parsed.scenario === `refuse`) {
            // A 4xx is a COMPLETE answer the member pays for ("your query was malformed" is the service
            // serving exactly what was asked) — the platform relays it verbatim.
            return json({ error: { type: `example_refusal`, message: `The example service declined this query on purpose (scenario "refuse").` } }, 400);
        }
        if (parsed.scenario === `fail`) {
            // A 5xx (or a timeout, or a dead socket) is a run nobody served — the platform refunds it.
            return json({ error: `the example service fell over on purpose (scenario "fail")` }, 500);
        }
        return new Response(ndjson(linesOf(parsed), parsed.paceMs), { status: 200, headers: { "content-type": `application/x-ndjson` } });
    },
});
