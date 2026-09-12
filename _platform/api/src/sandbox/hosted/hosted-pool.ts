import type { PrismaClient } from "@intentic/prisma";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { encryptSecret } from "../../crypto.js";
import { JOB_HOSTED_POOL, runExclusive } from "../../jobs-lock.js";
import { mintConnectToken } from "../mint-sandbox.js";
import { createApp, createMachine, createVolume, deleteApp, flyWarmRole, FlyError, getMachine, isFlyCapacity } from "./fly/fly.js";
import { hostedCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";
import { resolveHostedImage } from "./build/hosted-image.js";
import { hostedEnabled, hostedInstanceId } from "./hosted.js";

// The warm pool's whole lifecycle except the claim (hosted.ts, since a claim's product is a HostedMachine). A pool
// machine's one boot is the daemon's prewarm (`SANDBOX_PREWARM=1`): real image, real entrypoint, no identity, pulling
// and warming the starter's dev server before exiting and stopping. Identity lives in the row only (a connect token
// minted at build; its digest names the app), and a later claim adopts it. Reconcile: builds to target per region,
// verifies standing stock still exists on Fly (a row is a claim, not proof), rebuilds drifted images, collects crashed
// claims, drains everything when off.

// The one env var beyond the run contract's own: the daemon's prewarm switch; a clean exit stops the machine.
export const PREWARM_ENV: readonly (readonly [string, string])[] = [[`SANDBOX_PREWARM`, `1`]];

// A build stuck `building` this long (pull + prewarm boot normally take minutes) is torn down and rebuilt.
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
// A `claimed` row this old crashed between winning the row and committing the hand-off.
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

// Builds one pool machine: app, volume, then a machine whose boot is the prewarm, stamped `building`. The reconcile
// flips it `ready` once Fly reports the boot stopped; a failed build deletes the app.
const buildPoolMachine = async (prisma: PrismaClient, config: Config, logger: Logger, region: string, image: string): Promise<void> => {
    const { flyApiToken, flyOrg, cpus, memoryMb, volumeGb } = config.hosted;
    // Identity first, since the app is named after it; same derivation as a built-to-order app's.
    const token = mintConnectToken();
    const appName = `${config.hosted.appPrefix}-${sandboxIdFromToken(token) ?? ``}`;
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        // Stamped as warm from birth (so no other deployment reads it as litter) and named like an owned app; nothing
        // routes to it.
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

// Tears down row and app together, app first: a row with no app is harmless (read as gone next tick), while an app with
// no row is reaper food anyway.
const destroyPoolMachine = async (prisma: PrismaClient, config: Config, row: { id: string; appName: string }): Promise<void> => {
    await deleteApp(config.hosted.flyApiToken, row.appName);
    await prisma.hostedPoolMachine.delete({ where: { id: row.id } });
};

// What Fly says about a standing pool row: a `ready` row used to be trusted forever, so a vanished machine stayed in
// the pool as stock that doesn't exist (and, being oldest, was handed out first). Three verdicts:
// - warm: claimable now (a suspended machine starts just as fast)
// - dead: Fly says it doesn't exist, or failed/destroyed; the slot is worth more empty
// - wait: no verdict yet (mid-transition or unreachable); never spent as gone
type PoolHealth = "warm" | "dead" | "wait";

const WARM_STATES = new Set([`stopped`, `suspended`]);
const DEAD_STATES = new Set([`failed`, `destroyed`]);

const poolMachineHealth = async (config: Config, row: { appName: string; machineId: string }): Promise<PoolHealth> => {
    try {
        const { state } = await getMachine(config.hosted.flyApiToken, row.appName, row.machineId);
        return WARM_STATES.has(state) ? `warm` : DEAD_STATES.has(state) ? `dead` : `wait`;
    } catch (error) {
        // A 404 covers both halves of gone (machine or whole app); any other failure is the provider, not the machine.
        return error instanceof FlyError && error.status === 404 ? `dead` : `wait`;
    }
};

// Restocks to target per region, in whatever room is left after teardowns above freed slots. Stops at the ceiling:
// stock is an accelerator, not worth taking the last machine an arrival needs.
const refillStock = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    live: Map<string, { id: string; appName: string }[]>,
    target: number,
    // The digest the pool is being stocked against, resolved once per tick by the caller.
    image: string,
): Promise<void> => {
    let headroom = (await hostedCapacity(prisma, config)).headroom;
    // Both regions hold their own stock (residency); one knob sizes both, deduped for a single-region setup.
    for (const region of new Set([config.hosted.region, config.hosted.regionEu].filter((entry) => entry !== ``))) {
        const stock = live.get(region) ?? [];
        for (const surplus of stock.slice(target)) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyPoolMachine(prisma, config, surplus).catch((error: unknown) =>
                logger.error({ err: error, app: surplus.appName }, `hosted pool: shrinking failed; retried next tick`),
            );
        }
        for (let missing = stock.length; missing < target; missing += 1) {
            if (headroom <= 0) {
                logger.warn(
                    { region, want: target, have: stock.length },
                    `hosted pool: no room on the provider for warm stock; what is left is being kept for people`,
                );
                break;
            }
            headroom -= 1;
            // A capacity refusal ends the whole tick: the allowance is the org's, so every region meets the same wall.
            // oxlint-disable-next-line eslint/no-await-in-loop
            const atCapacity = await buildPoolMachine(prisma, config, logger, region, image).then(
                () => false,
                (error: unknown) => {
                    logger.error({ err: error, region }, `hosted pool: build failed; retried next tick`);
                    return isFlyCapacity(error);
                },
            );
            if (atCapacity) {
                noteProviderAtCapacity(region);
                headroom = 0;
            }
        }
    }
};

// One reconcile pass, sequential and per-row: the pool is small, Fly is rate-limited, and a half-succeeded tick
// converges on the next one.
export const reconcileHostedPool = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const all = await prisma.hostedPoolMachine.findMany({ orderBy: { createdAt: `asc` } });
    const now = Date.now();
    // Claimed rows come first: a fresh one is untouched; a stale one is dropped if adopted, destroyed whole if not.
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
    // Off, or the lane is: drain everything left after the claim pass, since none of the stock is ever somebody's.
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
    /* THE DIGEST THE TAG NAMES RIGHT NOW, which is what makes the drift check below a real one. It used to
     * compare `row.image` against `config.hosted.image` — a tag against the same tag, equal by construction —
     * so a re-pushed sandbox image was never detected, the pool kept machines whose rootfs no longer matched
     * it, and the cost landed on whoever signed up next: their claim rewrote the machine with the tag, Fly
     * resolved it to the new digest, and the machine had to pull before it could start. Comparing digests
     * turns that into ordinary background work: a push drains the stale stock and rebuilds it here, on a tick,
     * with nobody waiting on it. */
    const stockImage = await resolveHostedImage(config, logger);
    const live = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
        // A drifted image or a row with no identity is worth nothing claimable, for the same reason a wrong rootfs is.
        if (row.image !== stockImage || row.token === ``) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyPoolMachine(prisma, config, row).catch((error: unknown) =>
                logger.error({ err: error, app: row.appName }, `hosted pool: replacing a drifted machine failed`),
            );
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per standing row, every five minutes
        const health = await poolMachineHealth(config, row);
        // Checked before the clock: a pulled rootfs is the point, so a late finish banks it rather than paying twice.
        if (health === `warm`) {
            if (row.state === `building`) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await prisma.hostedPoolMachine.update({ where: { id: row.id }, data: { state: `ready` } });
                logger.info({ app: row.appName, region: row.region }, `hosted pool: machine ready`);
            }
            live.set(row.region, [...(live.get(row.region) ?? []), row]);
            continue;
        }
        // Only a `building` row can be stuck this way; a `ready` one waits on nothing, so its age says nothing.
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
    await refillStock(prisma, config, logger, live, target, stockImage);
};

// One locked, error-swallowed reconcile: the interval's tick, and the nudge a claim fires the moment it empties a slot,
// so its replacement doesn't wait out the rest of the tick first. Fire-and-forget.
export const kickHostedPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    void runExclusive(config, JOB_HOSTED_POOL, () =>
        reconcileHostedPool(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted pool reconcile failed`)),
    ).catch((error: unknown) => logger.error({ err: error }, `hosted pool lock failed`));
};

// Boot wiring (main.ts): reconciles now and every five minutes, one replica at a time, even with the pool off - that's
// what drains it instead of stranding it.
export const startHostedPool = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    kickHostedPool(prisma, config, logger);
    setInterval(() => kickHostedPool(prisma, config, logger), TICK_MS);
};
