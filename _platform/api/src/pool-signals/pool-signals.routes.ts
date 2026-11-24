import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { PoolSignal } from "@intentic/api-contract/ingress";
import { Hono } from "hono";
import type { Logger } from "pino";
import { ingressServer } from "../ingress.js";

/* RUN-OUTS SHARED ACROSS SANDBOXES (docs/architecture/account-routing.md). A daemon whose turn was refused for a spent
 * allowance says so here, naming the provider account only by a fingerprint it made from the provider's own account id
 * (a sha256, never the id, never a credential); the owner's other sandboxes signed in to the same account ask for the
 * fingerprints they hold and file what they hear in their refusal ledger. No usage reading travels.
 *
 * Reads are bounded by the fingerprint, not by the owner (2026-11-24): the hash is made from ids only a holder of the
 * account's token reads (Claude's account and organisation uuids, Codex's account and user ids), so asking for one is
 * already holding the account, and a run-out is what that holder would meet on its next turn anyway. Bounding by owner
 * as well would keep one row per account per owner, and drop the run-out an account shared by two owners' sandboxes
 * (a seat a member brought into the owner's sandbox) is most useful for. */

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

    // 404, not 401, for an unknown token, as the wallet's and the projects' doors answer.
    const callerOf = async (token: string | undefined) =>
        token === undefined ? null : await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { id: true } });

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
        const key = { fingerprint: body.fingerprint, pool: body.pool };
        const held = await prisma.providerPoolSignal.findUnique({ where: { fingerprint_pool: key }, select: { ranOutAt: true } });
        // The latest run-out per account and pool: a slower sandbox's report of an older one keeps the newer on file.
        if (held === null || held.ranOutAt.getTime() <= body.ranOutAt) {
            const fields = {
                ranOutAt: new Date(body.ranOutAt),
                resetsAt: body.resetsAt === undefined ? null : new Date(body.resetsAt * 1000),
                sandboxId: caller.id,
            };
            await prisma.providerPoolSignal.upsert({ where: { fingerprint_pool: key }, create: { ...key, ...fields }, update: fields });
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
            return kit.refuse(400, `name at most 32 fingerprints, each a sha256 in hex`);
        }
        if (body.fingerprints.length === 0) {
            return kit.answer({ signals: [] });
        }
        const at = now();
        const rows = await prisma.providerPoolSignal.findMany({
            where: {
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
