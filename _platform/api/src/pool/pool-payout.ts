import type { PrismaClient } from "@intentic-app/prisma";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { StripeGateway } from "./pool-stripe.js";

/* THE PAYOUT RUN, where the promise finally becomes money in someone's account.
 *
 * Everything here is arranged around one hazard: paying twice. A transfer that succeeds at Stripe but whose
 * answer never reaches the platform is indistinguishable, from here, from one that never happened. Retrying
 * blindly double-pays; not retrying strands the money. So the run is built in three ordered steps, and the
 * order IS the correctness:
 *
 *   1. RESERVE. In one transaction, create the payout row and claim the statements it covers. No money has
 *      moved, and the statements are now unavailable to any other run.
 *   2. TRANSFER, keyed by that row's id. Stripe replays a repeated key rather than acting on it, so sending the
 *      same reservation twice moves money once.
 *   3. RECORD. Mark the row paid with the transfer id.
 *
 * A crash between any two steps leaves a `pending` row, and the next run FINISHES that row rather than building
 * a new one, same key, same outcome. This is also why a failed transfer never releases its statements: a fresh
 * payout would carry a fresh key, which is exactly how a silently-successful payment gets made again.
 *
 * The run pays only what is due (a month's stated payable date has arrived), only to creators who connected an
 * account Stripe says is payable, and only when the total clears the published minimum. */

export interface PayoutOutcome {
    readonly userId: string;
    readonly amountCents: number;
    readonly paid: boolean;
    readonly resumed?: boolean;
    readonly error?: string;
}

export interface PayoutDeps {
    readonly prisma: PrismaClient;
    readonly config: Config;
    readonly gateway: StripeGateway;
    readonly now?: () => Date;
}

const messageOf = (error: unknown): string => errorMessage(error);

/* Steps 2 and 3 for one reserved payout. Shared by the resume path and the fresh path precisely so they cannot
 * drift: a resumed payment must be sent exactly the way the original attempt would have been, or the
 * idempotency key stops matching what it is meant to protect. */
const settle = async (
    { prisma, gateway }: PayoutDeps,
    payout: { id: string; userId: string; amountCents: number; currency: string },
    destination: string,
    at: Date,
): Promise<PayoutOutcome> => {
    try {
        const transfer = await gateway.transfer({
            amountCents: payout.amountCents,
            currency: payout.currency,
            destination,
            idempotencyKey: payout.id,
        });
        await prisma.creatorPayout.update({
            where: { id: payout.id },
            data: { status: `paid`, stripeTransferId: transfer.id, paidAt: at, lastError: null },
        });
        return { userId: payout.userId, amountCents: payout.amountCents, paid: true };
    } catch (error) {
        // Left pending on purpose, holding its statements. The next run retries this same row under the same
        // key; money stuck in the open is fixable, money sent twice is not.
        await prisma.creatorPayout.update({
            where: { id: payout.id },
            data: { attempts: { increment: 1 }, lastError: messageOf(error).slice(0, 500) },
        });
        return { userId: payout.userId, amountCents: payout.amountCents, paid: false, error: messageOf(error) };
    }
};

/* Where a creator's money can be sent, or undefined if it cannot be sent at all. `payoutsEnabled` is the only
 * field read as permission, an account that exists, or has submitted its details, is not the same as one
 * Stripe will accept a transfer for. */
const destinationOf = async (prisma: PrismaClient, userId: string): Promise<string | undefined> => {
    const account = await prisma.payoutAccount.findUnique({ where: { userId }, select: { stripeAccountId: true, payoutsEnabled: true } });
    return account !== null && account.payoutsEnabled ? account.stripeAccountId : undefined;
};

/* Finish every payment a previous run started and did not confirm. Always first: these already hold statements,
 * and building new payouts while an unconfirmed one exists would be reasoning about a balance that is partly
 * spoken for. */
const resumePending = async (deps: PayoutDeps, at: Date): Promise<PayoutOutcome[]> => {
    const pending = await deps.prisma.creatorPayout.findMany({
        where: { status: `pending` },
        select: { id: true, userId: true, amountCents: true, currency: true },
        orderBy: { createdAt: `asc` },
    });
    const outcomes: PayoutOutcome[] = [];
    for (const payout of pending) {
        const destination = await destinationOf(deps.prisma, payout.userId);
        if (destination === undefined) {
            // The account was payable when this was reserved and is not now (a creator can be restricted after
            // the fact). It stays pending, still holding its statements, until Stripe will take it again.
            outcomes.push({ userId: payout.userId, amountCents: payout.amountCents, paid: false, resumed: true, error: `payouts not enabled` });
            continue;
        }
        outcomes.push({ ...(await settle(deps, payout, destination, at)), resumed: true });
    }
    return outcomes;
};

/* One payout, retried NOW — the admin panel's "try again" on a stuck row, sharing `settle` with the
 * scheduled run so a hand-triggered attempt is byte-identical to tomorrow morning's (same idempotency key,
 * same destination lookup). Answers in sentences because the operator reads this verbatim. */
export const retryPayout = async (deps: PayoutDeps, payoutId: string): Promise<{ paid: boolean; message: string }> => {
    const payout = await deps.prisma.creatorPayout.findUnique({
        where: { id: payoutId },
        select: { id: true, userId: true, amountCents: true, currency: true, status: true },
    });
    if (payout === null) {
        return { paid: false, message: `No payout with that id.` };
    }
    if (payout.status !== `pending`) {
        return { paid: false, message: `This payout is ${payout.status}; only a pending one can be retried.` };
    }
    const destination = await destinationOf(deps.prisma, payout.userId);
    if (destination === undefined) {
        return {
            paid: false,
            message: `The creator's payout account is not accepting transfers; the payout stays pending until Stripe will take it.`,
        };
    }
    const outcome = await settle(deps, payout, destination, (deps.now ?? (() => new Date()))());
    return outcome.paid
        ? { paid: true, message: `Paid: $${(payout.amountCents / 100).toFixed(2)} transferred.` }
        : { paid: false, message: `Transfer failed again: ${outcome.error ?? `unknown error`}. The payout stays pending under the same key.` };
};

/* One creator's fresh payment. The reservation is guarded by `payoutId: null` in the WHERE rather than trusting
 * the read that preceded it: two runs racing, different replicas, or a tick overlapping a slow predecessor,
 * would otherwise both believe they own the same statements. Whoever updates fewer rows than it expected has
 * lost the race and rolls back, which the transaction makes free. */
const payCreator = async (
    deps: PayoutDeps,
    userId: string,
    statementIds: readonly string[],
    amountCents: number,
    at: Date,
): Promise<PayoutOutcome | undefined> => {
    const { prisma, config } = deps;
    const destination = await destinationOf(prisma, userId);
    if (destination === undefined) {
        return undefined;
    }
    let reserved: { id: string; userId: string; amountCents: number; currency: string };
    try {
        reserved = await prisma.$transaction(async (tx) => {
            const payout = await tx.creatorPayout.create({
                data: { userId, amountCents, currency: config.pool.payoutCurrency },
                select: { id: true, userId: true, amountCents: true, currency: true },
            });
            const claimed = await tx.creatorStatement.updateMany({
                where: { id: { in: [...statementIds] }, payoutId: null },
                data: { payoutId: payout.id },
            });
            if (claimed.count !== statementIds.length) {
                throw new Error(`statements already claimed by another run`);
            }
            return payout;
        });
    } catch (error) {
        return { userId, amountCents, paid: false, error: messageOf(error) };
    }
    return settle(deps, reserved, destination, at);
};

/* The run. Pays every creator whose due, unpaid, unexpired statements clear the minimum, and does it as one
 * payment per creator rather than one per statement or per publisher, because a creator holding three names
 * across four months is owed a number, not twelve bank lines. */
export const runPayouts = async (deps: PayoutDeps): Promise<readonly PayoutOutcome[]> => {
    const { prisma, config } = deps;
    const at = (deps.now ?? (() => new Date()))();
    const outcomes: PayoutOutcome[] = [...(await resumePending(deps, at))];

    /* Due, unpaid and unexpired. `payableAt <= now` is the stated date doing its job: a month closes as soon as
     * it is over but is not payable until the published day, which is the hold window refunds and disputes
     * land in. */
    const due = await prisma.creatorStatement.findMany({
        where: { payoutId: null, expiredAt: null, poolMonth: { payableAt: { lte: at } } },
        select: { id: true, publisher: true, amountCents: true },
    });
    if (due.length === 0) {
        return outcomes;
    }
    // Publisher → owner. A name nobody has claimed is simply not in this map, and its money waits (its twelve
    // months are what eventually resolve it, in the close).
    const claims = await prisma.publisherClaim.findMany({
        where: { publisher: { in: [...new Set(due.map((statement) => statement.publisher))] } },
        select: { publisher: true, userId: true },
    });
    const ownerOf = new Map(claims.map((claim) => [claim.publisher, claim.userId]));

    const byUser = new Map<string, { ids: string[]; amountCents: number }>();
    for (const statement of due) {
        const userId = ownerOf.get(statement.publisher);
        if (userId === undefined) {
            continue;
        }
        const previous = byUser.get(userId) ?? { ids: [], amountCents: 0 };
        previous.ids.push(statement.id);
        previous.amountCents += statement.amountCents;
        byUser.set(userId, previous);
    }

    // Sequential rather than parallel: these are money movements against one platform balance, and a fleet of
    // concurrent transfers buys nothing at this cadence while making a partial failure much harder to read.
    for (const [userId, group] of [...byUser.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
        if (group.amountCents < config.pool.minPayoutCents) {
            // Under the minimum: nothing is written at all, so the statements stay owed and simply roll into
            // the next run. A carried balance is not an event, it is the absence of one.
            continue;
        }
        const outcome = await payCreator(deps, userId, group.ids, group.amountCents, at);
        if (outcome !== undefined) {
            outcomes.push(outcome);
        }
    }
    return outcomes;
};

// The scheduled entry point: run, then say what happened. Never throws, a payout run that takes the API down
// with it would be a worse failure than the one it hit.
export const runPayoutsLogged = async (deps: PayoutDeps, logger: Logger): Promise<void> => {
    const outcomes = await runPayouts(deps);
    for (const outcome of outcomes) {
        if (outcome.paid) {
            logger.info(outcome, `pool: creator paid`);
        } else {
            logger.warn(outcome, `pool: payout pending, will retry under the same key`);
        }
    }
};
