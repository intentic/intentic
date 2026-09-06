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

// Data-retention sweep (GDPR storage limitation): expired sessions, verifications and desktop sign-in
// handoffs, plus sandbox-share invites older than 90 days whose email never became an account
// (grant-before-signup emails must not linger forever). Runs at boot, then daily. The privacy policy
// documents these windows, keep in sync.
const DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_MAX_AGE_MS = 90 * DAY_MS;

const runRetention = async (prisma: PrismaClient): Promise<{ sessions: number; verifications: number; handoffs: number; invites: number }> => {
    const now = new Date();
    // A handoff normally lives seconds, the redeem deletes it, so this only ever catches the ones nobody
    // picked up. They hold a Google ID token, which is exactly why an unclaimed one must not sit for a day.
    // The hosted hour meter's month rows keep 13 months: nothing reads a past month, but a year of them is
    // what lets someone dispute a limit they were told they hit. Pseudonymous but per-user, so storage
    // limitation applies and they go after that.
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
    const { apiToken, zone, reap, reapDryRun } = config.intenticCloudflare;
    const sweep = async (): Promise<void> => {
        // A failed sweep must not crash the API; the next daily run retries.
        try {
            logger.info(await runRetention(prisma), `retention sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `retention sweep failed`);
        }
        // Cloudflare is DNS-only now, and the one thing still worth sweeping there is the loopback-certificate
        // residue (`local-*` A records and their ACME TXTs) that no tunnel teardown ever owned.
        if (apiToken === `` || zone === ``) {
            return;
        }
        /* THE RECORD SWEEP, AND WHY IT DOES NOT DELETE UNLESS SOMEBODY SAID SO.
         *
         * What it collects: the per-sandbox loopback A records one wildcard now answers for, the ACME TXT of a
         * sandbox that no longer exists, and the tunnel CNAMEs of one that no longer exists. The `total` it
         * logs is the number to watch either way, because a full zone stops loopback certificates being
         * issued at all, for every sandbox at once.
         *
         * The verdicts are made against THIS DEPLOYMENT'S DATABASE, and nothing checks that this deployment is
         * the one whose sandboxes live in that zone. The advisory lock does not help: it is taken on this
         * platform's own postgres (jobs-lock.ts), so two deployments sharing one Cloudflare token do not see
         * each other at all. A developer running the API locally with the production token in their env
         * therefore swept the production zone against an empty local database, on the first tick after boot,
         * and every sandbox in it looked like an orphan.
         *
         * So deleting is opt-in and the default is to LOOK: the sweep runs, reports what it would collect and
         * what the zone's record count is, and touches nothing. A deployment that genuinely owns its zone sets
         * INTENTIC_CLOUDFLARE_REAP=true and gets the collection back. Nobody has to remember to turn a
         * destructive default off on a laptop. */
        const deleting = reap && !reapDryRun;
        try {
            // The row's own 12-hex id, read rather than re-sliced off `tokenDigest`: the column exists so the
            // derivation lives in exactly one place (sandboxIdFromToken, at creation), and a sweep that decides
            // what to DELETE is the last place that should be re-deriving it from a digest by hand.
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
        // The hosted lane's reconcile: destroy our-prefix Fly apps whose HostedMachine row is gone (failed
        // provisions, delete teardowns that lost their race). Self-gated on the hosted config; guarded
        // separately for the same reason the tunnel reap is.
        try {
            await reapHostedOrphans(prisma, config, logger);
        } catch (error) {
            logger.error({ err: error }, `hosted reap sweep failed`);
        }
        // Collect the free machines nobody has opened in weeks (one warning email first). A machine on the
        // hosted plan is never touched, nor is anything currently running. The hour meter's settle used to
        // ride here daily; it is the hourly meter tick's now (hosted-meter.ts), so a machine collected here
        // has had its last stretch on the books for at most an hour, not a day.
        try {
            logger.info(await reapIdleHosted(prisma, config, logger), `hosted idle sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `hosted idle sweep failed`);
        }
        // Old environment build rows (their logs are the bulk), keeping the one each machine currently runs.
        try {
            logger.info({ dropped: await sweepHostedBuilds(prisma) }, `hosted build sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `hosted build sweep failed`);
        }
        /* The admin panel's history and its morning mail, last so the day it records reflects the sweeps
         * above. The rollup freezes yesterday into admin_daily_stat (counts only, retention never touches
         * them); the digest pushes the attention feed to ADMIN_EMAILS, latched to once per day on that
         * same row, so a redeploy morning rolls up again (upsert) but never mails twice. */
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
