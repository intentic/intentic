import type { Prisma, PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { ingressServer } from "../../../ingress.js";
import { JOB_HOSTED_WAKE, runExclusive } from "../../../jobs-lock.js";
import { hostedEnabled } from "../hosted.js";
import { type HostedWakeContext, wakeHostedSandbox } from "./hosted-wake.js";

// How far ahead of its deadline a machine is started: the daemon holds a promise due sooner than its lead and five
// minutes rather than sleep (sandbox system/sleep/idle-stop.ts, NOT_WORTH_SLEEPING_MS).
export const HOSTED_WAKE_LEAD_MS = 2 * 60_000;
// The first retry after a start that failed; later ones back off with how overdue the deadline is, up to the ceiling.
export const HOSTED_WAKE_RETRY_MS = 60_000;
const HOSTED_WAKE_RETRY_CEILING_MS = 30 * 60_000;
// How long a started machine has to boot and retract its alarm before the sweep starts it again.
export const HOSTED_WAKE_BOOT_MS = 10 * 60_000;
// Overdue this long, a promise is left to the scheduler's catch-up at the next start rather than retried any more.
export const HOSTED_WAKE_GIVE_UP_MS = 24 * 3_600_000;
// Refusals no retry answers: a suspended owner, spent hours (they come back on the 1st), a machine that is gone.
const FINAL_REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "PAYMENT_REQUIRED", "NOT_FOUND"]);

const retryDelay = (deadline: Date, now: Date): number =>
    Math.min(HOSTED_WAKE_RETRY_CEILING_MS, Math.max(HOSTED_WAKE_RETRY_MS, now.getTime() - deadline.getTime()));

export const hostedWakeAlarmRoutes = ({ prisma, config }: { readonly prisma: PrismaClient; readonly config: Config }) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    ingressServer(app)("wakeAlarm", async (_c, kit) => {
        if (kit.connectToken === undefined) {
            return kit.refuse(400, "missing token");
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, "expected an alarm instant or null");
        }
        if (body.at !== null && !hostedEnabled(config)) {
            return kit.refuse(503, "hosted wakes are unavailable");
        }
        const data: Prisma.SandboxUpdateManyMutationInput = { scheduledWakeAt: body.at === null ? null : new Date(body.at), scheduledWakeRetryAt: null };
        // A person's last moment there, never later than now whatever the daemon's clock says.
        if (body.personAt !== undefined && body.personAt > 0) {
            data.personSeenAt = new Date(Math.min(body.personAt, Date.now()));
        }
        const stored = await prisma.sandbox.updateMany({
            where: { tokenDigest: sha256Hex(kit.connectToken), removedAt: null, hosted: { isNot: null } },
            data,
        });
        return stored.count === 0 ? kit.refuse(404, "unknown hosted sandbox") : kit.answer({ ok: true });
    });
    return app;
};

// The database is the clock's durable owner: a platform restart loses no alarm. Claim each attempt before its wake,
// leave the alarm until the ready daemon retracts it, and retry a failed start with backoff without replaying turns.
// Alarms never tried go first, so a row that keeps failing cannot hold the rest behind it.
export const runHostedWakeAlarms = async (
    context: HostedWakeContext,
    now = new Date(),
    wake: typeof wakeHostedSandbox = wakeHostedSandbox,
): Promise<void> => {
    const retryable = { OR: [{ scheduledWakeRetryAt: null }, { scheduledWakeRetryAt: { lte: now } }] };
    const sandboxes = await context.prisma.sandbox.findMany({
        where: { removedAt: null, hosted: { isNot: null }, scheduledWakeAt: { lte: new Date(now.getTime() + HOSTED_WAKE_LEAD_MS) }, ...retryable },
        include: { hosted: true, owner: { select: { email: true } } },
        orderBy: [{ scheduledWakeRetryAt: { sort: "asc", nulls: "first" } }, { scheduledWakeAt: "asc" }],
        take: 64,
    });
    for (const sandbox of sandboxes) {
        const deadline = sandbox.scheduledWakeAt;
        if (sandbox.hosted === null || deadline === null) {
            continue;
        }
        // Only while the alarm is the one this pass read: a retraction or a new deadline since wins.
        const unchanged = { id: sandbox.id, removedAt: null, hosted: { isNot: null }, scheduledWakeAt: deadline };
        const drop = async (why: string, error?: Error): Promise<void> => {
            await context.prisma.sandbox.updateMany({ where: unchanged, data: { scheduledWakeAt: null, scheduledWakeRetryAt: null } });
            context.logger.info({ err: error, sandboxId: sandbox.id, at: deadline }, `hosted alarm: ${why}; left to the next start's catch-up`);
        };
        try {
            if (now.getTime() - deadline.getTime() > HOSTED_WAKE_GIVE_UP_MS) {
                await drop("a day overdue");
                continue;
            }
            const claimed = await context.prisma.sandbox.updateMany({
                where: { ...unchanged, ...retryable },
                data: { scheduledWakeRetryAt: new Date(now.getTime() + retryDelay(deadline, now)) },
            });
            if (claimed.count === 0) {
                continue;
            }
            await wake(context, { ...sandbox, hosted: sandbox.hosted }, "alarm");
            // Started: its daemon retracts the alarm once its schedulers run, and a boot takes longer than a retry.
            await context.prisma.sandbox.updateMany({ where: unchanged, data: { scheduledWakeRetryAt: new Date(now.getTime() + HOSTED_WAKE_BOOT_MS) } });
        } catch (error) {
            if (error instanceof ORPCError && FINAL_REFUSALS.has(error.code)) {
                await drop("the wake was refused", error).catch((dropError: Error) =>
                    context.logger.warn({ err: dropError, sandboxId: sandbox.id }, "hosted alarm: a refused alarm could not be dropped"),
                );
                continue;
            }
            context.logger.warn({ err: error, sandboxId: sandbox.id }, "hosted alarm: wake did not complete; retained for retry");
        }
    }
};

export const startHostedWakeAlarms = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config)) {
        return;
    }
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_WAKE, () => runHostedWakeAlarms({ prisma, config, logger })).catch((error: Error) =>
            logger.error({ err: error }, "hosted alarm sweep failed"),
        );
    };
    tick();
    setInterval(tick, 15_000).unref();
};
