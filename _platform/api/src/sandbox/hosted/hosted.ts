import type { PrismaClient } from "@intentic-app/prisma";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { createApp, createMachine, createVolume, deleteApp, getMachine, listAppNames, startMachine } from "./fly.js";

/* The hosted lane's orchestration — what the routes call, over the fly.ts client. One machine + one volume in
 * one app per sandbox; the app name is derived from the sandbox's 12-hex tunnel id, so the Fly console, the
 * sandbox-<id> hostname the user sees, and the reaper's prefix match all tell the same story.
 *
 * Reachability stays Cloudflare end to end: the machine env carries the tunnel's connector token and the
 * daemon's announce is the only "it's up" signal — the platform never probes or dials a machine, it only
 * flips power. That is the hosted trust trade in one line: power and existence are the platform's, the
 * command path stays browser → daemon. */

// The lane needs BOTH its own switch and the tunnel fabric: a hosted machine is reachable only through the
// grant the platform mints on the hub, so Fly credentials without a configured hub would build machines that
// boot to nothing.
export const hostedEnabled = (config: Config): boolean =>
    config.hosted.flyApiToken !== `` && config.hosted.flyOrg !== `` && config.zrok.adminToken !== `` && config.zrok.apiEndpoint !== ``;

export const hostedAppName = (config: Config, sandboxId: string, connectToken: string): string =>
    `${config.hosted.appPrefix}-${sandboxIdFromToken(connectToken) ?? sandboxId}`;

export interface HostedProvisionArgs {
    readonly sandboxId: string;
    // Decrypted by the route (the row stores them encrypted) — this module never touches crypto.
    readonly connectToken: string;
    // The sandbox's reachability grant on the self-hosted hub (zrok-provision.ts): the account token the box
    // enables with, the namespace its names live under, its derived address, and the hub as the box dials it.
    readonly grant: { accountToken: string; namespaceToken: string; hostname: string; apiEndpoint: string };
    readonly ownerEmail: string;
    // Decided by the route from the caller's country (region.ts), because only the request knows it — a
    // European user's machine and volume are both created here, which is what makes the residency promise
    // in the privacy policy true rather than aspirational.
    readonly region: string;
}

/* Create the machine: app (own network) → volume → machine, then stamp the row. The env rides the same
 * contract vocabulary every connect flow sets — composed here rather than claimed by a script, because there
 * is no script: the machine's first boot IS the sandbox, and the daemon's announce narrates it exactly like a
 * pasted run's.
 *
 * A failure after the app exists deletes the app again (best-effort) so a retry starts clean — and anything
 * this cleanup misses is an app with no HostedMachine row, which is precisely what the reaper deletes. */
export const provisionHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<{ appName: string; region: string }> => {
    const { flyApiToken, flyOrg, image, cpus, memoryMb, volumeGb, idleStopMinutes } = config.hosted;
    const { region } = args;
    const appName = hostedAppName(config, args.sandboxId, args.connectToken);
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        const machineConfig = flyMachineConfig({
            name: appName,
            image,
            baseImage: image,
            guest: { cpus, memoryMb },
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
                [`IDLE_STOP_MINUTES`, String(idleStopMinutes)],
            ],
        });
        const { machineId } = await createMachine(flyApiToken, appName, { name: appName, region, config: machineConfig });
        await prisma.hostedMachine.create({ data: { sandboxId: args.sandboxId, appName, machineId, volumeId, region } });
        return { appName, region };
    } catch (error) {
        await deleteApp(flyApiToken, appName).catch((cleanupError: unknown) =>
            logger.warn({ err: cleanupError, appName }, `hosted: cleanup after failed provision failed; orphaned for the reaper`),
        );
        throw error;
    }
};

// Power on a (probably) stopped machine. Idempotent by reading the state on refusal: Fly answers an error for
// a machine that is already started/starting, and that answer IS success here — the browser's daemon probe is
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

// Tear the whole app down (machines + volume ride with it). 404-tolerant by fly.ts's contract.
export const destroyHosted = async (config: Config, appName: string): Promise<void> => deleteApp(config.hosted.flyApiToken, appName);

/* The daily reconcile (retention.ts): every OUR-prefix app in the org whose HostedMachine row is gone gets
 * destroyed — failed-provision leftovers, delete-flow teardowns that lost their race, anything half-made. The
 * DB row is the single source of "this app should exist": rows are created only after the machine is, and
 * deleted only when the sandbox goes, so an app without one is never a machine somebody is working in. Apps
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
    const known = new Set((await prisma.hostedMachine.findMany({ select: { appName: true } })).map((row) => row.appName));
    for (const name of names.filter((candidate) => !known.has(candidate))) {
        logger.warn({ app: name }, `hosted reaper: destroying orphaned app`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on the API; a handful at most
        await deleteApp(config.hosted.flyApiToken, name).catch((error: unknown) =>
            logger.error({ err: error, app: name }, `hosted reaper: destroying orphaned app failed; retried tomorrow`),
        );
    }
};
