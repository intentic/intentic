import { sendAdminDigest } from "./admin/admin-digest.js";
import { rollupAdminDaily } from "./admin/admin-rollup.js";
import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { expireOffers } from "./mcp/mcp-offer.js";
import { reapOrphanDnsRecords } from "./sandbox/cloudflare.js";
import { reapHostedOrphans } from "./sandbox/hosted/hosted.js";
import { reapIdleHosted } from "./sandbox/hosted/hosted-idle.js";
import { settleHostedStretches } from "./sandbox/hosted/hosted-usage.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";

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
    // The creator pool's ledgers keep 13 months: a full year of transparency history plus the month in
    // progress, then the rows go, they are pseudonymous but per-user, so storage limitation applies. The
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
        // The hosted hour meter's month rows, on the same window and for the same reason: nothing reads a
        // past month, but a year of them is what lets someone dispute a limit they were told they hit.
        prisma.hostedUsage.deleteMany({ where: { month: { lt: ledgerCutoff.slice(0, 7) } } }),
        // Wanted-list rows go far sooner than the ledgers: the public aggregate reads 90 days, and a want is
        // a lead rather than a record anyone disputes, double the read window is all the history it needs.
        prisma.serviceWant.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 180 * DAY_MS) } } }),
        /* Approval offers are ephemera, not a ledger, the CHARGE is recorded as a service run, which the
         * window above keeps. What an offer holds is the request body an agent composed, which can carry
         * anything the task was about, so it goes on the shortest window here: a day is far past the ten
         * minutes it could ever be acted on, and long enough that "what did my agent ask for this morning"
         * is still answerable. */
        prisma.serviceOffer.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DAY_MS) } } }),
        // OAuth access tokens Better Auth issued to MCP clients, once even their refresh token is dead. The
        // library never prunes them; without this, every reconnect leaves a row behind forever.
        prisma.oauthAccessToken.deleteMany({ where: { refreshTokenExpiresAt: { lt: now } } }),
    ]);
    /* Offers nobody answered, marked before the delete above eventually takes them. Not a correctness
     * requirement, every reader already treats a lapsed row as expired, but a `pending` row that can never
     * be clicked is a table lying at rest, and this is the one statement that stops it. */
    await expireOffers(prisma, now);
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
            const rows = await prisma.sandbox.findMany({ select: { tokenDigest: true } });
            const liveSandboxIds = new Set(rows.map((row) => row.tokenDigest.slice(0, 12)));
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
        /* The hour meter's daily settle: close the stretch of every machine that has stopped since anyone
         * last looked. Without this a box woken once and asleep an hour later stays uncounted until its owner
         * happens to return, which is precisely the account the meter most needs to be right about.
         *
         * Before the idle sweep deliberately: settling reads machine state anyway, and a machine about to be
         * collected should have its last stretch on the books before its app stops existing. */
        try {
            await settleHostedStretches(prisma, config, logger);
        } catch (error) {
            logger.error({ err: error }, `hosted meter sweep failed`);
        }
        // Collect the free machines nobody has opened in weeks (one warning email first). Members are never
        // touched, nor is anything currently running.
        try {
            logger.info(await reapIdleHosted(prisma, config, logger), `hosted idle sweep completed`);
        } catch (error) {
            logger.error({ err: error }, `hosted idle sweep failed`);
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
