import type { PrismaClient } from "@intentic-app/prisma";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { runPayouts } from "./pool-payout.js";
import type { StripeGateway } from "./pool-stripe.js";

/* PAYING TWICE IS THE ONLY UNRECOVERABLE FAILURE IN THIS SYSTEM, so most of what is pinned here is the
 * machinery that prevents it: the reservation happening before any money moves, a lost answer being retried
 * under the SAME key rather than replaced by a second payment, and a failure never handing its statements back
 * for some later run to pay again. The rest is what a creator would call a broken promise — being paid before
 * the stated date, being paid for money that expired, or a name nobody claimed being paid to somebody. */

const NOW = new Date(`2026-08-15T09:00:00Z`);

const config = { pool: { minPayoutCents: 2500, payoutCurrency: `usd` } } as Config;

interface Seed {
    due?: { id: string; publisher: string; amountCents: number }[];
    claims?: { publisher: string; userId: string }[];
    accounts?: Record<string, { stripeAccountId: string; payoutsEnabled: boolean }>;
    pending?: { id: string; userId: string; amountCents: number; currency: string }[];
    // Statements another run already claimed between our read and our reserve.
    claimedElsewhere?: Set<string>;
}

const fakePrisma = (seed: Seed = {}) => {
    const written: {
        created: { userId: string; amountCents: number; currency: string }[];
        claimed: { ids: string[]; payoutId: string }[];
        updates: { id: string; data: Record<string, unknown> }[];
    } = { created: [], claimed: [], updates: [] };
    let nextId = 1;
    const creatorStatement = {
        findMany: vi.fn(async () => seed.due ?? []),
        updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { payoutId: string } }) => {
            const claimable = where.id.in.filter((id) => !(seed.claimedElsewhere ?? new Set()).has(id));
            written.claimed.push({ ids: claimable, payoutId: data.payoutId });
            return { count: claimable.length };
        }),
    };
    const creatorPayout = {
        findMany: vi.fn(async () => seed.pending ?? []),
        create: vi.fn(async ({ data }: { data: { userId: string; amountCents: number; currency: string } }) => {
            written.created.push(data);
            return { id: `payout_${nextId++}`, ...data };
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            written.updates.push({ id: where.id, data });
            return {};
        }),
    };
    const prisma = {
        creatorStatement,
        creatorPayout,
        publisherClaim: { findMany: vi.fn(async () => seed.claims ?? []) },
        payoutAccount: {
            findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => seed.accounts?.[where.userId] ?? null),
        },
        // The reserve runs inside a transaction; the fake simply lends it the same client.
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ creatorStatement, creatorPayout })),
    };
    return { prisma: prisma as unknown as PrismaClient, written };
};

const gatewayWith = (transfer: StripeGateway[`transfer`]): StripeGateway => ({ transfer }) as unknown as StripeGateway;

const payable = (userId: string) => ({ [userId]: { stripeAccountId: `acct_${userId}`, payoutsEnabled: true } });

describe(`the payout run`, () => {
    it(`reserves before it sends, and keys the transfer to the reservation`, async () => {
        const calls: { idempotencyKey: string; amountCents: number; destination: string }[] = [];
        const { prisma, written } = fakePrisma({
            due: [
                { id: `st1`, publisher: `acme`, amountCents: 8000 },
                { id: `st2`, publisher: `acme-labs`, amountCents: 4840 },
            ],
            claims: [
                { publisher: `acme`, userId: `u1` },
                { publisher: `acme-labs`, userId: `u1` },
            ],
            accounts: payable(`u1`),
        });
        const gateway = gatewayWith(async (opts) => {
            calls.push(opts);
            return { id: `tr_1` };
        });

        const outcomes = await runPayouts({ prisma, config, gateway, now: () => NOW });

        // Two names, four figures owed, ONE payment — a creator is owed a number, not a bank line per listing.
        expect(written.created).toEqual([{ userId: `u1`, amountCents: 12_840, currency: `usd` }]);
        expect(written.claimed).toEqual([{ ids: [`st1`, `st2`], payoutId: `payout_1` }]);
        expect(calls).toEqual([{ amountCents: 12_840, currency: `usd`, destination: `acct_u1`, idempotencyKey: `payout_1` }]);
        expect(outcomes).toEqual([{ userId: `u1`, amountCents: 12_840, paid: true }]);
        expect(written.updates.at(-1)?.data).toMatchObject({ status: `paid`, stripeTransferId: `tr_1` });
    });

    it(`keeps a failed payment pending, holding its statements, instead of releasing them`, async () => {
        const { prisma, written } = fakePrisma({
            due: [{ id: `st1`, publisher: `acme`, amountCents: 9000 }],
            claims: [{ publisher: `acme`, userId: `u1` }],
            accounts: payable(`u1`),
        });
        const gateway = gatewayWith(async () => Promise.reject(new Error(`insufficient funds`)));

        const outcomes = await runPayouts({ prisma, config, gateway, now: () => NOW });

        expect(outcomes[0]).toMatchObject({ paid: false, error: `insufficient funds` });
        // Still claimed by the failed payout: releasing would let a later run build a NEW payout with a NEW
        // key, which is exactly how a silently-successful transfer gets sent a second time.
        expect(written.claimed).toEqual([{ ids: [`st1`], payoutId: `payout_1` }]);
        expect(written.updates.at(-1)?.data).toMatchObject({ attempts: { increment: 1 }, lastError: `insufficient funds` });
        expect(written.updates.at(-1)?.data).not.toHaveProperty(`status`);
    });

    it(`finishes an interrupted payment under its original key, before building anything new`, async () => {
        const calls: string[] = [];
        const { prisma, written } = fakePrisma({
            pending: [{ id: `payout_earlier`, userId: `u1`, amountCents: 5000, currency: `usd` }],
            accounts: payable(`u1`),
        });
        const gateway = gatewayWith(async ({ idempotencyKey }) => {
            calls.push(idempotencyKey);
            return { id: `tr_replayed` };
        });

        const outcomes = await runPayouts({ prisma, config, gateway, now: () => NOW });

        // The SAME key the interrupted attempt used: if that attempt did reach Stripe, this replays it rather
        // than moving money again.
        expect(calls).toEqual([`payout_earlier`]);
        expect(outcomes).toEqual([{ userId: `u1`, amountCents: 5000, paid: true, resumed: true }]);
        // Nothing new reserved — a resume is a continuation, not a second payment.
        expect(written.created).toEqual([]);
    });

    it(`aborts a reservation whose statements another run already took`, async () => {
        const transfer = vi.fn();
        const { prisma } = fakePrisma({
            due: [{ id: `st1`, publisher: `acme`, amountCents: 9000 }],
            claims: [{ publisher: `acme`, userId: `u1` }],
            accounts: payable(`u1`),
            claimedElsewhere: new Set([`st1`]),
        });

        const outcomes = await runPayouts({ prisma, config, gateway: gatewayWith(transfer), now: () => NOW });

        expect(outcomes[0]).toMatchObject({ paid: false, error: `statements already claimed by another run` });
        // The loser of the race sends nothing at all.
        expect(transfer).not.toHaveBeenCalled();
    });

    it(`carries a balance under the minimum instead of paying it`, async () => {
        const transfer = vi.fn();
        const { prisma, written } = fakePrisma({
            due: [{ id: `st1`, publisher: `acme`, amountCents: 2499 }],
            claims: [{ publisher: `acme`, userId: `u1` }],
            accounts: payable(`u1`),
        });

        const outcomes = await runPayouts({ prisma, config, gateway: gatewayWith(transfer), now: () => NOW });

        // Nothing written at all: a carried balance is the absence of an event, and the statement stays owed.
        expect(outcomes).toEqual([]);
        expect(written.created).toEqual([]);
        expect(transfer).not.toHaveBeenCalled();
    });

    it(`pays nobody who has not connected a payable account, and nothing owed to an unclaimed name`, async () => {
        const transfer = vi.fn();
        const { prisma, written } = fakePrisma({
            due: [
                // Connected, but Stripe is not accepting transfers for it yet.
                { id: `st1`, publisher: `notready`, amountCents: 9000 },
                // Nobody has proved this name — its money waits out its twelve months instead.
                { id: `st2`, publisher: `unclaimed`, amountCents: 9000 },
            ],
            claims: [{ publisher: `notready`, userId: `u1` }],
            accounts: { u1: { stripeAccountId: `acct_u1`, payoutsEnabled: false } },
        });

        const outcomes = await runPayouts({ prisma, config, gateway: gatewayWith(transfer), now: () => NOW });

        expect(outcomes).toEqual([]);
        expect(written.created).toEqual([]);
        expect(transfer).not.toHaveBeenCalled();
    });

    it(`only ever considers statements that are due, unpaid and unexpired`, async () => {
        const { prisma } = fakePrisma({ due: [] });

        await runPayouts({ prisma, config, gateway: gatewayWith(vi.fn()), now: () => NOW });

        // The stated payable date is a hold window for refunds and disputes; paying before it would spend money
        // that can still be taken back.
        expect(prisma.creatorStatement.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { payoutId: null, expiredAt: null, poolMonth: { payableAt: { lte: NOW } } } }),
        );
    });
});
