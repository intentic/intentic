import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { reapOrphanDnsRecords, reapStaleTunnels } from "./sandbox/cloudflare.js";
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

/* WHICH SANDBOX TUNNELS THE REAPER MUST NOT TOUCH — the DB's answer, as a pure function.
 *
 * The reaper's original rule was "idle for N days = orphan", and the hosted lane broke it: a sleeping hosted
 * machine's connector is disconnected BY DESIGN (the idle-stop stopped the machine), so after a quiet week the
 * sweep would have deleted the tunnel out from under a sandbox that wakes on its owner's next visit — with the
 * dead connector token baked into the machine's env, permanently unreachable. Idleness is not abandonment any
 * more; the rows are.
 *
 * So the protect set is computed from the rows, which is possible without decrypting anything: a tunnel is
 * named `sandbox-<first 12 hex of sha256(token)>`, and the row already stores the full digest for lookups.
 * Protected: every hosted row (sleep is normal, and its machine holds the connector token); every row seen
 * within the prune window (a laptop off for a fortnight is not abandoned); every never-connected row younger
 * than the reap window (a setup in progress); and, when pruning is disabled (pruneAfterDays 0), every row
 * outright. What is NOT protected falls to the sweep — abandoned setups past the reap window, and
 * connected-before sandboxes offline past the prune window — and the sweep then heals those rows (below) so
 * the address is re-minted, identical, on their owner's next setup visit. */
export const protectedTunnelNames = (
    rows: readonly { tokenDigest: string; lastSeenAt: Date | null; createdAt: Date; hosted: boolean }[],
    args: { now: number; reapAfterMs: number; pruneAfterMs: number },
): Set<string> => {
    const names = new Set<string>();
    for (const row of rows) {
        const protectedRow =
            row.hosted ||
            (row.lastSeenAt === null
                ? // Never connected: still someone's setup-in-progress inside the reap window, reclaimable past
                  // it (the shipped behavior since the reaper existed — pruneAfterDays does not govern these).
                  args.now - row.createdAt.getTime() < args.reapAfterMs
                : // Connected before: a workspace someone has used. 0 turns the inactivity prune off entirely.
                  args.pruneAfterMs === 0 || args.now - row.lastSeenAt.getTime() < args.pruneAfterMs);
        if (protectedRow) {
            names.add(`sandbox-${row.tokenDigest.slice(0, 12)}`);
        }
    }
    return names;
};

export const startRetention = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const { apiToken, zone, reapAfterDays, pruneAfterDays, reapDryRun } = config.intenticCloudflare;
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
            // tunnel name) so a full-but-idle pool is never reaped out from under the next signup. Live rows'
            // tunnels join the exclusion through protectedTunnelNames (the DB truth the idle heuristic lacks).
            const [reserved, rows] = await Promise.all([
                prisma.reservedSandbox.findMany({ select: { tunnelHostname: true } }),
                prisma.sandbox.findMany({ select: { tokenDigest: true, lastSeenAt: true, createdAt: true, hosted: { select: { id: true } } } }),
            ]);
            const exclude = new Set(reserved.map((entry) => entry.tunnelHostname.slice(0, entry.tunnelHostname.indexOf(`.`))));
            for (const name of protectedTunnelNames(
                rows.map((row) => ({ tokenDigest: row.tokenDigest, lastSeenAt: row.lastSeenAt, createdAt: row.createdAt, hosted: row.hosted !== null })),
                { now: Date.now(), reapAfterMs: reapAfterDays * DAY_MS, pruneAfterMs: pruneAfterDays * DAY_MS },
            )) {
                exclude.add(name);
            }
            const result = await reapStaleTunnels({
                apiToken,
                zone,
                reapAfterMs: reapAfterDays * DAY_MS,
                dryRun: reapDryRun,
                exclude,
                log: (tunnel) => logger.info({ ...tunnel, dryRun: reapDryRun }, `tunnel reap candidate`),
                onError: (tunnel, error) => logger.error({ ...tunnel, err: error }, `tunnel reap failed`),
            });
            logger.info({ ...result, reapedNames: undefined }, `tunnel reap sweep completed`);
            /* HEAL THE ROWS BEHIND REAPED TUNNELS — the recovery half of pruning. A row whose tunnel was just
             * deleted still caches the dead connector token and hostname, and the mint paths (setupCode,
             * hostedProvision) only provision when those are null — so without this, a pruned sandbox resumed
             * a month later showed a command with a dead token and an address that no longer resolves.
             * Nulling the cache arms the ordinary lazy re-provision, and because the hostname is derived from
             * the connect token, the owner gets the SAME address back on their next setup visit. */
            if (result.reapedNames.length > 0) {
                const healed = await prisma.sandbox.updateMany({
                    where: { tunnelHostname: { in: result.reapedNames.map((name) => `${name}.${zone}`) } },
                    data: { tunnelToken: null, tunnelHostname: null },
                });
                if (healed.count > 0) {
                    logger.info({ healed: healed.count }, `pruned sandboxes armed for re-provision on next setup visit`);
                }
            }
        } catch (error) {
            logger.error({ err: error }, `tunnel reap sweep failed`);
        }
        /* The record-level sweep (reapOrphanDnsRecords): dangling tunnel CNAMEs, leaked local-* loopback
         * records, stray ACME TXTs — the stale records the tunnel walk cannot see, and what actually fills a
         * zone to Cloudflare's cap (81045). Runs AFTER the tunnel reap so just-reaped tunnels' records are
         * already dangling by the time it looks. The `total` in its log line is the zone's record count — the
         * quota-pressure number an operator should be watching before 81045 announces it. */
        try {
            const [rows, reserved] = await Promise.all([
                prisma.sandbox.findMany({ select: { tokenDigest: true } }),
                prisma.reservedSandbox.findMany({ select: { tokenDigest: true } }),
            ]);
            const liveSandboxIds = new Set([...rows, ...reserved].map((row) => row.tokenDigest.slice(0, 12)));
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
