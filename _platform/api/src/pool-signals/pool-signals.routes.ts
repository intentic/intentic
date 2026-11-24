import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { PoolSignal } from "@intentic/api-contract/ingress";
import { Hono } from "hono";
import type { Logger } from "pino";
import { ingressServer } from "../ingress.js";

/* RUN-OUTS SHARED ACROSS SANDBOXES (docs/architecture/account-routing.md). A daemon whose turn was refused for a spent
 * allowance says so here, naming the provider account only by a fingerprint it made from the provider's own account ids
 * (an HMAC under its owner's key, `poolSignalKey` below; never the id, never a credential); the owner's other sandboxes
 * signed in to the same account ask for the fingerprints they hold and file what they hear in their refusal ledger. No
 * usage reading travels.
 *
 * Every signal is its reporting sandbox's owner's, and a read answers only that owner's rows (2026-11-24). Keyed by the
 * fingerprint alone, with one unsalted sha256 for every owner, the table tied together the Intentic accounts whose
 * sandboxes held one provider seat, and a hash over a Google email could be confirmed by guessing the address. The
 * per-owner key makes one seat held by two owners two unrelated values, and the owner bound makes sure neither owner's
 * sandboxes are ever answered the other's. A run-out a member's own seat met in the owner's sandbox and in the member's
 * is no longer heard across the two: each side learns it at its own next refusal, as it did before signals existed. A
 * daemon from before the key still reports a bare sha256, which the platform cannot tell apart: it is kept and read
 * inside its owner's rows like any other, so no owner is answered another's, and holds the unkeyed value only until
 * that daemon updates. */

type PoolSignalsEnv = { Variables: { logger: Logger } };

export interface PoolSignalsDeps {
    readonly prisma: PrismaClient;
    readonly now?: () => Date;
}

// A week, the longest pool any provider sells, and a day of slack: past it the window has certainly turned over.
export const POOL_SIGNAL_KEEP_MS = 8 * 24 * 60 * 60_000;
// A reporter's clock a little ahead is believed; one far ahead would hold a signal past every window.
const CLOCK_SKEW_MS = 5 * 60_000;

interface SignalRow {
    readonly fingerprint: string;
    readonly pool: string;
    readonly ranOutAt: Date;
    readonly resetsAt: Date | null;
}

// A row as the wire carries it: epoch ms for the run-out, epoch seconds for the reset, as the refusal ledger keeps them.
const signalOf = (row: SignalRow): PoolSignal => {
    const signal: PoolSignal = { fingerprint: row.fingerprint, pool: row.pool, ranOutAt: row.ranOutAt.getTime() };
    if (row.resetsAt !== null) {
        signal.resetsAt = Math.floor(row.resetsAt.getTime() / 1000);
    }
    return signal;
};

export const poolSignalsHttpRoutes = ({ prisma, now = () => new Date() }: PoolSignalsDeps) => {
    const app = new Hono<PoolSignalsEnv>();
    const ingress = ingressServer(app, `/pool-signals`);

    // The calling sandbox and the owner its signals belong to; null for an unknown token, answered 404, not 401, as the
    // wallet's and the projects' doors answer. Every sandbox row names its owner, so a caller found is one whose owner is.
    const callerOf = async (token: string | undefined) =>
        token === undefined
            ? null
            : await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { id: true, ownerId: true } });

    // The owner's key, minted by whichever of its sandboxes asks first. Two asking at once both mint: the insert that
    // loses is dropped, and both read the one that won.
    const keyOf = async (ownerId: string): Promise<string> => {
        const held = await prisma.providerPoolKey.findUnique({ where: { ownerId }, select: { key: true } });
        if (held !== null) {
            return held.key;
        }
        await prisma.providerPoolKey.createMany({ data: [{ ownerId, key: randomBytes(32).toString(`hex`) }], skipDuplicates: true });
        return (await prisma.providerPoolKey.findUniqueOrThrow({ where: { ownerId }, select: { key: true } })).key;
    };

    ingress(`poolSignalKey`, async (_c, kit) => {
        const caller = await callerOf(kit.connectToken);
        return caller === null ? kit.refuse(404, `unknown sandbox`) : kit.answer({ key: await keyOf(caller.ownerId) });
    });

    ingress(`poolSignal`, async (_c, kit) => {
        const caller = await callerOf(kit.connectToken);
        if (caller === null) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const body = await kit.body();
        const at = now();
        if (body === undefined || body.ranOutAt > at.getTime() + CLOCK_SKEW_MS) {
            return kit.refuse(400, `name a fingerprint, a pool, and when it ran out (epoch ms, not in the future)`);
        }
        const key = { ownerId: caller.ownerId, fingerprint: body.fingerprint, pool: body.pool };
        const held = await prisma.providerPoolSignal.findUnique({ where: { ownerId_fingerprint_pool: key }, select: { ranOutAt: true } });
        // The latest run-out per owner, account and pool: a slower sandbox's report of an older one keeps the newer on file.
        if (held === null || held.ranOutAt.getTime() <= body.ranOutAt) {
            const fields = {
                ranOutAt: new Date(body.ranOutAt),
                resetsAt: body.resetsAt === undefined ? null : new Date(body.resetsAt * 1000),
                sandboxId: caller.id,
            };
            await prisma.providerPoolSignal.upsert({ where: { ownerId_fingerprint_pool: key }, create: { ...key, ...fields }, update: fields });
        }
        // Pruned as written: one indexed delete, and a table nobody writes holds nothing anybody reads.
        await prisma.providerPoolSignal.deleteMany({ where: { updatedAt: { lt: new Date(at.getTime() - POOL_SIGNAL_KEEP_MS) } } });
        return kit.answer({ ok: true });
    });

    ingress(`poolSignals`, async (_c, kit) => {
        const caller = await callerOf(kit.connectToken);
        if (caller === null) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `name at most 32 fingerprints, each 64 hex characters`);
        }
        if (body.fingerprints.length === 0) {
            return kit.answer({ signals: [] });
        }
        const at = now();
        const rows = await prisma.providerPoolSignal.findMany({
            where: {
                // The caller's owner's own, and never another owner's, whatever fingerprints it names.
                ownerId: caller.ownerId,
                fingerprint: { in: body.fingerprints },
                // The caller heard its own refusal first-hand.
                sandboxId: { not: caller.id },
                updatedAt: { gte: new Date(at.getTime() - POOL_SIGNAL_KEEP_MS) },
                // Live only: one past the provider's own reset is over.
                OR: [{ resetsAt: null }, { resetsAt: { gt: at } }],
            },
            select: { fingerprint: true, pool: true, ranOutAt: true, resetsAt: true },
        });
        return kit.answer({ signals: rows.map(signalOf) });
    });

    return app;
};
