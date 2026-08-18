import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { JOB_POOL_CYCLE, runExclusive } from "../jobs-lock.js";
import { closeDueMonths } from "./pool-close.js";
import { poolEnabled } from "./pool-membership.js";
import { runPayoutsLogged } from "./pool-payout.js";
import { stripeGateway } from "./pool-stripe.js";
import { runWatch } from "./pool-watch.js";

/* THE MONEY CYCLE, ON A SCHEDULE: close every finished month, then pay everything that has come due.
 *
 * Daily rather than monthly, and catching up rather than acting only on the current period: the job's
 * correctness must not depend on the platform being awake at midnight on the first, and a month that went
 * unclosed through a deploy has to close by itself afterwards. Every tick asks the same two questions, so the
 * answer is right whether it was last asked yesterday or in March.
 *
 * Close and pay share ONE lock, in that order, on purpose. They are two halves of the same cycle — paying reads
 * what closing wrote — and a payout run overlapping a close on another replica would be reasoning about a month
 * still being written. Exclusivity matters more sharply here than for the other jobs: two closes would write two
 * sets of statements, and two payout runs would race for the same ones.
 *
 * The halves are guarded separately so a Stripe outage during payouts never masks a successful close. */

const DAY_MS = 24 * 60 * 60 * 1000;

export const startPoolCycle = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    // A platform that sells nothing has no months to close and nobody to pay.
    if (!poolEnabled(config)) {
        return;
    }
    const gateway = stripeGateway(config.pool.stripeSecretKey);
    const deps = { prisma, config, gateway };
    const run = async (): Promise<void> => {
        try {
            await closeDueMonths(deps, logger);
        } catch (error) {
            // The next tick retries; the month stays open until one succeeds.
            logger.error({ err: error }, `pool: month close failed`);
        }
        try {
            await runPayoutsLogged(deps, logger);
        } catch (error) {
            // Individual payment failures are handled inside the run — they stay pending and retry under their
            // own key. This catches only a failure of the run itself.
            logger.error({ err: error }, `pool: payout run failed`);
        }
        try {
            /* Gate 4 of open admission (pool-watch.ts): graduate, trip, canary. Guarded separately and run
             * last because it is the only half that reaches OUT — a provider's endpoint hanging must not be
             * able to stop a month closing or a creator being paid. It shares the cycle's lock because two
             * replicas probing the same listings would double every provider's canary bill. */
            await runWatch({ prisma, config }, logger);
        } catch (error) {
            logger.error({ err: error }, `pool: service watch failed`);
        }
    };
    const tick = (): void => {
        void runExclusive(config, JOB_POOL_CYCLE, run).catch((error: unknown) => logger.error({ err: error }, `pool: cycle lock failed`));
    };
    tick();
    setInterval(tick, DAY_MS);
};
