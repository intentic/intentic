import { sendAdminDigest } from "./admin/admin-digest.js";
import { rollupAdminDaily } from "./admin/admin-rollup.js";
import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { reapOrphanDnsRecords } from "./sandbox/cloudflare.js";
import { reapHostedOrphans } from "./sandbox/hosted/hosted.js";
import { sweepHostedBuilds } from "./sandbox/hosted/build/hosted-build.js";
import { reapIdleHosted } from "./sandbox/hosted/hosted-idle.js";
import { kickHostedCleanup } from "./sandbox/hosted/hosted-cleanup.js";
import { sweepSandboxTrash } from "./sandbox/sandbox-trash.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "./durations.js";

// GDPR storage limitation: expired sessions/verifications/handoffs, plus invites unclaimed past this age.
const INVITE_MAX_AGE_MS = 90 * DAY_MS;
// The same-source caps count a day; a month of rows is every count that could still be disputed.
const PROVISION_MAX_AGE_MS = 30 * DAY_MS;

const runRetention = async (prisma: PrismaClient): Promise<{ sessions: number; verifications: number; handoffs: number; invites: number; provisions: number }> => {
    const now = new Date();
    // 13 months of usage history, enough to dispute a limit; pseudonymous but per-user, so it still expires. Strikes
    // are argued against the same way and keep the same window.
    const ledgerCutoff = new Date(now.getTime() - 396 * DAY_MS);
    const [sessions, verifications, handoffs, , , provisions] = await Promise.all([
        prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.verification.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.desktopHandoff.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.hostedUsage.deleteMany({ where: { month: { lt: ledgerCutoff.toISOString().slice(0, 7) } } }),
        prisma.hostedStrike.deleteMany({ where: { createdAt: { lt: ledgerCutoff } } }),
        prisma.hostedProvision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - PROVISION_MAX_AGE_MS) } } }),
    ]);
    const stale = await prisma.sandboxMember.findMany({
        where: { createdAt: { lt: new Date(now.getTime() - INVITE_MAX_AGE_MS) } },
        select: { id: true, email: true },
    });
    // Grants store lowercased emails (router.ts share); compared against lowercased account emails.
    const users = await prisma.user.findMany({
        where: { email: { in: [...new Set(stale.map((invite) => invite.email))] } },
        select: { email: true },
    });
    const known = new Set(users.map((user) => user.email.toLowerCase()));
    const invites = await prisma.sandboxMember.deleteMany({
        where: { id: { in: stale.filter((invite) => !known.has(invite.email)).map((invite) => invite.id) } },
    });
    return { sessions: sessions.count, verifications: verifications.count, handoffs: handoffs.count, invites: invites.count, provisions: provisions.count };
};

/* One sweep, isolated: a failure here must not crash the API or stop the sweeps after it, and the next daily run
 * retries it. A step returning an object has it logged as that line's fields. */
const step = async (logger: Logger, what: string, run: () => Promise<Record<string, unknown> | void>): Promise<void> => {
    try {
        logger.info(await run(), `${what} completed`);
    } catch (error) {
        logger.error({ err: error }, `${what} failed`);
    }
};

export const startRetention = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const { apiToken, zone, reap, reapDryRun } = config.intenticCloudflare;
    const sweep = async (): Promise<void> => {
        await step(logger, `retention sweep`, () => runRetention(prisma));
        // Cloudflare is DNS-only now; the one thing still worth sweeping is loopback-certificate residue.
        if (apiToken === `` || zone === ``) {
            return;
        }
        // Deleting is opt-in: verdicts use this deployment's database, invisible to a token shared by another one.
        const deleting = reap && !reapDryRun;
        await step(logger, `DNS record sweep`, async () => {
            // The row's own id, read rather than re-derived from `tokenDigest` by hand in the one place that deletes.
            const rows = await prisma.sandbox.findMany({ select: { tunnelId: true } });
            const liveSandboxIds = new Set(rows.map((row) => row.tunnelId));
            const records = await reapOrphanDnsRecords({
                apiToken,
                zone,
                liveSandboxIds,
                dryRun: !deleting,
                log: (record) => logger.info({ ...record, deleting }, `orphan DNS record`),
                onError: (record, error) => logger.error({ ...record, err: error }, `orphan DNS record delete failed`),
            });
            return { ...records, deleting, sandboxes: liveSandboxIds.size };
        });
        // Destroys our-prefix Fly apps whose HostedMachine row is gone; self-gated on the hosted config.
        await step(logger, `hosted reap sweep`, () => reapHostedOrphans(prisma, config, logger));
        // Collects free machines unopened for weeks (one warning email first); plan and running machines are untouched.
        await step(logger, `hosted idle sweep`, () => reapIdleHosted(prisma, config, logger));
        // Old environment build rows, keeping the one each machine currently runs.
        await step(logger, `hosted build sweep`, async () => ({ dropped: await sweepHostedBuilds(prisma) }));
        // Deleted sandboxes past the owner's recovery window: the row goes and its app joins the teardown queue.
        // After the reaper above, so the apps it hands over are not read as orphans on the same pass.
        await step(logger, `sandbox trash sweep`, async () => {
            const purged = await sweepSandboxTrash(prisma);
            kickHostedCleanup(prisma, config, logger);
            return purged;
        });
        // Last, so the day it rolls up reflects the sweeps above; the digest latches to once per day on that row.
        await step(logger, `admin rollup/digest`, async () => {
            const rollup = await rollupAdminDaily(prisma);
            await sendAdminDigest(prisma, config, logger, rollup.day);
            return rollup;
        });
    };
    const tick = (): void => {
        // Only one replica sweeps per tick (advisory lock); a failed lock connection defers to the next run.
        void runExclusive(config, JOB_RETENTION, sweep).catch((error) => logger.error({ err: error }, `retention lock failed`));
    };
    tick();
    setInterval(tick, DAY_MS);
};
