import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { reapStaleTunnels } from "./sandbox/cloudflare.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";

// Data-retention sweep (GDPR storage limitation): expired sessions, verifications and desktop sign-in
// handoffs, plus sandbox-share invites older than 90 days whose email never became an account
// (grant-before-signup emails must not linger forever). Runs at boot, then daily. The privacy policy
// documents these windows — keep in sync.
const DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_MAX_AGE_MS = 90 * DAY_MS;

const runRetention = async (prisma: PrismaClient): Promise<{ sessions: number; verifications: number; handoffs: number; invites: number }> => {
    const now = new Date();
    // A handoff normally lives seconds — the redeem deletes it — so this only ever catches the ones nobody
    // picked up. They hold a Google ID token, which is exactly why an unclaimed one must not sit for a day.
    // The creator pool's ledgers keep 13 months: a full year of transparency history plus the month in
    // progress, then the rows go — they are pseudonymous but per-user, so storage limitation applies. The
    // credit meter's day rows follow the same window (nothing reads a past day, but a year of them is what
    // lets a member dispute a bill), as do the service-run rows earnings were computed from.
    const ledgerCutoff = new Date(now.getTime() - 396 * DAY_MS).toISOString().slice(0, 10);
    const [sessions, verifications, handoffs] = await Promise.all([
        prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.verification.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.desktopHandoff.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.extensionUseDay.deleteMany({ where: { day: { lt: ledgerCutoff } } }),
        prisma.creditSpend.deleteMany({ where: { day: { lt: ledgerCutoff } } }),
        prisma.serviceRun.deleteMany({ where: { createdAt: { lt: new Date(`${ledgerCutoff}T00:00:00.000Z`) } } }),
    ]);
    const stale = await prisma.sandboxMember.findMany({
        where: { createdAt: { lt: new Date(now.getTime() - INVITE_MAX_AGE_MS) } },
        select: { id: true, email: true },
    });
    // Grants store lowercased emails (router.ts share); compare against lowercased account emails.
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
    const { apiToken, zone, reapAfterDays, reapDryRun } = config.intenticCloudflare;
    const sweep = async (): Promise<void> => {
        // A failed sweep must not crash the API; the next daily run retries.
        try {
            logger.info(await runRetention(prisma), `retention sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `retention sweep failed`);
        }
        // Reap orphaned intentic-provided tunnels only when the intentic-provided path is configured (mirrors
        // intenticZoneOf). Guarded separately so a Cloudflare failure never masks the DB sweep's result.
        if (apiToken === `` || zone === ``) {
            return;
        }
        try {
            // Pre-provisioned pool tunnels (sandbox-pool.ts) are unclaimed and have never connected, so they look
            // exactly like idle orphans to the reaper — exclude them by name (the hostname's leftmost label IS the
            // tunnel name) so a full-but-idle pool is never reaped out from under the next signup.
            const reserved = await prisma.reservedSandbox.findMany({ select: { tunnelHostname: true } });
            const exclude = new Set(reserved.map((entry) => entry.tunnelHostname.slice(0, entry.tunnelHostname.indexOf(`.`))));
            const result = await reapStaleTunnels({
                apiToken,
                zone,
                reapAfterMs: reapAfterDays * DAY_MS,
                dryRun: reapDryRun,
                exclude,
                log: (tunnel) => logger.info({ ...tunnel, dryRun: reapDryRun }, `tunnel reap candidate`),
                onError: (tunnel, error) => logger.error({ ...tunnel, err: error }, `tunnel reap failed`),
            });
            logger.info(result, `tunnel reap sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `tunnel reap sweep failed`);
        }
    };
    const tick = (): void => {
        // Only one replica sweeps per tick (advisory lock); a failed lock connection defers to the next run.
        void runExclusive(config, JOB_RETENTION, sweep).catch((error) => logger.error({ err: error }, `retention lock failed`));
    };
    tick();
    setInterval(tick, DAY_MS);
};
