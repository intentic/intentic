import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { JOB_HOSTED_POOL, runExclusive } from "../../jobs-lock.js";
import { createApp, createMachine, createVolume, deleteApp, getMachine } from "./fly.js";
import { hostedEnabled } from "./hosted.js";

/* THE WARM POOL'S LIFECYCLE — everything except the claim, which lives beside provisionHosted (hosted.ts)
 * because a claim's product is a HostedMachine.
 *
 * The minutes of a hosted first boot are almost entirely one thing: pulling the sandbox image onto the Fly
 * host. Everything else — app, volume, machine, the daemon's own boot — is seconds. So the pool pays the pull
 * ahead of demand: a machine is built with the REAL image but its first boot runs a no-op (`init.exec`
 * replaces the entrypoint), which forces the pull and then exits clean, leaving a stopped machine with a warm
 * rootfs. It never runs the sandbox, carries no identity, and costs only its volume while it waits.
 *
 * The reconcile below is the pool's whole management: build up to the target per region, notice builds that
 * finished (or died), rebuild machines whose image drifted from config, collect claims that crashed, and
 * drain everything when the pool is switched off. It runs on the shared advisory lock so replicas never
 * double-build, and every action is one row's — a failure logs and moves on, the next tick retries. */

// The no-op the pool machine's first boot runs instead of the sandbox: the pull happens before exec does, and
// a clean exit stops the machine (the same restart policy that lets the daemon's idle exit stop a real one).
export const WARM_BOOT_EXEC = [`/bin/true`] as const;

// A build observed `building` for this long is stuck (image pulls finish in minutes) — torn down and rebuilt.
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
// A `claimed` row this old is a claim that crashed between winning the row and committing the hand-off.
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

// Random rather than derived: a pool machine belongs to nobody, so there is no sandbox id to derive from —
// but the shared prefix keeps it inside the reaper's jurisdiction and the Fly console's story.
const poolAppName = (config: Config): string => `${config.hosted.appPrefix}-pool-${randomBytes(6).toString(`hex`)}`;

// Build one pool machine: app → volume → machine whose boot is the no-op. The row is stamped `building`; the
// reconcile flips it `ready` once Fly reports the no-op boot stopped. Cleanup mirrors provisionHosted's: a
// failure deletes the app, and anything that slips through is an app with no row — reaper food.
const buildPoolMachine = async (prisma: PrismaClient, config: Config, logger: Logger, region: string): Promise<void> => {
    const { flyApiToken, flyOrg, image, cpus, memoryMb, volumeGb } = config.hosted;
    const appName = poolAppName(config);
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        const warm = {
            ...flyMachineConfig({ name: appName, image, baseImage: image, guest: { cpus, memoryMb }, volumeId, env: [] }),
            init: { exec: [...WARM_BOOT_EXEC] },
        };
        const { machineId } = await createMachine(flyApiToken, appName, { name: appName, region, config: warm });
        await prisma.hostedPoolMachine.create({ data: { appName, machineId, volumeId, region, image, state: `building` } });
        logger.info({ app: appName, region }, `hosted pool: building a warm machine`);
    } catch (error) {
        await deleteApp(flyApiToken, appName).catch((cleanupError: unknown) =>
            logger.warn({ err: cleanupError, app: appName }, `hosted pool: cleanup after failed build failed; orphaned for the reaper`),
        );
        throw error;
    }
};

// Tear one pool machine down, row and app together. App first: a row without an app is harmless (the next
// claim skips it as gone), while an app without a row is a day away from the reaper anyway.
const destroyPoolMachine = async (prisma: PrismaClient, config: Config, row: { id: string; appName: string }): Promise<void> => {
    await deleteApp(config.hosted.flyApiToken, row.appName);
    await prisma.hostedPoolMachine.delete({ where: { id: row.id } });
};

/* One reconcile pass. Deliberately sequential and per-row-guarded: the pool is small (a handful of machines),
 * the Fly API is rate-limited, and a tick that half-succeeds converges on the next one. */
export const reconcileHostedPool = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const all = await prisma.hostedPoolMachine.findMany({ orderBy: { createdAt: `asc` } });
    const now = Date.now();
    /* CLAIMED ROWS FIRST, whatever the target — a claim is the one state whose app may already be somebody's,
     * so neither the drain below nor the stock-taking may treat it as the pool's to destroy. Fresh: a
     * hand-off in flight, untouchable. Stale: the claim crashed between winning the row and committing — if a
     * HostedMachine adopted the app the machine IS somebody's now and only the pool row is stale; otherwise a
     * half-branded machine belongs to nobody, may carry a sandbox's tokens, and must go entirely. */
    const rows: typeof all = [];
    for (const row of all) {
        if (row.state !== `claimed`) {
            rows.push(row);
            continue;
        }
        if (now - row.updatedAt.getTime() <= CLAIM_TIMEOUT_MS) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        const adopted = await prisma.hostedMachine.findUnique({ where: { appName: row.appName } });
        // oxlint-disable-next-line eslint/no-await-in-loop
        await (adopted !== null ? prisma.hostedPoolMachine.delete({ where: { id: row.id } }) : destroyPoolMachine(prisma, config, row)).catch(
            (error: unknown) => logger.error({ err: error, app: row.appName }, `hosted pool: collecting a crashed claim failed`),
        );
    }
    // The pool is off (or the lane is): drain it. Everything left after the claim pass is the platform's own
    // — nothing in the standing stock is ever somebody's.
    const target = hostedEnabled(config) ? config.hosted.poolSize : 0;
    if (target === 0) {
        for (const row of rows) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on the API
            await destroyPoolMachine(prisma, config, row).catch((error: unknown) =>
                logger.error({ err: error, app: row.appName }, `hosted pool: drain failed; retried next tick`),
            );
        }
        return;
    }
    const live = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
        // The image moved under a finished machine: its warm rootfs is the WRONG rootfs, worth nothing.
        if (row.image !== config.hosted.image) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyPoolMachine(prisma, config, row).catch((error: unknown) =>
                logger.error({ err: error, app: row.appName }, `hosted pool: replacing a drifted machine failed`),
            );
            continue;
        }
        if (row.state === `building`) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            const machine = await getMachine(config.hosted.flyApiToken, row.appName, row.machineId).catch(() => undefined);
            if (machine?.state === `stopped`) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await prisma.hostedPoolMachine.update({ where: { id: row.id }, data: { state: `ready` } });
                logger.info({ app: row.appName, region: row.region }, `hosted pool: machine ready`);
                live.set(row.region, [...(live.get(row.region) ?? []), row]);
                continue;
            }
            // Unreadable, failed, or stuck past the pull's worst case — rebuild rather than wait on it.
            if (
                machine === undefined ||
                machine.state === `failed` ||
                machine.state === `destroyed` ||
                now - row.createdAt.getTime() > BUILD_TIMEOUT_MS
            ) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await destroyPoolMachine(prisma, config, row).catch((error: unknown) =>
                    logger.error({ err: error, app: row.appName }, `hosted pool: collecting a dead build failed`),
                );
                continue;
            }
        }
        live.set(row.region, [...(live.get(row.region) ?? []), row]);
    }
    // Both regions the route can pick from (region.ts) hold their own stock — a warm iad machine is useless
    // to the EEA caller the residency promise covers. One knob sizes both; dedup covers a single-region setup.
    for (const region of new Set([config.hosted.region, config.hosted.regionEu].filter((entry) => entry !== ``))) {
        const stock = live.get(region) ?? [];
        for (const surplus of stock.slice(target)) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyPoolMachine(prisma, config, surplus).catch((error: unknown) =>
                logger.error({ err: error, app: surplus.appName }, `hosted pool: shrinking failed; retried next tick`),
            );
        }
        for (let missing = stock.length; missing < target; missing += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await buildPoolMachine(prisma, config, logger, region).catch((error: unknown) =>
                logger.error({ err: error, region }, `hosted pool: build failed; retried next tick`),
            );
        }
    }
};

/* One locked, error-swallowed reconcile — the interval's tick, and also the nudge a claim fires the moment it
 * empties a slot. Without the nudge a claim's replacement waits out the rest of the five-minute tick BEFORE
 * its minutes-long build even starts, so two sign-ups in a row from one region meant the second paid the cold
 * path a warm pool exists to spare. Fire-and-forget by design: rebuilding stock is never the claimer's wait. */
export const kickHostedPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    void runExclusive(config, JOB_HOSTED_POOL, () =>
        reconcileHostedPool(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted pool reconcile failed`)),
    ).catch((error: unknown) => logger.error({ err: error }, `hosted pool lock failed`));
};

// Boot wiring (main.ts): reconcile now and every five minutes, one replica at a time. Started even when the
// pool is off — that is what makes turning it OFF drain it rather than strand it.
export const startHostedPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    kickHostedPool(prisma, config, logger);
    setInterval(() => kickHostedPool(prisma, config, logger), TICK_MS);
};
