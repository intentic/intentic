import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { JOB_POOL_CLOSE, runExclusive } from "../jobs-lock.js";
import { closeDueMonths } from "./pool-close.js";
import { poolEnabled } from "./pool-membership.js";
import { stripeGateway } from "./pool-stripe.js";

/* THE CLOSE, ON A SCHEDULE. Daily rather than monthly, and catching up rather than closing only last month:
 * the job's own correctness must not depend on the platform being awake at midnight on the first, and a month
 * that went unclosed because a deploy was mid-flight has to close by itself afterwards. Every tick asks the
 * same question — is any finished month still open — so the answer is right whether it was last asked
 * yesterday or in March.
 *
 * Exclusive across replicas (retention's advisory-lock pattern) because two closes of one month would write two
 * sets of statements, and the whole point of a frozen month is that it happened once. */

const DAY_MS = 24 * 60 * 60 * 1000;

export const startPoolClose = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    // A platform that sells nothing has no months to close, exactly as it has no pool routes.
    if (!poolEnabled(config)) {
        return;
    }
    const gateway = stripeGateway(config.pool.stripeSecretKey);
    const run = async (): Promise<void> => {
        try {
            await closeDueMonths({ prisma, config, gateway }, logger);
        } catch (error) {
            // A failed close must not crash the API, and must not be silent — the next tick retries, and the
            // month stays open until one succeeds.
            logger.error({ err: error }, `pool: month close failed`);
        }
    };
    const tick = (): void => {
        void runExclusive(config, JOB_POOL_CLOSE, run).catch((error: unknown) => logger.error({ err: error }, `pool: close lock failed`));
    };
    tick();
    setInterval(tick, DAY_MS);
};
