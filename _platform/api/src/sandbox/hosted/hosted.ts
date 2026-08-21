import type { PrismaClient } from "@intentic-app/prisma";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { createApp, createMachine, createVolume, deleteApp, flySandboxRole, getMachine, listAppNames, startMachine, updateMachine } from "./fly.js";

/* The hosted lane's orchestration, what the routes call, over the fly.ts client. One machine + one volume in
 * one app per sandbox; the app name is derived from the sandbox's 12-hex tunnel id, so the Fly console, the
 * sandbox-<id> hostname the user sees, and the reaper's prefix match all tell the same story.
 *
 * Reachability stays Cloudflare end to end: the machine env carries the tunnel's connector token and the
 * daemon's announce is the only "it's up" signal, the platform never probes or dials a machine, it only
 * flips power. That is the hosted trust trade in one line: power and existence are the platform's, the
 * command path stays browser → daemon. */

// The lane needs BOTH its own switch and the tunnel fabric: a hosted machine is reachable only through the
// grant the platform mints on the hub, so Fly credentials without a configured hub would build machines that
// boot to nothing.
export const hostedEnabled = (config: Config): boolean =>
    config.hosted.flyApiToken !== `` && config.hosted.flyOrg !== `` && config.zrok.adminToken !== `` && config.zrok.apiEndpoint !== ``;

const hostedAppName = (config: Config, sandboxId: string, connectToken: string): string =>
    `${config.hosted.appPrefix}-${sandboxIdFromToken(connectToken) ?? sandboxId}`;

export interface HostedProvisionArgs {
    readonly sandboxId: string;
    // Decrypted by the route (the row stores them encrypted), this module never touches crypto.
    readonly connectToken: string;
    // The sandbox's reachability grant on the self-hosted hub (zrok-provision.ts): the account token the box
    // enables with, the namespace its names live under, its derived address, and the hub as the box dials it.
    readonly grant: { accountToken: string; namespaceToken: string; hostname: string; apiEndpoint: string };
    readonly ownerEmail: string;
    // Decided by the route from the caller's country (region.ts), because only the request knows it, a
    // European user's machine and volume are both created here, which is what makes the residency promise
    // in the privacy policy true rather than aspirational.
    readonly region: string;
}

/* THE machine config a sandbox runs under, wherever the machine came from. Cold provision creates a machine
 * with it; the warm pool's claim REPLACES a pool machine's config with it, which is both how the sandbox's
 * identity gets in and how the pool's no-op boot override gets erased (updates replace the whole config).
 * One composer, so the two origins cannot drift: a machine claimed from the pool is byte-for-byte the machine
 * that would have been built to order. OWNER_EMAIL is in the env before the daemon ever runs, so the
 * first-bind trust story (only this Google identity may claim ownership) is origin-independent too.
 *
 * The metadata stamp rides on that same "one composer" property: whatever the machine was a second ago, a
 * machine holding this config is somebody's sandbox and says so to Fly, which is the only way to read a
 * pool-born app's true state, since its name will say `pool` forever (fly.ts). The sandbox ID and not the
 * owner's address: metadata is casually visible provider-side, and the ID joins to the platform's own rows. */
const hostedMachineConfig = (config: Config, args: HostedProvisionArgs, machineName: string, volumeId: string) => ({
    ...flyMachineConfig({
        name: machineName,
        image: config.hosted.image,
        baseImage: config.hosted.image,
        guest: { cpus: config.hosted.cpus, memoryMb: config.hosted.memoryMb },
        volumeId,
        env: [
            [`GOOGLE_CLIENT_ID`, config.google.clientId],
            [`CONNECT_TOKEN`, args.connectToken],
            [`OWNER_EMAIL`, args.ownerEmail],
            [`WEB_ORIGIN`, config.webOrigin],
            [`SANDBOX_PUBLIC_URL`, `https://${args.grant.hostname}`],
            [`PLATFORM_URL`, config.api.url],
            [`ZROK_TOKEN`, args.grant.accountToken],
            [`ZROK_API`, args.grant.apiEndpoint],
            [`ZROK_NAMESPACE`, args.grant.namespaceToken],
            [`IDLE_STOP_MINUTES`, String(config.hosted.idleStopMinutes)],
        ],
    }),
    metadata: flySandboxRole(args.sandboxId),
});

/* Claim a warm machine for this sandbox, or answer undefined and let the cold path build one. The pool row
 * is won by a guarded update (`ready` → `claimed`), so two simultaneous claims can never brand the same
 * machine; the winner writes the sandbox's real config into it (identity in, no-op boot override out, one
 * `hostedMachineConfig`, so pool-born and built-to-order machines cannot drift), starts it, and commits the
 * hand-off in one transaction: the HostedMachine row appears and the pool row disappears together, so no
 * crash leaves a machine that is both claimable and somebody's.
 *
 * Region is a hard filter, not a preference: an EEA caller may only ever claim an EEA machine, or the privacy
 * policy's residency promise breaks. `wokeAt` opens the hour meter here, at claim, the pool's own no-op boot
 * was the platform's cost, not this user's.
 *
 * Every failure is caught and answered by trying the NEXT candidate, and only a pool with nothing left in it
 * is answered as a miss: the pool is an accelerator, and a reader who pressed the button is owed a machine,
 * not an explanation of why the fast path stumbled. Giving up on the whole pool at the first stumble is what
 * made one machine Fly had destroyed under its row cost a reader the full cold build while a perfectly warm
 * second machine sat unclaimed beside it, in their own region, for the entire wait. The candidate list is
 * this region's stock (a handful), so the worst case is a handful of cheap refusals before the cold path.
 *
 * A row won and then stranded (update or start failed) stays `claimed` with its app intact for the reconcile
 * job to collect, it must not go back to `ready`, because a half-branded machine already carries this
 * sandbox's tokens. */
const claimPoolMachine = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<{ appName: string; region: string } | undefined> => {
    const candidates = await prisma.hostedPoolMachine.findMany({
        where: { region: args.region, state: `ready`, image: config.hosted.image },
        orderBy: { createdAt: `asc` },
    });
    for (const row of candidates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each iteration races other claimers for one row; parallelism is the bug
        const won = await prisma.hostedPoolMachine.updateMany({ where: { id: row.id, state: `ready` }, data: { state: `claimed` } });
        if (won.count === 0) {
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await updateMachine(config.hosted.flyApiToken, row.appName, row.machineId, hostedMachineConfig(config, args, row.appName, row.volumeId));
            // oxlint-disable-next-line eslint/no-await-in-loop
            await startMachine(config.hosted.flyApiToken, row.appName, row.machineId);
            // oxlint-disable-next-line eslint/no-await-in-loop
            await prisma.$transaction([
                prisma.hostedMachine.create({
                    data: {
                        sandboxId: args.sandboxId,
                        appName: row.appName,
                        machineId: row.machineId,
                        volumeId: row.volumeId,
                        region: row.region,
                        wokeAt: new Date(),
                    },
                }),
                prisma.hostedPoolMachine.delete({ where: { id: row.id } }),
            ]);
            return { appName: row.appName, region: row.region };
        } catch (error) {
            logger.warn({ err: error, app: row.appName }, `hosted pool: claim failed; trying the next warm machine`);
        }
    }
    return undefined;
};

/* Create the machine, from the warm pool when one is waiting (seconds: the image is already on its host),
 * built to order otherwise (minutes: app → volume → machine, image pulled on first boot). Either way the row
 * is stamped last and the env is the same contract vocabulary every connect flow sets, composed here rather
 * than claimed by a script, because there is no script: the machine's first boot IS the sandbox, and the
 * daemon's announce narrates it exactly like a pasted run's.
 *
 * A cold-path failure after the app exists deletes the app again (best-effort) so a retry starts clean, and
 * anything this cleanup misses is an app with no HostedMachine row, which is precisely what the reaper
 * deletes. A pool claim that fails falls through to the cold path: the reader asked for a machine, not for a
 * pool hit. */
export const provisionHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<{ appName: string; region: string }> => {
    const { flyApiToken, flyOrg, volumeGb } = config.hosted;
    const { region } = args;
    const claimed = await claimPoolMachine(prisma, config, logger, args);
    if (claimed !== undefined) {
        return claimed;
    }
    const appName = hostedAppName(config, args.sandboxId, args.connectToken);
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        const { machineId } = await createMachine(flyApiToken, appName, {
            name: appName,
            region,
            config: hostedMachineConfig(config, args, appName, volumeId),
        });
        // `wokeAt` opens the hour meter's first stretch: a machine is RUNNING from the moment it is created,
        // so the free lane's clock starts here rather than at the first wake, which is the only version that
        // does not hand out an uncounted first session to everyone who ever provisions one.
        await prisma.hostedMachine.create({ data: { sandboxId: args.sandboxId, appName, machineId, volumeId, region, wokeAt: new Date() } });
        return { appName, region };
    } catch (error) {
        await deleteApp(flyApiToken, appName).catch((cleanupError: unknown) =>
            logger.warn({ err: cleanupError, appName }, `hosted: cleanup after failed provision failed; orphaned for the reaper`),
        );
        throw error;
    }
};

// Power on a (probably) stopped machine. Idempotent by reading the state on refusal: Fly answers an error for
// a machine that is already started/starting, and that answer IS success here, the browser's daemon probe is
// what decides when the sandbox is actually back.
const LIVE_STATES = new Set([`created`, `starting`, `started`, `replacing`]);
export const wakeHosted = async (config: Config, hosted: { appName: string; machineId: string }): Promise<void> => {
    try {
        await startMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId);
    } catch (error) {
        const machine = await getMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch(() => undefined);
        if (machine !== undefined && LIVE_STATES.has(machine.state)) {
            return;
        }
        throw error;
    }
};

/* An explicit "start it over" is also the hosted lane's repair/update boundary. A plain stop/start keeps the
 * rootfs Fly resolved when the Machine was first created, so a corrected image behind the configured tag can
 * never repair a boot-crashing machine: every click simply runs the same broken bytes again. Replace the full
 * config while the machine is stopped, preserving its volume id and identity, then take the ordinary wake
 * path. `updateMachine` uses skip_launch, so the start remains one explicit, metered transition. */
export const refreshHosted = async (
    config: Config,
    args: HostedProvisionArgs,
    hosted: { appName: string; machineId: string; volumeId: string },
): Promise<void> => {
    await updateMachine(
        config.hosted.flyApiToken,
        hosted.appName,
        hosted.machineId,
        hostedMachineConfig(config, args, hosted.appName, hosted.volumeId),
    );
    await wakeHosted(config, hosted);
};

// Tear the whole app down (machines + volume ride with it). 404-tolerant by fly.ts's contract.
export const destroyHosted = async (config: Config, appName: string): Promise<void> => deleteApp(config.hosted.flyApiToken, appName);

/* The daily reconcile (retention.ts): every OUR-prefix app in the org whose row. HostedMachine for a
 * sandbox's machine, HostedPoolMachine for a warm one still waiting, is gone gets destroyed:
 * failed-provision leftovers, delete-flow teardowns that lost their race, anything half-made. The DB row is
 * the single source of "this app should exist": rows are created only after the machine is, and deleted only
 * when the machine's story ends, so an app without one is never a machine somebody is working in. Apps
 * outside the prefix are not ours and are never touched. */
export const reapHostedOrphans = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    if (!hostedEnabled(config)) {
        return;
    }
    const prefix = `${config.hosted.appPrefix}-`;
    const names = (await listAppNames(config.hosted.flyApiToken, config.hosted.flyOrg)).filter((name) => name.startsWith(prefix));
    if (names.length === 0) {
        return;
    }
    const [machines, pooled] = await Promise.all([
        prisma.hostedMachine.findMany({ select: { appName: true } }),
        prisma.hostedPoolMachine.findMany({ select: { appName: true } }),
    ]);
    const known = new Set([...machines, ...pooled].map((row) => row.appName));
    for (const name of names.filter((candidate) => !known.has(candidate))) {
        logger.warn({ app: name }, `hosted reaper: destroying orphaned app`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on the API; a handful at most
        await deleteApp(config.hosted.flyApiToken, name).catch((error: unknown) =>
            logger.error({ err: error, app: name }, `hosted reaper: destroying orphaned app failed; retried tomorrow`),
        );
    }
};
