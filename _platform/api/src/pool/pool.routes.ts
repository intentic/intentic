import type { PrismaClient } from "@intentic-app/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { creditStatus, refundCredits, spendCredits } from "./pool-credits.js";
import { DEMO_SLUG, demoAnswer } from "./pool-demo.js";
import { applySubscription, isPremium, poolEnabled, premiumOf } from "./pool-membership.js";
import { forwardToService, verifyServiceSignature } from "./pool-services.js";
import { applyAccountEvent } from "../creator/creator-payouts.js";
import { accountFromEvent, type StripeGateway, stripeGateway, subscriptionFromEvent, verifyStripeSignature } from "./pool-stripe.js";
import { computeMonth, type DonationAggregate, type ServiceAggregate } from "./pool-share.js";

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

// "2026-08" for the month `shift` months before the one `at` falls in.
const monthShifted = (at: Date, shift: number): string => {
    const base = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - shift, 1));
    return base.toISOString().slice(0, 7);
};

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
        if (!(await premiumOf(prisma, ownerId))) {
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
        return c.json({ premium: await premiumOf(prisma, ownerId) });
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
        const [services, member] = await Promise.all([
            prisma.service.findMany({
                where: { active: true },
                select: { slug: true, publisher: true, name: true, description: true, creditsPerRun: true },
                orderBy: { slug: `asc` },
            }),
            premiumOf(prisma, ownerId),
        ]);
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
        if (service === null || !service.active) {
            return c.json({ error: `no such service` }, 404);
        }
        if (!(await premiumOf(prisma, ownerId))) {
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
        const result = await forwardToService(service.upstreamUrl, decryptSecret(config, service.secret), body, fetchFn, () => at);
        await prisma.serviceRun.create({
            data: { userId: ownerId, serviceId: service.id, credits: service.creditsPerRun, status: result.served ? `ok` : `refunded` },
        });
        if (!result.served) {
            await refundCredits(prisma, ownerId, service.creditsPerRun, at);
            c.get(`logger`)?.warn({ service: service.slug, status: result.status }, `pool: service did not serve — run refunded`);
            return c.json(
                { error: { type: `service_unavailable`, message: `${service.name} did not answer — nothing was charged. Please try again shortly.` } },
                502,
            );
        }
        return c.newResponse(result.body, result.status as 200, {
            "content-type": result.contentType,
            // Advisory, like the trial's remaining-count header: any UI can show the meter without a second call.
            "x-intentic-credits-remaining": String(spend.remaining),
        });
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
        const query = (JSON.parse(body || `{}`) as { query?: unknown }).query;
        return c.json(demoAnswer(typeof query === `string` ? query : `(no query)`));
    });

    /* The public ledger: this month and the two before it, as the pool math states them (pool-share.ts).
     * Member count is TODAY's active-membership count for every month shown — the platform keeps no status
     * history, and publishing an exact-looking reconstruction would be less honest than a stated snapshot.
     * The docs page says exactly this; payouts, when they land, settle on a month's closing numbers. */
    app.get(`/transparency`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const at = now();
        const months = [2, 1, 0].map((shift) => monthShifted(at, shift));
        const [donations, memberships, runs] = await Promise.all([
            prisma.donation.findMany({
                where: { month: { gte: months[0]! } },
                select: { extensionId: true, month: true, credits: true },
            }),
            prisma.membership.findMany({ select: { status: true } }),
            // Only served runs earn — a refunded run charged nobody and pays nobody, but its row keeps the
            // service's reliability visible to anyone who queries deeper.
            prisma.serviceRun.findMany({
                where: { status: `ok`, createdAt: { gte: new Date(`${months[0]}-01T00:00:00.000Z`) } },
                select: { credits: true, createdAt: true, service: { select: { slug: true, publisher: true } } },
            }),
        ]);
        const members = memberships.filter((membership) => isPremium(membership)).length;
        // (month → aggregates), priced by pool-share.ts inside computeMonth.
        const donationsOf = (month: string): DonationAggregate[] => {
            const byExtension = new Map<string, DonationAggregate>();
            for (const donation of donations) {
                if (donation.month !== month) {
                    continue;
                }
                const previous = byExtension.get(donation.extensionId);
                byExtension.set(donation.extensionId, {
                    extensionId: donation.extensionId,
                    donors: (previous?.donors ?? 0) + 1,
                    credits: (previous?.credits ?? 0) + donation.credits,
                });
            }
            return [...byExtension.values()];
        };
        const servicesOf = (month: string): ServiceAggregate[] => {
            const byService = new Map<string, ServiceAggregate>();
            for (const run of runs) {
                if (!run.createdAt.toISOString().startsWith(`${month}-`)) {
                    continue;
                }
                const previous = byService.get(run.service.slug);
                byService.set(run.service.slug, {
                    slug: run.service.slug,
                    publisher: run.service.publisher,
                    runs: (previous?.runs ?? 0) + 1,
                    credits: (previous?.credits ?? 0) + run.credits,
                });
            }
            return [...byService.values()];
        };
        return c.json({
            priceUsd: config.pool.priceUsd,
            creatorShare: config.pool.creatorShare,
            serviceShare: config.pool.serviceShare,
            dailyCredits: config.pool.dailyCredits,
            donationCredits: config.pool.donationCredits,
            months: months.map((month) => computeMonth(month, members, config, donationsOf(month), servicesOf(month))).toReversed(),
        });
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
        const event = z
            .object({ type: z.string(), data: z.object({ object: z.unknown() }) })
            .safeParse(JSON.parse(payload));
        if (!event.success) {
            return c.json({ error: `malformed event` }, 400);
        }
        const { type, data } = event.data;
        if (type === `checkout.session.completed`) {
            const session = z
                .object({ mode: z.string(), client_reference_id: z.string().nullable(), subscription: z.string().nullable() })
                .safeParse(data.object);
            if (session.success && session.data.mode === `subscription` && session.data.client_reference_id !== null && session.data.subscription !== null) {
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
