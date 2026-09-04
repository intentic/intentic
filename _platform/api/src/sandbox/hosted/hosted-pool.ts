import type { PrismaClient } from "@intentic-app/prisma";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { encryptSecret } from "../../crypto.js";
import { JOB_HOSTED_POOL, runExclusive } from "../../jobs-lock.js";
import { mintConnectToken } from "../mint-sandbox.js";
import { createApp, createMachine, createVolume, deleteApp, flyWarmRole, FlyError, getMachine } from "./fly.js";
import { hostedEnabled, hostedInstanceId } from "./hosted.js";

/* THE WARM POOL'S LIFECYCLE, everything except the claim, which lives beside provisionHosted (hosted.ts)
 * because a claim's product is a HostedMachine.
 *
 * The minutes of a hosted first boot used to be read as one thing, pulling the sandbox image onto the Fly
 * host, and the pool paid that pull ahead of demand with a no-op first boot. Measured against a real sign-up
 * the pull was only the first of the minutes: the daemon's own first boot then copied the starter site and
 * its dependencies onto an empty volume, initialised its repo, took the baselines and started the dev server,
 * on a shared CPU whose burst allowance is spent five seconds in. None of that names an owner. So a pool
 * machine's one boot is the daemon's PREWARM (`SANDBOX_PREWARM=1`, the daemon's platform/prewarm.ts): the
 * real image and the real entrypoint, running the ordinary boot chain onto the volume, warming the starter's
 * dev server once, then exiting 0, which stops the machine. Nothing identity-bearing runs, because the env
 * names no owner, no token and no platform URL. What waits in the pool is a stopped machine whose volume
 * already holds everything a first boot would have built, costing its volume and nothing else; the claim
 * replaces its whole config (identity in, prewarm flag out) and the owner's first boot finds every step done.
 *
 * IT DOES HAVE AN IDENTITY, held in its row and nowhere near the machine: a connect token minted at build,
 * whose 12-hex digest names the app (`<prefix>-<id>`, exactly what a built-to-order machine is called). The
 * edge reaches a hosted sandbox by replaying to the app named after the id in its hostname, with no lookup,
 * and Fly never renames an app — so the name has to be right at build, before anybody has asked for the
 * machine, and the sandbox that is eventually claimed onto it adopts this identity rather than the reverse
 * (hosted.ts claimPoolMachine). The machine's env stays empty until claim: a warm machine holds no secret.
 *
 * The reconcile below is the pool's whole management: build up to the target per region, notice builds that
 * finished (or died), CHECK THE STANDING STOCK IS STILL THERE (a row is a claim about a machine on Fly, not
 * proof of one), rebuild machines whose image drifted from config, collect claims that crashed, and drain
 * everything when the pool is switched off. It runs on the shared advisory lock so replicas never
 * double-build, and every action is one row's, a failure logs and moves on, the next tick retries. */

// The one env var a pool machine's boot carries beyond the run contract's own: the daemon's prewarm switch. A
// clean exit stops the machine (the same restart policy that lets the daemon's idle exit stop a real one).
export const PREWARM_ENV: readonly (readonly [string, string])[] = [[`SANDBOX_PREWARM`, `1`]];

// A build observed `building` for this long is stuck (an image pull plus the prewarm boot finish in minutes),
// torn down and rebuilt.
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
// A `claimed` row this old is a claim that crashed between winning the row and committing the hand-off.
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

// Build one pool machine: app → volume → machine whose boot is the prewarm. The row is stamped `building`; the
// reconcile flips it `ready` once Fly reports the prewarm boot stopped. Cleanup mirrors provisionHosted's: a
// failure deletes the app, and anything that slips through is an app with no row, reaper food.
const buildPoolMachine = async (prisma: PrismaClient, config: Config, logger: Logger, region: string): Promise<void> => {
    const { flyApiToken, flyOrg, image, cpus, memoryMb, volumeGb } = config.hosted;
    // The identity first, because the app is named after it (see the header). The same derivation as a
    // built-to-order app's, so the two are indistinguishable by name, which is the point.
    const token = mintConnectToken();
    const appName = `${config.hosted.appPrefix}-${sandboxIdFromToken(token) ?? ``}`;
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        /* The prewarm boot is what makes it warm; the metadata is what makes it READABLE as warm, this app is
         * named like an owner's whether or not anybody owns it yet, and Fly will never let that name change.
         * The platform stamp rides in the same bag from the machine's first second, which is what keeps a
         * second deployment sharing this org from reading our stock as litter (hosted.ts's reaper). No front
         * door: nothing routes to a machine nobody owns, and the prewarm needs nobody to reach it. */
        const warm = {
            ...flyMachineConfig({ name: appName, image, baseImage: image, guest: { cpus, memoryMb }, volumeId, env: PREWARM_ENV }),
            metadata: flyWarmRole(hostedInstanceId(config)),
        };
        const { machineId } = await createMachine(flyApiToken, appName, { name: appName, region, config: warm });
        await prisma.hostedPoolMachine.create({
            data: { appName, machineId, volumeId, region, image, state: `building`, token: encryptSecret(config, token) },
        });
        logger.info({ app: appName, region }, `hosted pool: building a warm machine`);
    } catch (error) {
        await deleteApp(flyApiToken, appName).catch((cleanupError: unknown) =>
            logger.warn({ err: cleanupError, app: appName }, `hosted pool: cleanup after failed build failed; orphaned for the reaper`),
        );
        throw error;
    }
};

// Tear one pool machine down, row and app together. App first: a row without an app is harmless (the health
// check below reads it as gone next tick), while an app without a row is a day away from the reaper anyway.
const destroyPoolMachine = async (prisma: PrismaClient, config: Config, row: { id: string; appName: string }): Promise<void> => {
    await deleteApp(config.hosted.flyApiToken, row.appName);
    await prisma.hostedPoolMachine.delete({ where: { id: row.id } });
};

/* WHAT FLY SAYS ABOUT A STANDING POOL ROW, in the three answers the reconcile can act on. Every row is asked
 * about, not just the ones still building: a `ready` row used to be trusted for the rest of its life, so a
 * machine that vanished under one (a lost host, a hand-deleted machine, an app torn down while its row
 * survived a DB blip) stayed in the pool as stock that does not exist. That row filled a slot, so the
 * reconcile built no replacement for it, AND claims take the oldest row first, so the dead one was handed out
 * FIRST: one vanished machine quietly cost the next arrival the exact cold build the pool exists to spare.
 *
 *   • `warm`  the machine is there and claimable: its prewarm boot leaves it stopped, and Fly may suspend a
 *             long-idle one later, which starts again just as fast on the same warm rootfs
 *   • `dead`  Fly says there is no such machine (or reports it failed/destroyed): the row is stock that
 *             isn't, and the slot is worth more empty than occupied
 *   • `wait`  no verdict: mid-transition, or Fly could not be asked at all. The row is kept and re-read next
 *             tick, because "we could not ask" must never be spent as "it is gone", the reading that turns a
 *             bad minute at the provider into a drained pool. */
type PoolHealth = "warm" | "dead" | "wait";

const WARM_STATES = new Set([`stopped`, `suspended`]);
const DEAD_STATES = new Set([`failed`, `destroyed`]);

const poolMachineHealth = async (config: Config, row: { appName: string; machineId: string }): Promise<PoolHealth> => {
    try {
        const { state } = await getMachine(config.hosted.flyApiToken, row.appName, row.machineId);
        return WARM_STATES.has(state) ? `warm` : DEAD_STATES.has(state) ? `dead` : `wait`;
    } catch (error) {
        // A 404 covers both halves of "gone": the machine deleted under its app, and the whole app deleted
        // under its row. Every other failure is the provider, not the machine.
        return error instanceof FlyError && error.status === 404 ? `dead` : `wait`;
    }
};

/* One reconcile pass. Deliberately sequential and per-row-guarded: the pool is small (a handful of machines),
 * the Fly API is rate-limited, and a tick that half-succeeds converges on the next one. */
export const reconcileHostedPool = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const all = await prisma.hostedPoolMachine.findMany({ orderBy: { createdAt: `asc` } });
    const now = Date.now();
    /* CLAIMED ROWS FIRST, whatever the target, a claim is the one state whose app may already be somebody's,
     * so neither the drain below nor the stock-taking may treat it as the pool's to destroy. Fresh: a
     * hand-off in flight, untouchable. Stale: the claim crashed between winning the row and committing, if a
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
    //, nothing in the standing stock is ever somebody's.
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
        // The image moved under a finished machine: its warm rootfs is the WRONG rootfs, worth nothing. And
        // stock with no identity (built before the app was named after one) is unclaimable for the same
        // reason a wrong rootfs is: nothing about it is what a sandbox would be handed.
        if (row.image !== config.hosted.image || row.token === ``) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyPoolMachine(prisma, config, row).catch((error: unknown) =>
                logger.error({ err: error, app: row.appName }, `hosted pool: replacing a drifted machine failed`),
            );
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per standing row, every five minutes
        const health = await poolMachineHealth(config, row);
        // Warm first, and before any clock: a machine holding a pulled rootfs is the thing this pool is FOR,
        // so a build that finished while nobody was reconciling is banked, never billed twice for being late.
        if (health === `warm`) {
            if (row.state === `building`) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await prisma.hostedPoolMachine.update({ where: { id: row.id }, data: { state: `ready` } });
                logger.info({ app: row.appName, region: row.region }, `hosted pool: machine ready`);
            }
            live.set(row.region, [...(live.get(row.region) ?? []), row]);
            continue;
        }
        // A build that has still not settled past the pull's worst case is not pulling any more. Only a build
        // can be stuck this way: a `ready` row is waiting on nothing, so time alone says nothing about it.
        const stuck = row.state === `building` && now - row.createdAt.getTime() > BUILD_TIMEOUT_MS;
        if (health === `dead` || stuck) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyPoolMachine(prisma, config, row).catch((error: unknown) =>
                logger.error({ err: error, app: row.appName, state: row.state }, `hosted pool: replacing a machine that is gone failed`),
            );
            continue;
        }
        live.set(row.region, [...(live.get(row.region) ?? []), row]);
    }
    // Both regions the route can pick from (region.ts) hold their own stock, a warm iad machine is useless
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

/* One locked, error-swallowed reconcile, the interval's tick, and also the nudge a claim fires the moment it
 * empties a slot. Without the nudge a claim's replacement waits out the rest of the five-minute tick BEFORE
 * its minutes-long build even starts, so two sign-ups in a row from one region meant the second paid the cold
 * path a warm pool exists to spare. Fire-and-forget by design: rebuilding stock is never the claimer's wait. */
export const kickHostedPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    void runExclusive(config, JOB_HOSTED_POOL, () =>
        reconcileHostedPool(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted pool reconcile failed`)),
    ).catch((error: unknown) => logger.error({ err: error }, `hosted pool lock failed`));
};

// Boot wiring (main.ts): reconcile now and every five minutes, one replica at a time. Started even when the
// pool is off, that is what makes turning it OFF drain it rather than strand it.
export const startHostedPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    kickHostedPool(prisma, config, logger);
    setInterval(() => kickHostedPool(prisma, config, logger), TICK_MS);
};
