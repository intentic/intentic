import type { PrismaClient } from "@intentic-app/prisma";
import type { ServiceRunReceipt } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { LIVE_STATUSES, type ServiceStatus } from "./pool-admission.js";
import { creditStatus, refundCredits, spendCredits } from "./pool-credits.js";
import { DEMO_SLUG, demoRespond, parseDemoRequest } from "./pool-demo.js";
import { buildLedger } from "./pool-ledger.js";
import { applySubscription, poolEnabled, premiumOf } from "./pool-membership.js";
import { forwardToService, verifyServiceSignature } from "./pool-services.js";
import { applyAccountEvent } from "../creator/creator-payouts.js";
import { accountFromEvent, type StripeGateway, stripeGateway, subscriptionFromEvent, verifyStripeSignature } from "./pool-stripe.js";

/* THE CREATOR POOL's sandbox-facing and public routes. The browser-facing half (membership state, checkout,
 * portal) rides the oRPC contract in pool.orpc.ts; what lives here is what a BROWSER SESSION cannot
 * authenticate: the daemon's ledger report and premium probe (connect-token auth, the trial's ownerOf
 * pattern), Stripe's webhook (signature auth), and the transparency read (public on purpose — an economy
 * whose numbers need a login is not the promise).
 *
 * Everything 404s while the pool is unconfigured, trial-style: a self-hosted platform that sells nothing
 * has nothing here, and saying so tersely beats explaining. */

// Mirrors the contract's extension-id shape (publisher.name) — the ledger must not become a store of
// arbitrary strings somebody's daemon sent.
const EXTENSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/;

const DonateSchema = z.object({ extensionId: z.string().regex(EXTENSION_ID_RE) });

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export interface PoolDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injectable so tests drive checkout/webhook flows without Stripe, like the trial pool's fetchFn.
    readonly gateway?: StripeGateway;
    // Injectable so tests drive the service forward without a network — the trial pool's pattern.
    readonly fetchFn?: typeof fetch;
    readonly now?: () => Date;
}

export const poolHttpRoutes = ({ config, prisma, gateway, fetchFn = fetch, now = () => new Date() }: PoolDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    // Lazy: built on the first webhook that needs it, so mounting the sub-app on a pool-less platform (every
    // test config, most self-hosted ones) constructs nothing Stripe-shaped.
    const stripe = (): StripeGateway => gateway ?? stripeGateway(config.pool.stripeSecretKey, fetch, now);

    // 404-not-401 for an unknown token, the trial's reasoning verbatim: neither a probe nor a disabled pool
    // should teach a caller which part was wrong.
    const ownerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<string | undefined> => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return undefined;
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { ownerId: true } });
        return sandbox?.ownerId;
    };

    /* THE INSTALL DONATION — how a non-service premium extension gets paid, and the platform's ONLY signal
     * about one (no usage telemetry exists; the docs say so as a promise). The daemon calls this while a
     * premium install/update is being applied. Idempotent per (member, extension, month) by the unique key:
     * a reinstall answers `donated: 0` and charges nothing, an update in a later month donates again — at
     * most twelve donations per install per year, which is also what bounds an update-spamming publisher.
     * The spend rides the same daily meter as service runs, with the same optimistic-then-refund discipline
     * and the same typed refusals, so every surface already knows how to say what happened. */
    app.post(`/donate`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const parsed = DonateSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: `malformed donation` }, 400);
        }
        if (!(await premiumOf(prisma, config, ownerId))) {
            return c.json({ error: { type: `membership_required`, message: `Installing a premium extension needs an intentic membership.` } }, 403);
        }
        const at = now();
        const month = utcDay(at).slice(0, 7);
        const { extensionId } = parsed.data;
        const existing = await prisma.donation.findUnique({ where: { userId_extensionId_month: { userId: ownerId, extensionId, month } } });
        if (existing !== null) {
            return c.json({ donated: 0, message: `already supported this month — nothing charged` });
        }
        const amount = config.pool.donationCredits;
        const spend = await spendCredits(prisma, config, ownerId, amount, at);
        if (!spend.allowed) {
            await refundCredits(prisma, ownerId, amount, at);
            return c.json(
                {
                    error: {
                        type: `insufficient_credits`,
                        message: `Supporting this extension costs ${amount} credits and ${spend.remaining} are left today. The allowance resets at ${spend.resetsAt}.`,
                    },
                    credits: { allowance: spend.allowance, remaining: spend.remaining, resetsAt: spend.resetsAt },
                },
                429,
            );
        }
        try {
            await prisma.donation.create({ data: { userId: ownerId, extensionId, month, credits: amount } });
        } catch {
            // Two installs racing the same month: the unique key let exactly one row in; this loser's spend
            // goes back and the answer is the same "already supported" the reinstall path gives.
            await refundCredits(prisma, ownerId, amount, at);
            return c.json({ donated: 0, message: `already supported this month — nothing charged` });
        }
        return c.json({ donated: amount, remaining: spend.remaining });
    });

    // The daemon's premium probe — what gates enabling a premium extension. Spends nothing; polling is free.
    app.get(`/status`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        return c.json({ premium: await premiumOf(prisma, config, ownerId) });
    });

    /* The services catalog, plus where the caller's allowance stands — the read behind every "this run costs
     * N credits (M left today)" surface. Everyone with a sandbox sees the catalog (a non-member deciding
     * whether to join should see what membership buys); only a member gets a credit meter, because only a
     * member has one. */
    app.get(`/services`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const [rows, member] = await Promise.all([
            prisma.service.findMany({
                where: { status: { in: [...LIVE_STATUSES] } },
                select: { slug: true, publisher: true, name: true, description: true, creditsPerRun: true, status: true, sampleRequest: true },
                orderBy: { slug: `asc` },
            }),
            premiumOf(prisma, config, ownerId),
        ]);
        /* `probation` is flattened to one boolean here rather than leaking the status vocabulary to every
         * reader: what a member's card needs to say is "this listing is new", and what an agent needs to know
         * is nothing at all. `sampleRequest` rides along because an agent composing a request body with a
         * worked example in front of it writes a better one — it is the listing's own documentation. */
        const services = rows.map(({ status, ...service }) => ({ ...service, probation: status === `probation` }));
        const credits = member ? await creditStatus(prisma, config, ownerId, now()) : undefined;
        return c.json({ member, services, ...(credits !== undefined ? { credits } : {}) });
    });

    /* ONE METERED RUN — the whole intermediary in one handler. Spend first (atomic, or two concurrent runs
     * race through the same headroom), forward signed, refund whatever did not serve. Two different
     * refusals with two different refunds:
     *   - insufficient credits → the optimistic increment is given back (unlike the trial's 1-message slot,
     *     an N-credit bite out of a refused attempt would eat real remaining allowance);
     *   - provider failure (5xx / timeout / dead socket) → full refund, and the run row says `refunded`, so
     *     a flaky service is visible in its own public numbers.
     * A provider's 4xx is an ANSWER — the caller pays for it and reads it verbatim, because "your query was
     * malformed" is the service serving exactly what was asked. */
    app.post(`/services/:slug/run`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const service = await prisma.service.findUnique({ where: { slug: c.req.param(`slug`) } });
        if (service === null || !LIVE_STATUSES.includes(service.status as ServiceStatus)) {
            return c.json({ error: `no such service` }, 404);
        }
        if (!(await premiumOf(prisma, config, ownerId))) {
            return c.json({ error: { type: `membership_required`, message: `Running ${service.name} needs an intentic membership.` } }, 403);
        }
        const body = await c.req.text();
        if (body.length > 1_000_000) {
            return c.json({ error: `request too large` }, 413);
        }
        const at = now();
        const spend = await spendCredits(prisma, config, ownerId, service.creditsPerRun, at);
        if (!spend.allowed) {
            await refundCredits(prisma, ownerId, service.creditsPerRun, at);
            return c.json(
                {
                    error: {
                        type: `insufficient_credits`,
                        message: `This run costs ${service.creditsPerRun} credits and ${spend.remaining} are left today. The allowance resets at ${spend.resetsAt}.`,
                    },
                    credits: { allowance: spend.allowance, remaining: spend.remaining, resetsAt: spend.resetsAt },
                },
                429,
            );
        }
        /* The demo's upstream is this very app, so its forward dispatches in-process instead of over a
         * socket — same signing, same verification, same stream validation, minus the network hop back to
         * ourselves. Not an optimization: the platform's own https address is not reliably reachable FROM the
         * platform (dev's minted certificate fails Bun's TLS stack outright; prod would loop out through the
         * proxy), and a demo that refunds every run wherever the loopback is awkward demonstrates nothing. */
        const dispatch =
            service.slug === DEMO_SLUG
                ? ((async (url: string | URL | Request, init?: RequestInit) =>
                      app.request(new URL(String(url)).pathname.replace(/^\/pool/, ``), init)) as typeof fetch)
                : fetchFn;
        const forward = await forwardToService(service.upstreamUrl, decryptSecret(config, service.secret), body, dispatch, () => at);
        if (forward.kind === `failed`) {
            await prisma.serviceRun.create({
                data: { userId: ownerId, serviceId: service.id, credits: service.creditsPerRun, status: `refunded` },
            });
            await refundCredits(prisma, ownerId, service.creditsPerRun, at);
            c.get(`logger`)?.warn({ service: service.slug }, `pool: service did not serve — run refunded`);
            return c.json(
                {
                    error: {
                        type: `service_unavailable`,
                        message: `${service.name} did not answer — nothing was charged. Please try again shortly.`,
                    },
                },
                502,
            );
        }
        if (forward.kind === `answered`) {
            // The provider's own refusal (a 4xx) — a complete, PAID answer, relayed verbatim as ever.
            await prisma.serviceRun.create({
                data: { userId: ownerId, serviceId: service.id, credits: service.creditsPerRun, status: `ok` },
            });
            return c.newResponse(forward.body, forward.status as 200, {
                "content-type": forward.contentType,
                // Advisory, like the trial's remaining-count header: any UI can show the meter without a second call.
                "x-intentic-credits-remaining": String(spend.remaining),
            });
        }
        /* The stream: every validated provider event relayed the moment it arrives, then the LEDGER's own last
         * word — a `receipt` trailer this handler appends after the stream settles, because whether the run
         * served (and so whether the charge stood or was reversed) is only knowable at the end, when the
         * response's status line is long gone. The trailer is the platform speaking, never the provider. */
        const logger = c.get(`logger`);
        const encoder = new TextEncoder();
        const relayed = new ReadableStream<Uint8Array>({
            async start(controller) {
                let served = false;
                try {
                    while (true) {
                        const next = await forward.events.next();
                        if (next.done) {
                            served = next.value;
                            break;
                        }
                        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
                    }
                } catch {
                    served = false;
                }
                try {
                    await prisma.serviceRun.create({
                        data: { userId: ownerId, serviceId: service.id, credits: service.creditsPerRun, status: served ? `ok` : `refunded` },
                    });
                    if (!served) {
                        await refundCredits(prisma, ownerId, service.creditsPerRun, at);
                        logger?.warn({ service: service.slug }, `pool: service stream ended without a result — run refunded`);
                    }
                } catch (error) {
                    logger?.error({ service: service.slug, error }, `pool: failed to record a streamed run`);
                }
                const receipt: ServiceRunReceipt = {
                    event: `receipt`,
                    outcome: served ? `ok` : `refunded`,
                    credits: service.creditsPerRun,
                    ...(served ? { remaining: spend.remaining } : {}),
                };
                controller.enqueue(encoder.encode(`${JSON.stringify(receipt)}\n`));
                controller.close();
            },
        });
        return c.newResponse(relayed, 200, { "content-type": `application/x-ndjson` });
    });

    /* The demo service's upstream (pool-demo.ts) — the platform answering its own forwarded calls, verifying
     * the signature exactly as a real provider must. Refusing an unsigned call is half the demo's value: it
     * shows the intermediary promise (only intentic can invoke a provider) actually holding. */
    app.post(`/demo/upstream`, async (c) => {
        if (!poolEnabled(config) || !config.pool.demoService) {
            return c.json({ error: `the demo service is not enabled on this platform` }, 404);
        }
        const service = await prisma.service.findUnique({ where: { slug: DEMO_SLUG } });
        if (service === null) {
            return c.json({ error: `the demo service is not seeded` }, 404);
        }
        const body = await c.req.text();
        const verified = verifyServiceSignature(
            body,
            c.req.header(`x-intentic-timestamp`),
            c.req.header(`x-intentic-signature`),
            decryptSecret(config, service.secret),
            now,
        );
        if (!verified) {
            return c.json({ error: `bad signature — only calls forwarded by the platform are served` }, 401);
        }
        const answer = demoRespond(parseDemoRequest(body));
        if (answer.kind === `answer`) {
            return c.json(JSON.parse(answer.body), answer.status);
        }
        return c.newResponse(answer.stream, 200, { "content-type": `application/x-ndjson` });
    });

    /* The public ledger (pool-ledger.ts): the month in progress computed live and marked open, then every
     * closed month exactly as it was frozen. Public on purpose — an economy whose numbers need a login is not
     * the promise. Member count on the OPEN month is today's snapshot, because the platform keeps no
     * membership history; a closed month's is the count recorded when it closed. */
    app.get(`/transparency`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        // Cross-origin because the site renders this ledger from a different host, and a public number that
        // only a server can read is not really public.
        c.header(`access-control-allow-origin`, `*`);
        return c.json(await buildLedger(prisma, config, now()));
    });

    /* Stripe's webhook. Signature-authenticated against the RAW body; a pool that is enabled but has no
     * webhook secret refuses everything with 400 — that is a misconfiguration to surface, not to absorb.
     * Unrecognized event types ack with 200 so Stripe stops retrying them. */
    app.post(`/webhook`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const payload = await c.req.text();
        if (!verifyStripeSignature(payload, c.req.header(`stripe-signature`), config.pool.stripeWebhookSecret, now)) {
            return c.json({ error: `bad signature` }, 400);
        }
        const event = z.object({ type: z.string(), data: z.object({ object: z.unknown() }) }).safeParse(JSON.parse(payload));
        if (!event.success) {
            return c.json({ error: `malformed event` }, 400);
        }
        const { type, data } = event.data;
        if (type === `checkout.session.completed`) {
            const session = z
                .object({ mode: z.string(), client_reference_id: z.string().nullable(), subscription: z.string().nullable() })
                .safeParse(data.object);
            if (
                session.success &&
                session.data.mode === `subscription` &&
                session.data.client_reference_id !== null &&
                session.data.subscription !== null
            ) {
                await applySubscription(prisma, await stripe().subscription(session.data.subscription), session.data.client_reference_id);
            }
        } else if (type === `customer.subscription.updated` || type === `customer.subscription.deleted`) {
            const subscription = subscriptionFromEvent(data.object, now);
            if (subscription !== undefined) {
                await applySubscription(prisma, subscription);
            }
        } else if (type === `account.updated`) {
            // A creator's payout readiness changing — the fast path that keeps the settings screen right
            // without anyone looking at it. The creator surface also reads through to Stripe while an account
            // is unfinished, so neither this nor that is the only way the answer becomes true.
            const account = accountFromEvent(data.object);
            if (account !== undefined) {
                await applyAccountEvent(prisma, account);
            }
        }
        return c.json({ received: true });
    });

    return app;
};
