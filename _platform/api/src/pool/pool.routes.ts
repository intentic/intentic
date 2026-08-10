import type { PrismaClient } from "@intentic-app/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { applySubscription, isPremium, poolEnabled, premiumOf } from "./pool-membership.js";
import { type StripeGateway, stripeGateway, subscriptionFromEvent, verifyStripeSignature } from "./pool-stripe.js";
import { computeMonth } from "./pool-share.js";

/* THE CREATOR POOL's sandbox-facing and public routes. The browser-facing half (membership state, checkout,
 * portal) rides the oRPC contract in pool.orpc.ts; what lives here is what a BROWSER SESSION cannot
 * authenticate: the daemon's ledger report and premium probe (connect-token auth, the trial's ownerOf
 * pattern), Stripe's webhook (signature auth), and the transparency read (public on purpose — an economy
 * whose numbers need a login is not the promise).
 *
 * Everything 404s while the pool is unconfigured, trial-style: a self-hosted platform that sells nothing
 * has nothing here, and saying so tersely beats explaining. */

// The daemon reports a 7-day tail; accepting a wider window only means a long-offline sandbox still lands
// what it held. Days older than this are refused (silently dropped) rather than back-filling history the
// transparency page already published.
const ACCEPT_DAYS = 35;
// Rows per report — a sandbox can't use more extensions×days than this in a window; anything bigger is a
// client bug or a flood, and either way the answer is 400.
const MAX_ROWS = 1000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Mirrors the contract's extension-id shape (publisher.name) — the ledger must not become a store of
// arbitrary strings somebody's daemon sent.
const EXTENSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/;

const ReportSchema = z.object({
    rows: z.array(z.object({ extensionId: z.string().regex(EXTENSION_ID_RE), day: z.string().regex(DAY_RE) })).max(MAX_ROWS),
});

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const dayShifted = (day: string, days: number): string => {
    const at = new Date(`${day}T00:00:00.000Z`);
    at.setUTCDate(at.getUTCDate() + days);
    return utcDay(at);
};

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
    readonly now?: () => Date;
}

export const poolHttpRoutes = ({ config, prisma, gateway, now = () => new Date() }: PoolDeps) => {
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

    /* The daemon's ledger report: (extensionId, day) rows, idempotent by the table's unique key so the 7-day
     * tail a daemon re-sends every few hours is free. Out-of-window days are dropped rather than refused —
     * they are not an error the daemon can fix, just history the ledger no longer takes. */
    app.post(`/report`, async (c) => {
        if (!poolEnabled(config)) {
            return c.json({ error: `the creator pool is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const parsed = ReportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: `malformed report` }, 400);
        }
        const today = utcDay(now());
        const oldest = dayShifted(today, -(ACCEPT_DAYS - 1));
        const rows = parsed.data.rows.filter((row) => row.day >= oldest && row.day <= today);
        if (rows.length > 0) {
            await prisma.extensionUseDay.createMany({
                data: rows.map((row) => ({ userId: ownerId, extensionId: row.extensionId, day: row.day })),
                skipDuplicates: true,
            });
        }
        return c.json({ accepted: rows.length });
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
        const [rows, memberships] = await Promise.all([
            prisma.extensionUseDay.findMany({
                where: { day: { gte: `${months[0]}-01` } },
                select: { extensionId: true, userId: true, day: true },
            }),
            prisma.membership.findMany({ select: { userId: true, status: true } }),
        ]);
        const memberIds = new Set(memberships.filter((membership) => isPremium(membership)).map((membership) => membership.userId));
        return c.json({
            priceUsd: config.pool.priceUsd,
            creatorShare: config.pool.creatorShare,
            months: months
                .map((month) =>
                    computeMonth(
                        month,
                        rows.filter((row) => row.day.startsWith(`${month}-`)),
                        memberIds,
                        memberIds.size,
                        config,
                    ),
                )
                .toReversed(),
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
        }
        return c.json({ received: true });
    });

    return app;
};
