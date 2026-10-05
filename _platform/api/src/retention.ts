import { type AdminDigestLine, sendAdminDigest } from "./admin/admin-digest.js";
import { convergenceDigestLines, recentHostReports, upkeepConvergence } from "./admin/upkeep-convergence.js";
import { rollupAdminDaily } from "./admin/admin-rollup.js";
import { JOB_RETENTION, runExclusive } from "./jobs-lock.js";
import { reapOrphanDnsRecords } from "./sandbox/cloudflare.js";
import { type HostedReapReport, reapHostedOrphans } from "./sandbox/hosted/hosted.js";
import { type HostedShapeReport, sweepHostedAppShapes } from "./sandbox/hosted/hosted-app-shape.js";
import { sweepHostedBuilds } from "./sandbox/hosted/build/hosted-build.js";
import { reapIdleHosted } from "./sandbox/hosted/hosted-idle.js";
import { kickHostedCleanup } from "./sandbox/hosted/hosted-cleanup.js";
import { sweepHostedStanding } from "./sandbox/hosted/abuse/carried-standing.js";
import { sweepStripeErasures } from "./sandbox/hosted/hosted-plan.js";
import { sweepSandboxTrash } from "./sandbox/sandbox-trash.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "./durations.js";

// GDPR storage limitation: expired sessions/verifications/handoffs, plus invites unclaimed past this age.
const INVITE_MAX_AGE_MS = 90 * DAY_MS;
// The same-source caps count a day; a month of rows is every count that could still be disputed.
const PROVISION_MAX_AGE_MS = 30 * DAY_MS;

const runRetention = async (
    prisma: PrismaClient,
): Promise<{ sessions: number; verifications: number; handoffs: number; invites: number; provisions: number }> => {
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
    return {
        sessions: sessions.count,
        verifications: verifications.count,
        handoffs: handoffs.count,
        invites: invites.count,
        provisions: provisions.count,
    };
};

// A short list in a digest line: the first few names, and how many more.
const named = (names: readonly string[]): string =>
    names.length <= 8 ? names.join(`, `) : `${names.slice(0, 8).join(`, `)} and ${names.length - 8} more`;

/* WHAT THE HOSTED REAPER LEFT FOR A HUMAN (2026-10-05), for the admin digest: it destroys only on a deletion record, so
 * what it cannot prove gone is somebody's to decide, and a pass it refused or cut short is somebody's to watch. */
export const reapDigestLines = (report: HostedReapReport): AdminDigestLine[] => [
    ...(report.refused.length === 0
        ? []
        : [
              {
                  severity: `danger` as const,
                  title: `The hosted reaper refused to destroy ${report.refused.length} apps at once`,
                  detail: `That is more than a quarter of the fleet, which looks like a wrong database rather than litter, so nothing was destroyed: ${named(report.refused)}.`,
              },
          ]),
    ...(report.forgotten.length === 0
        ? []
        : [
              {
                  severity: `warning` as const,
                  title: `${report.forgotten.length} hosted app(s) belong to sandboxes this database has no record of`,
                  detail: `Neither a sandbox row nor a deletion record names them, so the reaper leaves them standing: ${named(report.forgotten)}. A restore from an older backup leaves exactly these. Delete one by hand only once you know its sandbox is gone; the owner's Reconnect brings a live one back.`,
              },
          ]),
    ...(report.deferred.length === 0
        ? []
        : [
              {
                  severity: `warning` as const,
                  title: `${report.deferred.length} deleted sandboxes' apps wait for the next reaper pass`,
                  detail: `One pass destroys a tenth of the fleet at most; these go tomorrow: ${named(report.deferred)}.`,
              },
          ]),
];

// What the daily app-shape check would not touch: a machine another deployment or nobody made, a disk no row names.
export const shapeDigestLines = (report: HostedShapeReport): AdminDigestLine[] => [
    ...(report.foreignMachines.length === 0
        ? []
        : [
              {
                  severity: `warning` as const,
                  title: `${report.foreignMachines.length} machine(s) this platform did not make are in sandboxes' apps`,
                  detail: `Left running: another deployment shares the Fly org, or someone made them by hand. ${named(report.foreignMachines)}.`,
              },
          ]),
    ...(report.strayVolumes.length === 0
        ? []
        : [
              {
                  severity: `warning` as const,
                  title: `${report.strayVolumes.length} volume(s) in sandboxes' apps are not the disk their row names`,
                  detail: `Billed and kept, since each may be somebody's older disk: ${named(report.strayVolumes)}.`,
              },
          ]),
];

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
        // What the sweeps below leave for a human; the digest at the end carries it.
        const findings: AdminDigestLine[] = [];
        await step(logger, `retention sweep`, () => runRetention(prisma));
        // A deleted account's carried hosted standing: twelve months after its latest change, its minutes at month's end.
        await step(logger, `hosted standing sweep`, () => sweepHostedStanding(prisma));
        // Deleted accounts' Stripe customers an erase could not delete at once; self-gated on the Stripe key.
        await step(logger, `Stripe erasure sweep`, async () =>
            config.hostedPlan.stripeSecretKey === `` ? { skipped: `no Stripe key` } : sweepStripeErasures(prisma, config, logger),
        );
        // Cloudflare is DNS-only now; the one thing still worth sweeping is loopback-certificate residue. Only that step
        // waits on a token: every sweep after it gates itself on its own config.
        // (2026-10-05) This used to return here, so a platform without a Cloudflare token (self-host leaves it empty)
        // never ran the reapers, the build sweep, the trash purge or the digest, and kept trashed apps forever.
        const deleting = reap && !reapDryRun;
        await step(logger, `DNS record sweep`, async () => {
            if (apiToken === `` || zone === ``) {
                return { skipped: `no Cloudflare token or zone` };
            }
            // The row's own id, read rather than re-derived from `tokenDigest` by hand in the one place that deletes.
            const rows = await prisma.sandbox.findMany({ select: { tunnelId: true } });
            const liveSandboxIds = new Set(rows.map((row) => row.tunnelId));
            const records = await reapOrphanDnsRecords({
                apiToken,
                zone,
                liveSandboxIds,
                // (2026-10-05) A record goes for its sandbox only on that sandbox's deletion record, as an app does.
                deletedAmong: async (ids) => {
                    const held = await prisma.sandboxTombstone.findMany({ where: { tunnelId: { in: [...ids] } }, select: { tunnelId: true } });
                    return new Set(held.map((row) => row.tunnelId));
                },
                dryRun: !deleting,
                log: (record) => logger.info({ ...record, deleting }, `orphan DNS record`),
                onError: (record, error) => logger.error({ ...record, err: error }, `orphan DNS record delete failed`),
            });
            return { ...records, deleting, sandboxes: liveSandboxIds.size };
        });
        // (2026-10-05) Whether the agents' own upkeep brought owners' machines to the current shape, by agent version: one
        // line for the digest when machines on the newest agent still hold leftovers it could not clear.
        await step(logger, `upkeep convergence`, async () => {
            const rows = upkeepConvergence(await recentHostReports(prisma));
            findings.push(...convergenceDigestLines(rows));
            return { versions: rows };
        });
        // Destroys our-prefix Fly apps no row names whose sandbox has a deletion record, the oldest first up to the pass's
        // cap; self-gated on the hosted config. What it cannot prove gone it reports, here and in the digest.
        await step(logger, `hosted reap sweep`, async () => {
            const report = await reapHostedOrphans(prisma, config, logger);
            findings.push(...reapDigestLines(report));
            return report;
        });
        // (2026-10-05) Every person's app held to its one machine and one disk (hosted-app-shape.ts), which until now only
        // a build checked, and only while it ran. Destroys strays of ours, capped; reports the rest.
        await step(logger, `hosted app shape sweep`, async () => {
            const report = await sweepHostedAppShapes(prisma, config, logger);
            findings.push(...shapeDigestLines(report));
            return report;
        });
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
            await sendAdminDigest(prisma, config, logger, rollup.day, undefined, findings);
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
