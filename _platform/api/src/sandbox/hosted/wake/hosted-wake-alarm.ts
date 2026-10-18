import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { ingressServer } from "../../../ingress.js";
import { JOB_HOSTED_WAKE, runExclusive } from "../../../jobs-lock.js";
import { hostedEnabled } from "../hosted.js";
import { type HostedWakeContext, wakeHostedSandbox } from "./hosted-wake.js";

export const HOSTED_WAKE_LEAD_MS = 2 * 60_000;
export const HOSTED_WAKE_RETRY_MS = 60_000;

export const hostedWakeAlarmRoutes = ({ prisma, config }: { readonly prisma: PrismaClient; readonly config: Config }) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    ingressServer(app)("wakeAlarm", async (_c, kit) => {
        if (kit.connectToken === undefined) { return kit.refuse(400, "missing token"); }
        const body = await kit.body();
        if (body === undefined) { return kit.refuse(400, "expected an alarm instant or null"); }
        if (body.at !== null && !hostedEnabled(config)) { return kit.refuse(503, "hosted wakes are unavailable"); }
        const stored = await prisma.sandbox.updateMany({
            where: { tokenDigest: sha256Hex(kit.connectToken), removedAt: null, hosted: { isNot: null } },
            data: { scheduledWakeAt: body.at === null ? null : new Date(body.at), scheduledWakeRetryAt: null },
        });
        return stored.count === 0 ? kit.refuse(404, "unknown hosted sandbox") : kit.answer({ ok: true });
    });
    return app;
};

// The database is the clock's durable owner: a platform restart loses no alarm. Claim each attempt before its wake,
// leave the alarm until the ready daemon acknowledges it, and retry a refusal or failed start without replaying turns.
export const runHostedWakeAlarms = async (
    context: HostedWakeContext,
    now = new Date(),
    wake: typeof wakeHostedSandbox = wakeHostedSandbox,
): Promise<void> => {
    const retryable = { OR: [{ scheduledWakeRetryAt: null }, { scheduledWakeRetryAt: { lte: now } }] };
    const sandboxes = await context.prisma.sandbox.findMany({
        where: { removedAt: null, hosted: { isNot: null }, scheduledWakeAt: { lte: new Date(now.getTime() + HOSTED_WAKE_LEAD_MS) }, ...retryable },
        include: { hosted: true, owner: { select: { email: true } } },
        orderBy: { scheduledWakeAt: "asc" }, take: 64,
    });
    for (const sandbox of sandboxes) {
        if (sandbox.hosted === null || sandbox.scheduledWakeAt === null) { continue; }
        try {
            const claimed = await context.prisma.sandbox.updateMany({
                where: { id: sandbox.id, removedAt: null, hosted: { isNot: null }, scheduledWakeAt: sandbox.scheduledWakeAt, ...retryable },
                data: { scheduledWakeRetryAt: new Date(now.getTime() + HOSTED_WAKE_RETRY_MS) },
            });
            if (claimed.count === 0) { continue; }
            await wake(context, { ...sandbox, hosted: sandbox.hosted });
        } catch (error) {
            context.logger.warn({ err: error, sandboxId: sandbox.id }, "hosted alarm: wake did not complete; retained for retry");
        }
    }
};

export const startHostedWakeAlarms = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config)) { return; }
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_WAKE, () => runHostedWakeAlarms({ prisma, config, logger }))
            .catch((error: Error) => logger.error({ err: error }, "hosted alarm sweep failed"));
    };
    tick();
    setInterval(tick, 15_000).unref();
};
