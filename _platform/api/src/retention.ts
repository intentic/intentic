import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { reapOrphanDnsRecords } from "./sandbox/cloudflare.js";
import { reconcileZrokAccounts } from "./sandbox/zrok.js";
import { zrokEnabled } from "./sandbox/zrok-provision.js";
import { reapHostedOrphans } from "./sandbox/hosted/hosted.js";
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
    // lets a member dispute a bill), as do the donation and service-run rows earnings were computed from.
    const ledgerCutoff = new Date(now.getTime() - 396 * DAY_MS).toISOString().slice(0, 10);
    const [sessions, verifications, handoffs] = await Promise.all([
        prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.verification.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.desktopHandoff.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.donation.deleteMany({ where: { month: { lt: ledgerCutoff.slice(0, 7) } } }),
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
    const { apiToken, zone, reapDryRun } = config.intenticCloudflare;
    const sweep = async (): Promise<void> => {
        // A failed sweep must not crash the API; the next daily run retries.
        try {
            logger.info(await runRetention(prisma), `retention sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `retention sweep failed`);
        }
        /* THE RECONCILE — every reachability grant on the hub whose sandbox row is gone, deleted. It replaces
         * the Cloudflare tunnel reaper and is a far simpler thing than what it replaces: idleness is no longer
         * evidence of anything (a sleeping hosted machine is disconnected by design), so the DB is the only
         * authority — an account whose row exists is live, an account with no row is garbage, and there is no
         * "inactive for N days" heuristic left to get wrong. A sandbox that is merely offline keeps its grant
         * forever, which is exactly right: the grant is one row on the hub, not ten DNS records against a
         * quota. Accounts outside our synthetic email shape are somebody else's and are never touched. */
        if (zrokEnabled(config)) {
            try {
                const rows = await prisma.sandbox.findMany({ select: { tokenDigest: true } });
                const live = new Set(rows.map((row) => row.tokenDigest.slice(0, 12)));
                const result = await reconcileZrokAccounts(config.zrok, {
                    live,
                    dryRun: reapDryRun,
                    log: (email) => logger.info({ email, dryRun: reapDryRun }, `orphan zrok account`),
                    onError: (email, error) => logger.error({ email, err: error }, `orphan zrok account delete failed`),
                });
                logger.info(result, `zrok account reconcile completed`);
            } catch (error) {
                logger.error({ err: error }, `zrok account reconcile failed`);
            }
        }
        // Cloudflare is DNS-only now, and the one thing still worth sweeping there is the loopback-certificate
        // residue (`local-*` A records and their ACME TXTs) that no tunnel teardown ever owned.
        if (apiToken === `` || zone === ``) {
            return;
        }
        /* The record sweep: the loopback pair (`local-<id>` A + its ACME TXT) of sandboxes that no longer
         * exist, plus any CNAME left pointing at a Cloudflare tunnel from before the migration. Nothing
         * creates tunnel records any more, so this is now a shrinking cleanup rather than a standing defence
         * against the per-zone quota — but the `total` it logs is still the number to watch. */
        try {
            const rows = await prisma.sandbox.findMany({ select: { tokenDigest: true } });
            const liveSandboxIds = new Set(rows.map((row) => row.tokenDigest.slice(0, 12)));
            const records = await reapOrphanDnsRecords({
                apiToken,
                zone,
                liveSandboxIds,
                dryRun: reapDryRun,
                log: (record) => logger.info({ ...record, dryRun: reapDryRun }, `orphan DNS record`),
                onError: (record, error) => logger.error({ ...record, err: error }, `orphan DNS record delete failed`),
            });
            logger.info(records, `DNS record sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `DNS record sweep failed`);
        }
        // The hosted lane's reconcile: destroy our-prefix Fly apps whose HostedMachine row is gone (failed
        // provisions, delete teardowns that lost their race). Self-gated on the hosted config; guarded
        // separately for the same reason the tunnel reap is.
        try {
            await reapHostedOrphans(prisma, config, logger);
        } catch (error) {
            logger.error({ err: error }, `hosted reap sweep failed`);
        }
    };
    const tick = (): void => {
        // Only one replica sweeps per tick (advisory lock); a failed lock connection defers to the next run.
        void runExclusive(config, JOB_RETENTION, sweep).catch((error) => logger.error({ err: error }, `retention lock failed`));
    };
    tick();
    setInterval(tick, DAY_MS);
};
