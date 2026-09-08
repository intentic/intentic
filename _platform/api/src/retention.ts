import { sendAdminDigest } from "./admin/admin-digest.js";
import { rollupAdminDaily } from "./admin/admin-rollup.js";
import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { reapOrphanDnsRecords } from "./sandbox/cloudflare.js";
import { reapHostedOrphans } from "./sandbox/hosted/hosted.js";
import { sweepHostedBuilds } from "./sandbox/hosted/hosted-build.js";
import { reapIdleHosted } from "./sandbox/hosted/hosted-idle.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "./durations.js";

// GDPR storage limitation: expired sessions/verifications/handoffs, plus invites unclaimed past this age.
const INVITE_MAX_AGE_MS = 90 * DAY_MS;

const runRetention = async (prisma: PrismaClient): Promise<{ sessions: number; verifications: number; handoffs: number; invites: number }> => {
    const now = new Date();
    // 13 months of usage history, enough to dispute a limit; pseudonymous but per-user, so it still expires.
    const ledgerCutoff = new Date(now.getTime() - 396 * DAY_MS).toISOString().slice(0, 10);
    const [sessions, verifications, handoffs] = await Promise.all([
        prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.verification.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.desktopHandoff.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.hostedUsage.deleteMany({ where: { month: { lt: ledgerCutoff.slice(0, 7) } } }),
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
    return { sessions: sessions.count, verifications: verifications.count, handoffs: handoffs.count, invites: invites.count };
};

export const startRetention = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const { apiToken, zone, reap, reapDryRun } = config.intenticCloudflare;
    const sweep = async (): Promise<void> => {
        // A failed sweep must not crash the API; the next daily run retries.
        try {
            logger.info(await runRetention(prisma), `retention sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `retention sweep failed`);
        }
        // Cloudflare is DNS-only now; the one thing still worth sweeping is loopback-certificate residue.
        if (apiToken === `` || zone === ``) {
            return;
        }
        // Deleting is opt-in: verdicts use this deployment's database, invisible to a token shared by another one.
        const deleting = reap && !reapDryRun;
        try {
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
            logger.info({ ...records, deleting, sandboxes: liveSandboxIds.size }, `DNS record sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `DNS record sweep failed`);
        }
        // Destroys our-prefix Fly apps whose HostedMachine row is gone; self-gated on the hosted config.
        try {
            await reapHostedOrphans(prisma, config, logger);
        } catch (error) {
            logger.error({ err: error }, `hosted reap sweep failed`);
        }
        // Collects free machines unopened for weeks (one warning email first); plan and running machines are untouched.
        try {
            logger.info(await reapIdleHosted(prisma, config, logger), `hosted idle sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `hosted idle sweep failed`);
        }
        // Old environment build rows, keeping the one each machine currently runs.
        try {
            logger.info({ dropped: await sweepHostedBuilds(prisma) }, `hosted build sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `hosted build sweep failed`);
        }
        // Last, so the day it rolls up reflects the sweeps above; the digest latches to once per day on that row.
        try {
            const rollup = await rollupAdminDaily(prisma);
            logger.info(rollup, `admin daily rollup completed`);
            await sendAdminDigest(prisma, config, logger, rollup.day);
        } catch (error) {
            logger.error({ err: error }, `admin rollup/digest failed`);
        }
    };
    const tick = (): void => {
        // Only one replica sweeps per tick (advisory lock); a failed lock connection defers to the next run.
        void runExclusive(config, JOB_RETENTION, sweep).catch((error) => logger.error({ err: error }, `retention lock failed`));
    };
    tick();
    setInterval(tick, DAY_MS);
};
