import { createHash } from "node:crypto";
import { FREE_TIER, type HostedShape, type HostedTierId } from "@intentic/constants";
import { projectRemoteDir } from "@intentic/sandbox-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import { ENV_INGRESS_URL, ENV_SANDBOX_GRANT, verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { ENV_PLATFORM_PUBLIC_KEY, publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { decryptSecret } from "../../crypto.js";
import { connectTokenIdentity } from "../mint-sandbox.js";
import { definitionSeedFor, ENV_DEFINITION_SEED } from "../profiles/profiles.js";
import { grantFor, ingressEnabled, sandboxHostname } from "../reachability.js";
import {
    appExists,
    createApp,
    createMachine,
    createVolume,
    deleteApp,
    destroyMachine,
    FLY_META_PLATFORM,
    FLY_META_ROLE,
    FlyError,
    type FlyVolumeSummary,
    flySandboxRole,
    getMachine,
    getMachineConfig,
    getMachineLaunch,
    isFlyCapacity,
    isFlyGone,
    listAppNames,
    listMachines,
    listVolumes,
    startMachine,
    updateMachine,
    LIVE_STATES,
} from "./fly/fly.js";
import { withHostedAppLock } from "./hosted-app-lock.js";
import { AT_CAPACITY_MESSAGE, HostedAtCapacity, hostedCapacity, noteProviderAtCapacity, providerWords } from "./hosted-capacity.js";
import { digestIn, resolveHostedImage } from "./build/hosted-image.js";
import { hostedSlotUse } from "./plan/hosted-plan.js";
import { assertHostedIdentity, HostedAlreadyProvisioned, HostedProvisionCancelled, lockHostedSandbox, withHostedApp } from "./hosted-cleanup.js";
import { ENV_PROJECT_DIR, hostedProjectOf, projectOfEnv } from "./hosted-project.js";
import { hostedShapeFor, shapeOfRow, volumeOptions } from "./hosted-shape.js";
import { dropHostedMachine } from "./hosted-usage.js";
import { startAfterUpdate } from "./gate/start-after-update.js";
import {
    type HostedComposer,
    type HostedGateRecord,
    HostedImageKept,
    HostedMachineBusy,
    ROLLBACK_WORDS,
    runningImageOf,
    STATE_PROBE_ENV,
    startOnTrial,
    STOCK_FACTS,
    switchHostedImage,
} from "./gate/state-gate.js";

// Where every caller has always found it; it lives beside the gate that starts machines too.
export { startAfterUpdate } from "./gate/start-after-update.js";

// Hosted lane orchestration over fly.ts: one machine and one volume in one app per sandbox, named `<prefix>-<12-hex
// tunnel id>` always. The machine dials the edge's tunnel like every sandbox and is reached only down it; until it has,
// the edge answers `sandbox-<id>` with the `no-tunnel` verdict, which the editor wakes it on. The daemon's announce is
// the only up signal; the platform only flips power and writes config, never dials the machine.

// Both the Fly credential and the edge are required: hosted machines are reached only through the edge, down the tunnel
// they dial under its wildcard.
export const hostedEnabled = (config: Config): boolean => config.hosted.flyApiToken !== `` && config.hosted.flyOrg !== `` && ingressEnabled(config);

// Deployment identity: API URL plus the database's host and path, never the credential (plaintext at the provider) — a
// copied env file pointed at a different database is a different deployment. `HOSTED_INSTANCE_ID` overrides this
// derivation.
const instanceFingerprint = (config: Config): string => {
    const raw = config.database?.url ?? ``;
    try {
        const dsn = new URL(raw);
        return `${config.api.url}|${dsn.host}${dsn.pathname}`;
    } catch {
        // Unparsable DSN (empty config in tests): fall back so a bad URL doesn't take the whole lane down.
        return `${config.api.url}|`;
    }
};

export const hostedInstanceId = (config: Config): string => {
    // `?? ''` guards against undefined comparing unequal to every stored stamp (reads as "none of these are mine").
    const override = config.hosted.instanceId ?? ``;
    return override === `` ? createHash(`sha256`).update(instanceFingerprint(config)).digest(`hex`).slice(0, 12) : override;
};

const hostedAppName = (config: Config, sandboxId: string, connectToken: string): string =>
    `${config.hosted.appPrefix}-${sandboxIdFromToken(connectToken) ?? sandboxId}`;

/* THE OWNER HAS NO SLOT LEFT, thrown where the row would have been written. Its own class for the route's sake. */
export class HostedSlotsExhausted extends Error {}

// The one sentence both refusals say, the route's early one and the write's binding one, so they cannot drift.
export const slotsMessage = (used: number): string =>
    `you already have ${used === 1 ? `a hosted sandbox` : `${used} hosted sandboxes`}; remove one first, or add a slot to your plan`;

/* WRITE THE MACHINE ROW UNDER THE OWNER'S SLOT COUNT, atomically. */
export const withHostedSlot = async <T>(
    prisma: PrismaClient,
    config: Config,
    args: HostedProvisionArgs,
    appName: string,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
    prisma.$transaction(async (tx) => {
        const { sandboxId } = args;
        await lockHostedSandbox(tx, sandboxId);
        await assertHostedIdentity(tx, sandboxId, args.connectToken);
        const { ownerId } = await tx.sandbox.findUniqueOrThrow({ where: { id: sandboxId }, select: { ownerId: true } });
        // Two int4 keys, the first naming the purpose, so nothing else on this database can share the owner's lock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hosted-slot'), hashtext(${ownerId}))`;
        // Counted at this machine's own rung: holding a Standard slot must not stop the free machine everybody is promised.
        const { used, left } = await hostedSlotUse(tx, config, ownerId, args.tier);
        if (left <= 0) {
            throw new HostedSlotsExhausted(slotsMessage(used));
        }
        const result = await write(tx);
        await tx.hostedCleanup.deleteMany({ where: { appName } });
        return result;
    });

/* Did this sandbox get its machine from somewhere else while this call was building one?. */
const alreadyProvisioned = async (prisma: PrismaClient, sandboxId: string, error: unknown): Promise<boolean> =>
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === `P2002` &&
    (await prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { id: true } })) !== null;

export interface HostedProvisionArgs {
    readonly sandboxId: string;
    // Sandbox row's decrypted connect token; a pool claim replaces it with the pool machine's own.
    readonly connectToken: string;
    readonly ownerEmail: string;
    // Caller's country, decided by the route (region.ts); both machine and volume are created here for residency.
    readonly region: string;
    // Which rung of the ladder this machine is on, which is what decides its shape (hosted-shape.ts).
    readonly tier: HostedTierId;
    // Which profile the browser arrived in, if any; decides the definition this machine seeds itself from on first boot.
    readonly profile?: string | undefined;
    // The folder a project sandbox is made for (`/work/<project>`, a name the api contract validated); absent for any
    // other sandbox. A config replacing a machine's reads it off the config it replaces (hosted-project.ts).
    readonly project?: string | undefined;
}

// Single composer for both cold-provision and pool-claim configs, so the two origins cannot drift. A hosted machine
// dials the edge's tunnel like every sandbox and declares no Fly service: the edge terminates TLS itself, so no Fly
// proxy could route to one. A machine configured while it still declared its front door keeps it until its next config
// apply (a claim, a restart, an overlay, a wake's heal), which removes it; until then it is inert, since the app has no
// public address and nothing replays to it. Overlay is the only thing that varies; `null` on both means the stock image.
export interface HostedOverlay {
    readonly image: string | null;
    readonly environmentHash: string | null;
}
export const STOCK_OVERLAY: HostedOverlay = { image: null, environmentHash: null };

export const hostedMachineConfig = (
    config: Config,
    args: HostedProvisionArgs,
    machineName: string,
    volumeId: string,
    overlay: HostedOverlay = STOCK_OVERLAY,
    /* A caller may override the configured stock image. */
    stockImage: string = config.hosted.image,
    /* The guest this config runs as; the rung's by default, and the machine's own when one is being replaced or moved. */
    guest: HostedShape = hostedShapeFor(config, args.tier),
) => {
    const hostname = sandboxHostname(config.ingress.zone, args.connectToken);
    const seed = definitionSeedFor(args.profile);
    return {
        ...flyMachineConfig({
            name: machineName,
            image: overlay.image ?? stockImage,
            baseImage: config.hosted.image,
            ...(overlay.image !== null && overlay.environmentHash !== null ? { environmentHash: overlay.environmentHash } : {}),
            guest: { cpuKind: guest.cpuKind, cpus: guest.cpus, memoryMb: guest.memoryMb },
            volumeId,
            env: [
                [`GOOGLE_CLIENT_ID`, config.google.clientId],
                [`CONNECT_TOKEN`, args.connectToken],
                [`OWNER_EMAIL`, args.ownerEmail],
                [`WEB_ORIGIN`, config.webOrigin],
                [`SANDBOX_PUBLIC_URL`, `https://${hostname}`],
                [ENV_INGRESS_URL, config.ingress.url],
                [ENV_SANDBOX_GRANT, grantFor(config, args.connectToken)],
                [`PLATFORM_URL`, config.api.url],
                // Public signing key: lets this machine's daemon accept the platform's owner ticket without a second
                // sign-in.
                [ENV_PLATFORM_PUBLIC_KEY, publicKeyPemOf(config.ingress.signingKey)],
                [`IDLE_STOP_MINUTES`, String(config.hosted.idleStopMinutes)],
                // Re-applied on every claim, overlay and restart, like the rest of this config; the daemon applies it
                // only to a workspace that arrived empty, so re-applying it cannot run over work.
                ...(seed === undefined ? [] : [[ENV_DEFINITION_SEED, seed] as const]),
                // The folder a project sandbox is made for, exactly as `ic` names it to a project container (connect.rs).
                ...(args.project === undefined ? [] : [[ENV_PROJECT_DIR, projectRemoteDir(args.project)] as const]),
            ],
        }),
        // The owner rides along: this config is replaced on every claim, overlay and restart, so the stamp stays
        // true to whoever the machine currently belongs to rather than to whoever first got it.
        metadata: flySandboxRole(args.sandboxId, hostedInstanceId(config), args.ownerEmail),
    };
};

// What a provision answers: the app, its region, and whether the machine came warm (seconds) or cold (minutes).
export interface HostedProvisioned {
    readonly appName: string;
    readonly region: string;
    readonly warm: boolean;
}

// Whether a machine's environment carries the tunnel this platform would give it now: the edge's address, and a grant
// the edge accepts for this sandbox (signed by today's key, naming the id its hostname carries).
export const tunnelEnvCurrent = (config: Config, connectToken: string, env: Readonly<Record<string, string>>): boolean => {
    const grant = env[ENV_SANDBOX_GRANT];
    return (
        env[ENV_INGRESS_URL] === config.ingress.url &&
        grant !== undefined &&
        verifyReachabilityGrant(publicKeyPemOf(config.ingress.signingKey), grant)?.sandboxId === sandboxIdFromToken(connectToken)
    );
};

// A wake's machine, as its row holds it: enough to re-compose its config without changing what it runs on.
export interface HostedWakeTarget {
    readonly cpuKind: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly volumeGb: number;
    readonly appName: string;
    readonly machineId: string;
    readonly volumeId: string;
    readonly image?: string | null;
    readonly environmentHash?: string | null;
    // An image applied without its daemon seen to come up (gate/gate-row.ts), which this start has to judge.
    readonly unprovenImage?: string | null;
    // The platform digest the owner rolled back from, which a heal does not move the machine onto.
    readonly skippedDigest?: string | null;
}

// States a config replacement is safe from; anything mid-transition is left to the plain start and its own verdict.
const HEALABLE_STATES = new Set([`stopped`, `suspended`, `started`]);

/* HOW A MACHINE'S CONFIG READS AROUND ANY IMAGE IT MAY GO BACK TO, composed the way its change composes the target: an
 * overlay with the recipe it carried, or the stock image. The state gate needs it to put back a version Fly no longer
 * holds a config for (gate/state-gate.ts). */
export const composerFor =
    (config: Config, args: HostedProvisionArgs, hosted: { appName: string; volumeId: string }, guest?: HostedShape): HostedComposer =>
    (image, environmentHash) =>
        hostedMachineConfig(
            config,
            args,
            hosted.appName,
            hosted.volumeId,
            environmentHash === null ? STOCK_OVERLAY : { image, environmentHash },
            image,
            guest,
        );

/* THE STOCK IMAGE A RESTART OR A WAKE'S HEAL MOVES A MACHINE ONTO: today's digest, unless the owner rolled back from it
 * and `:stable` still resolves to it; then the digest the machine runs, since a restart must not silently undo a
 * rollback. Once `:stable` names anything else, that is where the machine goes. */
const stockTargetOf = async (
    config: Config,
    hosted: { appName: string; machineId: string; skippedDigest?: string | null },
    logger?: Logger,
): Promise<string> => {
    const today = await resolveHostedImage(config, logger);
    const skipped = hosted.skippedDigest ?? null;
    if (skipped === null || digestIn(today) !== skipped) {
        return today;
    }
    logger?.info(
        { app: hosted.appName, skipped },
        `hosted: the owner went back from today's stock image; the machine keeps the version it runs until :stable moves`,
    );
    return runningImageOf(config, hosted);
};

// The wake's config replacement, under the state gate. A machine kept on its version and running there is a woken
// machine, which is what was asked for; anything else is the wake's failure. It does not wait for another change to
// this machine (a restart mid-probe): HostedMachineBusy, and the browser's next wake finds it done.
const healHosted = async (
    config: Config,
    hosted: HostedWakeTarget,
    args: HostedProvisionArgs,
    logger: Logger | undefined,
    record: HostedGateRecord | undefined,
): Promise<void> => {
    const overlay: HostedOverlay = { image: hosted.image ?? null, environmentHash: hosted.environmentHash ?? null };
    const guest = shapeOfRow(hosted);
    const stockImage = overlay.image === null ? await stockTargetOf(config, hosted, logger) : config.hosted.image;
    const target = hostedMachineConfig(config, args, hosted.appName, hosted.volumeId, overlay, stockImage, guest);
    try {
        await switchHostedImage(config, hosted, target, {
            start: true,
            keepImage: true,
            busy: `refuse`,
            record,
            compose: composerFor(config, args, hosted, guest),
            facts: overlay.image === null ? STOCK_FACTS : undefined,
            logger,
        });
    } catch (error) {
        if (!(error instanceof HostedImageKept && error.running)) {
            throw error;
        }
    }
};

/* THE WAKE'S START OF AN IMAGE ON TRIAL, judged; a version put back and running there is a woken machine, as a heal's.
 * When the image was a rebuild's, its build row says why it was not kept, in the words an apply that failed at once
 * records (build/hosted-build.ts), since that is where the owner's Environment card reads what became of a build. */
const startTrialHosted = async (
    config: Config,
    hosted: HostedWakeTarget,
    args: HostedProvisionArgs,
    logger: Logger | undefined,
    record: HostedGateRecord,
): Promise<void> => {
    try {
        await startOnTrial(config, hosted, { record, compose: composerFor(config, args, hosted, shapeOfRow(hosted)), logger });
    } catch (error) {
        if (!(error instanceof HostedImageKept && error.running)) {
            throw error;
        }
        logger?.warn(
            { app: hosted.appName, reason: error.message },
            `hosted wake: the image on trial did not come up; the machine runs the version before it`,
        );
        const digest = digestIn(hosted.unprovenImage ?? ``);
        if (digest !== undefined) {
            await record.prisma.hostedBuild
                .updateMany({
                    where: { hostedMachineId: record.hostedMachineId, digest },
                    data: { error: `built, but the machine could not be switched to it: ${error.message}` },
                })
                .catch((failure) =>
                    logger?.error({ err: failure, app: hosted.appName }, `hosted wake: recording why the rebuild was not kept failed`),
                );
        }
    }
};

/* A WAKE ALSO HEALS THE TUNNEL. A machine configured before hosted machines dialled the edge (71dbfb7145) carries
 * neither SANDBOX_GRANT nor INGRESS_URL, and a stop/start never changes a config, so it would never dial, and with the
 * edge terminating TLS itself nothing else reaches it. So the wake reads the machine's environment first and,
 * when the tunnel's pair is missing or no longer what this platform would write (a moved edge, a rotated key),
 * re-applies the whole config the way a restart does, with the machine's own overlay and guest, then starts it and
 * confirms. A stock machine moves onto today's stock digest, as a restart moves it: one that old most likely runs an
 * image from before netd that dials (aa02061469 landed hours before 71dbfb7145), and a grant it cannot present
 * would heal nothing. That move is an image change, so it goes through the state gate (gate/state-gate.ts): a target
 * that cannot convert this sandbox's state heals the tunnel on the image the machine already runs instead, and a
 * target that does not start is put back, so the wake is never the thing that leaves a machine unable to boot. A
 * config a dead gate left mid-probe (its marker in the environment) is re-applied the same way. An overlay machine
 * keeps its overlay, whose base is the owner's rebuild to move. `heal` is lazy because only this case needs the
 * sandbox's identity. A read that fails is not a verdict: the plain start runs and the next wake asks again. A probe
 * caught mid-transition is a gate at work, never a machine to start: HostedMachineBusy, as when the heal meets the
 * app's lock held. A machine whose image is ON TRIAL (a rebuild applied while it slept) has that start judged like any
 * image change's (gate/state-gate.ts), and goes back to the image before it when it does not come up. Answers whether
 * it healed. */
export const wakeHosted = async (
    config: Config,
    hosted: HostedWakeTarget,
    heal?: () => HostedProvisionArgs,
    logger?: Logger,
    record?: HostedGateRecord,
): Promise<boolean> => {
    // The environment the machine holds, once read: a heal and a trial's way back are composed around the project folder
    // it names (hosted-project.ts).
    let held: Readonly<Record<string, string>> | undefined;
    if (heal !== undefined && ingressEnabled(config)) {
        // allow(silent-catch): a read that fails is not a verdict; the plain start below runs and the next wake asks again
        const launch = await getMachineLaunch(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch(() => undefined);
        const probing = launch?.env?.[STATE_PROBE_ENV] !== undefined;
        held = launch?.env;
        if (launch?.env !== undefined && HEALABLE_STATES.has(launch.state)) {
            const args = { ...heal(), project: projectOfEnv(launch.env) };
            if (!tunnelEnvCurrent(config, args.connectToken, launch.env) || probing) {
                await healHosted(config, hosted, args, logger, record);
                return true;
            }
        } else if (probing) {
            throw new HostedMachineBusy(`this sandbox is being changed right now; try again in a moment`);
        }
    }
    if (heal !== undefined && record !== undefined && (hosted.unprovenImage ?? null) !== null) {
        const project = held === undefined ? await hostedProjectOf(config, hosted) : projectOfEnv(held);
        await startTrialHosted(config, hosted, { ...heal(), project }, logger, record);
        return false;
    }
    await startHosted(config, hosted);
    return false;
};

// Starts a stopped machine; Fly's refusal for one that's already live or mid-replace both read as success here — the
// browser's own probe decides when the sandbox is truly back.
const startHosted = async (config: Config, hosted: { appName: string; machineId: string }): Promise<void> => {
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

// Claims a warm machine for this sandbox or returns undefined for the cold path. A guarded ready-to-claimed update
// stops double-claims; the hand-off commits as one transaction, and a stranded row stays claimed for reconcile rather
// than reopening.
const claimPoolMachine = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<HostedProvisioned | undefined> => {
    // Warm stock is built to the free rung's shape, so only a free-rung arrival can take one as it stands; anything
    // bigger is built to order rather than handed a machine that is not what it was sold as. A project is built to order
    // too: warm stock's prewarm boot already put the starter site on its volume, which never sits beside a project.
    if (args.tier !== FREE_TIER.id || args.project !== undefined) {
        return undefined;
    }
    const ready = await prisma.hostedPoolMachine.findMany({
        where: { region: args.region, state: `ready` },
        orderBy: { createdAt: `asc` },
    });
    // Resolved only once there is something to match it against: an empty pool is the ordinary cold path, and it
    // must not pay for a registry round trip to learn it has nothing.
    if (ready.length === 0) {
        return undefined;
    }
    /* ROWS ON ANY OTHER IMAGE ARE DRIFT, not stock. */
    const stockImage = await resolveHostedImage(config, logger);
    const candidates = ready.filter((row) => row.image === stockImage);
    for (const row of candidates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each iteration races other claimers for one row; parallelism is the bug
        const won = await prisma.hostedPoolMachine.updateMany({ where: { id: row.id, state: `ready` }, data: { state: `claimed` } });
        if (won.count === 0) {
            continue;
        }
        try {
            // The pool row remains claimed until the handoff or durable cleanup completes.
            return await withHostedApp(prisma, config, logger, args, row.appName, async () => {
                // Machine's identity, not the row's: the config, hostname and row all follow it.
                const connectToken = decryptSecret(config, row.token);
                const adopted: HostedProvisionArgs = { ...args, connectToken };
                // oxlint-disable-next-line eslint/no-await-in-loop
                // `row.image` and not the configured tag: this machine already holds that exact digest, so replacing
                // its config changes identity and env only, and it starts instead of pulling.
                await updateMachine(
                    config.hosted.flyApiToken,
                    row.appName,
                    row.machineId,
                    hostedMachineConfig(config, adopted, row.appName, row.volumeId, STOCK_OVERLAY, row.image),
                );
                await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
                // oxlint-disable-next-line eslint/no-await-in-loop
                await startAfterUpdate(config, row, () => assertHostedIdentity(prisma, args.sandboxId, args.connectToken));
                // oxlint-disable-next-line eslint/no-await-in-loop
                await withHostedSlot(prisma, config, args, row.appName, async (tx) => {
                    await tx.hostedMachine.create({
                        data: {
                            sandboxId: args.sandboxId,
                            appName: row.appName,
                            machineId: row.machineId,
                            volumeId: row.volumeId,
                            region: row.region,
                            warm: true,
                            wokeAt: new Date(),
                            tier: args.tier,
                            ...hostedShapeFor(config, args.tier),
                        },
                    });
                    await tx.hostedPoolMachine.delete({ where: { id: row.id } });
                    // The ciphertext moves as it is (same key, and a fresh IV bought nothing); the derived
                    // columns are the same derivation the mint writes.
                    await tx.sandbox.update({ where: { id: args.sandboxId }, data: { token: row.token, ...connectTokenIdentity(connectToken) } });
                });
                return { appName: row.appName, region: row.region, warm: true };
            });
        } catch (error) {
            if (error instanceof HostedProvisionCancelled || error instanceof HostedAlreadyProvisioned) {
                throw error;
            }
            // The one failure that must not try the next candidate: a `sandboxId` collision means this sandbox already
            // has a machine, so every further candidate would be branded and stranded for nothing.
            // oxlint-disable-next-line eslint/no-await-in-loop -- the loop is sequential by design; see above
            if (await alreadyProvisioned(prisma, args.sandboxId, error)) {
                logger.warn(
                    { app: row.appName, sandboxId: args.sandboxId },
                    `hosted pool: this sandbox was provisioned concurrently; abandoning the claim rather than branding more stock`,
                );
                throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
            }
            // The owner's slots are spent (withHostedSlot): the same terminal shape, since the next candidate
            // would meet the same count. The machine this iteration branded holds no row; the reconcile collects it.
            if (error instanceof HostedSlotsExhausted) {
                logger.warn({ app: row.appName, sandboxId: args.sandboxId }, `hosted pool: the owner has no slot left; abandoning the claim`);
                throw error;
            }
            logger.warn({ err: error, app: row.appName }, `hosted pool: claim failed; trying the next warm machine`);
        }
    }
    return undefined;
};

/* AN APP NAMED FOR THIS SANDBOX HOLDS A MACHINE THIS PLATFORM DID NOT MAKE: another deployment sharing the Fly org and
 * credential, or one made by hand. It is never adopted and never touched, so the provision fails in words an operator
 * can act on rather than at createApp. */
export class HostedAppNotOurs extends Error {}

/* WHAT THE PROVIDER ALREADY HOLDS UNDER THIS SANDBOX'S OWN NAME, read before a provision makes anything. Every
 * provision of one sandbox computes the same app name from its token (`hostedAppName`), so when Fly lost a machine and
 * the platform dropped its row (`forgetHostedMachine`, the wake, the idle sweep, the health sweep), the next provision
 * or restart for that sandbox meets the app and the volume left behind: its disk. (2026-10-05) That failed at
 * createApp, and a free-rung provision claimed warm stock before it got that far, which rotated the token, tombstoned
 * the old id and so handed the disk to the orphan reaper. Four answers:
 * - absent: Fly says there is no such app; the ordinary path, warm pool first
 * - unreadable: Fly did not answer. The cold path without the pool: createApp refuses a name that exists, while a claim
 *   would rotate the token away from a disk this call could not see
 * - foreign: a machine in it is stamped by another deployment, or by nobody; refused (HostedAppNotOurs)
 * - adoptable: empty, or holding only machines this platform stamped; the newest that is not a builder, and every
 *   volume, for `adoptHostedApp` */
type HeldApp =
    | { readonly kind: `absent` | `unreadable` }
    | { readonly kind: `foreign`; readonly machines: readonly string[] }
    | { readonly kind: `adoptable`; readonly machineId: string | undefined; readonly volumes: readonly FlyVolumeSummary[] };

const newestFirst = <T extends { readonly createdAt: Date | undefined }>(items: readonly T[]): T[] =>
    items.toSorted((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0));

const heldAppOf = async (config: Config, appName: string, logger: Logger): Promise<HeldApp> => {
    const { flyApiToken } = config.hosted;
    try {
        if (!(await appExists(flyApiToken, appName))) {
            return { kind: `absent` };
        }
        const machines = await listMachines(flyApiToken, appName);
        const instance = hostedInstanceId(config);
        const foreign = machines.filter((machine) => machine.metadata[FLY_META_PLATFORM] !== instance).map((machine) => machine.id);
        if (foreign.length > 0) {
            return { kind: `foreign`, machines: foreign };
        }
        // A builder mounts nothing (sandbox-run's builder config), so it is never the machine that holds the disk.
        const [newest] = newestFirst(machines.filter((machine) => machine.metadata[FLY_META_ROLE] !== `build`));
        return { kind: `adoptable`, machineId: newest?.id, volumes: await listVolumes(flyApiToken, appName) };
    } catch (error) {
        logger.warn(
            { err: error, app: appName },
            `hosted provision: could not read whether this sandbox's app is still on the provider; building to order`,
        );
        return { kind: `unreadable` };
    }
};

// The disk an adoption keeps: the volume the adopted machine mounts, else the newest volume in the app, else none.
const adoptedVolume = async (
    config: Config,
    appName: string,
    held: Extract<HeldApp, { kind: `adoptable` }>,
): Promise<FlyVolumeSummary | undefined> => {
    const [newest] = newestFirst(held.volumes);
    if (held.machineId === undefined) {
        return newest;
    }
    const current = await getMachineConfig(config.hosted.flyApiToken, appName, held.machineId);
    // Fly's own config, whose `mounts` a machine that mounts nothing leaves out.
    const mounted = (current.config as { readonly mounts?: readonly { readonly volume?: string }[] }).mounts?.[0]?.volume;
    return mounted === undefined ? newest : (held.volumes.find((volume) => volume.id === mounted) ?? { id: mounted, createdAt: undefined });
};

/* A PROVISION THAT FINDS THIS SANDBOX'S OWN APP TAKES IT BACK instead of failing at createApp. The disk stays: a machine
 * this platform stamped is re-configured onto the volume it mounts and started, or a new machine is made on the newest
 * volume (a new volume only when the app holds none), and the row is written as a cold provision writes it, in the
 * volume's own region and at its real size. Never under the cleanup record a cold provision keeps (withHostedApp):
 * that record deletes the whole app on a failure, and this app holds the owner's work, so the one thing a failure here
 * takes back down is a machine this call made. Under the app's lock, as every change to an app is. */
const adoptHostedApp = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
    appName: string,
    held: Extract<HeldApp, { kind: `adoptable` }>,
    stockImage: string,
): Promise<HostedProvisioned> => {
    const { flyApiToken } = config.hosted;
    const shape = hostedShapeFor(config, args.tier);
    const adopted = await withHostedAppLock(config, appName, true, async (): Promise<HostedProvisioned> => {
        const existing = await prisma.hostedMachine.findUnique({ where: { appName } });
        if (existing !== null) {
            throw existing.sandboxId === args.sandboxId
                ? new HostedAlreadyProvisioned(`this sandbox already has a machine`)
                : new Error(`this app belongs to another sandbox`);
        }
        await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
        const kept = await adoptedVolume(config, appName, held);
        const region = kept?.region ?? args.region;
        logger.warn(
            { app: appName, sandboxId: args.sandboxId, machine: held.machineId ?? null, volume: kept?.id ?? null },
            `hosted provision: this sandbox's own app is still on the provider; adopting it rather than building another`,
        );
        let made: string | undefined;
        try {
            const volumeId = kept?.id ?? (await createVolume(flyApiToken, appName, region, shape.volumeGb, volumeOptions(config, shape))).volumeId;
            const machineConfig = hostedMachineConfig(config, args, appName, volumeId, STOCK_OVERLAY, stockImage, shape);
            let machineId = held.machineId;
            if (machineId === undefined) {
                ({ machineId } = await createMachine(flyApiToken, appName, { name: appName, region, config: machineConfig }));
                made = machineId;
            } else {
                const adoptedMachine = { appName, machineId };
                await updateMachine(flyApiToken, appName, machineId, machineConfig);
                await startAfterUpdate(config, adoptedMachine, () => assertHostedIdentity(prisma, args.sandboxId, args.connectToken));
            }
            await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
            const row = { sandboxId: args.sandboxId, appName, machineId, volumeId, region, warm: false, wokeAt: new Date(), tier: args.tier };
            await withHostedSlot(prisma, config, args, appName, (tx) =>
                tx.hostedMachine.create({ data: { ...row, ...shape, volumeGb: kept?.sizeGb ?? shape.volumeGb } }),
            );
            return { appName, region, warm: false };
        } catch (error) {
            if (made !== undefined) {
                const unmade = made;
                await destroyMachine(flyApiToken, appName, unmade, { force: true }).catch((failure: unknown) =>
                    logger.error(
                        { err: failure, app: appName, machine: unmade },
                        `hosted provision: a machine made for an adoption that failed could not be destroyed`,
                    ),
                );
            }
            if (await alreadyProvisioned(prisma, args.sandboxId, error)) {
                throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
            }
            if (isFlyCapacity(error)) {
                noteProviderAtCapacity(region, providerWords(error));
                throw new HostedAtCapacity(AT_CAPACITY_MESSAGE);
            }
            throw error;
        }
    });
    if (adopted === undefined) {
        throw new HostedProvisionCancelled();
    }
    return adopted;
};

// Creates the machine, warm from the pool (seconds) or built to order (minutes); either way the row is stamped last. A
// failed cold build deletes its half-made app for a clean retry; a failed claim falls through to the cold path. This
// sandbox's own app, when the provider still holds it, is adopted first (`heldAppOf`).
export const provisionHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<HostedProvisioned> => {
    await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
    const { flyApiToken, flyOrg } = config.hosted;
    const shape = hostedShapeFor(config, args.tier);
    const { region } = args;
    const appName = hostedAppName(config, args.sandboxId, args.connectToken);
    const held = await heldAppOf(config, appName, logger);
    if (held.kind === `foreign`) {
        logger.error(
            { app: appName, sandboxId: args.sandboxId, machines: held.machines },
            `hosted provision: this sandbox's app holds machines this platform did not make; left alone`,
        );
        throw new HostedAppNotOurs(
            `the provider already has an app named for this sandbox (${appName}) holding a machine this platform did not make; it was left alone, and an operator has to say whose it is`,
        );
    }
    const claimed = held.kind === `absent` ? await claimPoolMachine(prisma, config, logger, args) : undefined;
    if (claimed !== undefined) {
        return claimed;
    }
    // Checked after the pool claim, so a fleet at its ceiling can still serve warm stock, and before Fly is asked, so a
    // full org fails in plain words instead of a 422 naming an app the reader has never seen. An adoption that re-uses
    // a machine the app already holds adds none, so it is not asked.
    if (held.kind !== `adoptable` || held.machineId === undefined) {
        const capacity = await hostedCapacity(prisma, config, region);
        if (capacity.headroom === 0) {
            logger.error(
                { used: capacity.used, cap: capacity.cap, reason: capacity.reason, region },
                `hosted: no room for another machine; refusing the lane in plain words rather than failing at the provider`,
            );
            throw new HostedAtCapacity(AT_CAPACITY_MESSAGE);
        }
    }
    // Pinned like the pool's, so cold and warm machines are the same rootfs and a later config replacement on
    // this machine (an overlay, a wake) cannot silently re-resolve the tag underneath it.
    const stockImage = await resolveHostedImage(config, logger);
    if (held.kind === `adoptable`) {
        return adoptHostedApp(prisma, config, logger, args, appName, held, stockImage);
    }
    return withHostedApp(prisma, config, logger, args, appName, async () => {
        try {
            try {
                await createApp(flyApiToken, flyOrg, appName);
            } catch (error) {
                // A refused create grants no ownership of an app that already exists.
                if (error instanceof FlyError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408) {
                    await prisma.hostedCleanup.deleteMany({ where: { appName } });
                }
                throw error;
            }
            await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
            const { volumeId } = await createVolume(flyApiToken, appName, region, shape.volumeGb, volumeOptions(config, shape));
            await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
            const { machineId } = await createMachine(flyApiToken, appName, {
                name: appName,
                region,
                config: hostedMachineConfig(config, args, appName, volumeId, STOCK_OVERLAY, stockImage, shape),
            });
            // `wokeAt` opens the hour meter's first stretch: a machine is RUNNING from the moment it is created,
            // so the free plan's clock starts here rather than at the first wake, which is the only version that
            // does not hand out an uncounted first session to everyone who ever provisions one.
            await withHostedSlot(prisma, config, args, appName, (tx) =>
                tx.hostedMachine.create({
                    data: {
                        sandboxId: args.sandboxId,
                        appName,
                        machineId,
                        volumeId,
                        region,
                        warm: false,
                        wokeAt: new Date(),
                        tier: args.tier,
                        ...shape,
                    },
                }),
            );
            return { appName, region, warm: false };
        } catch (error) {
            // The claim loop's race, one step later: this call's own app can't collide by name (that would fail at
            // createApp), so the winner's machine is the answer, not a failure.
            if (await alreadyProvisioned(prisma, args.sandboxId, error)) {
                throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
            }
            // Read as the same refusal whatever the cause, and latched briefly so the next arrivals skip the round trip;
            // logged at error because only an operator moving a limit or a region fixes it.
            if (isFlyCapacity(error)) {
                noteProviderAtCapacity(region, providerWords(error));
                logger.error({ err: error, region, appName }, `hosted: the provider has no machine left to give; the lane is full`);
                throw new HostedAtCapacity(AT_CAPACITY_MESSAGE);
            }
            throw error;
        }
    });
};

// Explicit repair/update boundary: a plain stop/start can't fix a boot-crashing machine pinned to its original rootfs,
// so this replaces the full config while stopped, then wakes it as one metered transition. A stock machine moves onto
// today's stock digest, under the state gate (gate/state-gate.ts): a target that cannot convert this sandbox's state
// leaves it on its version with the fresh config, and one that does not start or come up is put back; both throw
// HostedImageKept. A digest the owner rolled back from is not moved onto while `:stable` still names it. It waits its
// turn behind any other change to this machine (the gate's lock).
export const refreshHosted = async (
    config: Config,
    args: HostedProvisionArgs,
    hosted: {
        appName: string;
        machineId: string;
        volumeId: string;
        image?: string | null;
        environmentHash?: string | null;
        skippedDigest?: string | null;
    },
    logger?: Logger,
    record?: HostedGateRecord,
): Promise<void> => {
    // The machine's project folder rides over from the config it holds (hosted-project.ts).
    const placed: HostedProvisionArgs = { ...args, project: await hostedProjectOf(config, hosted) };
    // Keeps the machine's existing overlay; a moved base image is a rebuild's job (hosted-build.ts), not this call's.
    const overlay: HostedOverlay = { image: hosted.image ?? null, environmentHash: hosted.environmentHash ?? null };
    // Resolved to a digest, so a restart on the digest the machine already runs converts nothing and asks nothing.
    const stockImage = overlay.image === null ? await stockTargetOf(config, hosted, logger) : config.hosted.image;
    const target = hostedMachineConfig(config, placed, hosted.appName, hosted.volumeId, overlay, stockImage);
    await switchHostedImage(config, hosted, target, {
        start: true,
        keepImage: true,
        record,
        compose: composerFor(config, placed, hosted),
        facts: overlay.image === null ? STOCK_FACTS : undefined,
        logger,
    });
};

/* THE ROW KEEPS NO EARLIER IMAGE FOR THIS MACHINE: it has not changed image since the platform began keeping one, or
 * the last change was undone automatically. Nothing was touched. */
export class HostedNothingKept extends Error {}

// A machine's row as the owner's rollback reads it: what it runs, what it keeps, and its own guest.
export interface HostedRollbackTarget {
    readonly cpuKind: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly volumeGb: number;
    readonly appName: string;
    readonly machineId: string;
    readonly volumeId: string;
    readonly image?: string | null;
    readonly baseDigest?: string | null;
    readonly previousImage?: string | null;
    readonly previousEnvironmentHash?: string | null;
}

// The platform digest a rollback leaves, which later restarts skip: the one a stock machine runs, or the base its overlay
// was built on (the one `:stable` names today, when that was never recorded). Null when neither can be said.
const leftDigestOf = async (config: Config, hosted: HostedRollbackTarget, logger: Logger | undefined): Promise<string | null> => {
    if ((hosted.image ?? null) === null) {
        return digestIn(await runningImageOf(config, hosted)) ?? null;
    }
    return hosted.baseDigest ?? digestIn(await resolveHostedImage(config, logger)) ?? null;
};

/* THE OWNER'S WAY BACK: the image the machine ran before its last image change, through the same gate as any change (its
 * planner asked over the volume, its daemon waited for), inside the fresh config a restart writes. The image it leaves
 * becomes the way back, so a second press goes forward again; and the platform digest it leaves is skipped by later
 * restarts and heals while `:stable` still resolves to it. The platform's own act: it needs nothing of the daemon, so it
 * works while the daemon is down. Throws HostedNothingKept, and what switchHostedImage throws. */
export const rollbackHosted = async (
    config: Config,
    args: HostedProvisionArgs,
    hosted: HostedRollbackTarget,
    logger?: Logger,
    record?: HostedGateRecord,
): Promise<void> => {
    const back = hosted.previousImage ?? null;
    if (back === null) {
        throw new HostedNothingKept(`this sandbox has no earlier version kept to go back to`);
    }
    const environmentHash = hosted.previousEnvironmentHash ?? null;
    // The machine's project folder rides over from the config it holds (hosted-project.ts).
    const compose = composerFor(config, { ...args, project: await hostedProjectOf(config, hosted) }, hosted, shapeOfRow(hosted));
    const skip = await leftDigestOf(config, hosted, logger);
    // The base an earlier overlay was built on is not kept beside it: unknown, which the next rebuild check reads as moved.
    // A refusal puts back the config the machine held as it was: this target's recipe is the earlier version's, not its.
    await switchHostedImage(config, hosted, compose(back, environmentHash), {
        start: true,
        record,
        compose,
        facts: { environmentHash, baseImage: null, baseDigest: null },
        skip,
        words: ROLLBACK_WORDS,
        logger,
    });
};

// Tears the app down (machines and volume go with it); 404-tolerant by fly.ts's contract.
export const destroyHosted = async (config: Config, appName: string): Promise<void> => deleteApp(config.hosted.flyApiToken, appName);

// Drops the machine row and clears `daemonUrl`, so the browser reads "not connected" instead of reconnecting into a
// machine that's gone. `lastSeenAt` stays: it's what keeps this a workspace to reopen, not a fresh setup. The app and
// its volume stay too: the orphan reaper spares an app whose sandbox row still exists (`live` in `OrphanSkip`), and the
// sandbox's next provision or restart adopts it (`adoptHostedApp`), its disk included.
export const forgetHostedMachine = async (
    prisma: PrismaClient,
    machine: { id: string; sandboxId: string; ownerId: string },
    endedAt?: Date,
): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        // Sandbox row before machine row: the lock order trash and release take.
        await tx.sandbox.update({ where: { id: machine.sandboxId }, data: { daemonUrl: null } });
        await dropHostedMachine(tx, machine, endedAt);
    });
};

// A cold provision runs app to volume to machine to row over minutes; inside this window it's in progress, not litter.
const REAP_GRACE_MS = 30 * 60 * 1000;

/* HOW MUCH ONE PASS DESTROYS, AND WHEN IT DESTROYS NOTHING. A wrong database looks identical to a real orphan glut, so a
 * pass whose collectable apps are an implausible share of the fleet (more than REAP_MAX_SHARE of it, past the first
 * REAP_MAX_APPS) refuses outright and logs why. Below that it destroys the oldest of them, up to REAP_PASS_SHARE of the
 * fleet and never fewer than REAP_MAX_APPS, and leaves the rest for the next pass, logged as deferred. (2026-10-05) Any
 * backlog past the ceiling used to refuse the whole pass, so after an outage the reaper never caught up. */
const REAP_MAX_APPS = 3;
const REAP_MAX_SHARE = 0.25;
const REAP_PASS_SHARE = 0.1;

// Whose app this is, decided from machine metadata rather than the name.
// - mine: every machine carries this platform's stamp
// - theirs: at least one machine names a different deployment; never destroy
// - unknown: no machine carries a stamp, or the app has none at all
export type AppOwner = "mine" | "theirs" | "unknown";

const appOwner = (machines: { metadata: Record<string, string> }[], instance: string): AppOwner => {
    const stamps = machines.map((machine) => machine.metadata[FLY_META_PLATFORM]).filter((stamp) => stamp !== undefined);
    if (stamps.length === 0) {
        return `unknown`;
    }
    return stamps.every((stamp) => stamp === instance) ? `mine` : `theirs`;
};

// What the sweep reads of an unknown app on Fly, or undefined if Fly won't answer (read as "not now", not a verdict).
// Age is the oldest resource in the app, not the newest machine. `stock` says every machine in it is warm stock this
// platform built (hosted-pool.ts) and nobody claimed: a claim re-stamps its machine `sandbox` before anyone works on it.
interface AppEvidence {
    readonly owner: AppOwner;
    readonly oldestAt: Date | undefined;
    readonly machines: number;
    readonly stock: boolean;
}

const appEvidence = async (config: Config, app: string): Promise<AppEvidence | undefined> => {
    try {
        const machines = await listMachines(config.hosted.flyApiToken, app);
        const volumes = machines.length > 0 ? [] : await listVolumes(config.hosted.flyApiToken, app);
        const stamps = [...machines.map((machine) => machine.createdAt), ...volumes.map((volume) => volume.createdAt)].filter(
            (at): at is Date => at !== undefined,
        );
        const instance = hostedInstanceId(config);
        return {
            owner: appOwner(machines, instance),
            oldestAt: stamps.length === 0 ? undefined : new Date(Math.min(...stamps.map((at) => at.getTime()))),
            machines: machines.length,
            stock:
                machines.length > 0 &&
                machines.every((machine) => machine.metadata[FLY_META_ROLE] === `warm` && machine.metadata[FLY_META_PLATFORM] === instance),
        };
    } catch (error) {
        return isFlyGone(error) ? { owner: `mine`, oldestAt: undefined, machines: 0, stock: false } : undefined;
    }
};

/* WHAT THIS DATABASE SAYS OF THE SANDBOX AN APP IS NAMED FOR (the tunnel id past the prefix, `hostedAppName`), read
 * before Fly is asked anything:
 * - live: a sandbox row still holds the id. The row that tied machine to sandbox was dropped (Fly lost the machine,
 *   `forgetHostedMachine`), the sandbox was not, and the volume is its disk
 * - tombstoned: a deletion record holds it (SandboxTombstone, written by a trigger on every delete and every token
 *   rotation): the one "gone" this sweep destroys on (platform.md, "When the platform forgets")
 * - neither: this database never knew the sandbox, or has forgotten it */
export interface AppRecords {
    readonly live: ReadonlySet<string>;
    readonly tombstoned: ReadonlySet<string>;
}

// The tunnel id an app is named for (`hostedAppName`): the name past this platform's prefix.
const appTunnelId = (config: Config, app: string): string => app.slice(`${config.hosted.appPrefix}-`.length);

export const appRecordsOf = async (prisma: PrismaClient, config: Config, apps: readonly string[]): Promise<AppRecords> => {
    if (apps.length === 0) {
        return { live: new Set(), tombstoned: new Set() };
    }
    const ids = apps.map((app) => appTunnelId(config, app));
    const [rows, tombstones] = await Promise.all([
        prisma.sandbox.findMany({ where: { tunnelId: { in: ids } }, select: { tunnelId: true } }),
        prisma.sandboxTombstone.findMany({ where: { tunnelId: { in: ids } }, select: { tunnelId: true } }),
    ]);
    return { live: new Set(rows.map((row) => row.tunnelId)), tombstoned: new Set(tombstones.map((row) => row.tunnelId)) };
};

// Why an app is left standing (order matters):
// 1. live: a sandbox row still holds its tunnel id (AppRecords); its volume is that sandbox's disk, which nobody can
//    rebuild, and the sandbox's next provision or restart adopts it (`adoptHostedApp`)
// 2. unreadable: Fly wouldn't answer; never a verdict
// 3. theirs: a machine names another deployment (checked first among Fly's answers, and true regardless of age)
// 4. young: inside the grace window, likely mid-provision
// 5. unknown: has machines, none carrying a stamp; ownership cannot be proven, so never destroyed
// 6. forgotten: this platform's as far as Fly can say, but this database holds no deletion record for its sandbox.
//    Absence is not deletion: a platform restored from an older backup has no row and no record for every sandbox made
//    since, and their apps are those sandboxes' disks. Reported (hosted health, the admin digest) for an operator to
//    decide, never destroyed
// An app is collected only on positive evidence: the deletion record of its sandbox, or every machine in it being
// unclaimed warm stock. (2026-10-05) An app with no machine used to be collected for its emptiness alone, which is
// exactly what Fly losing a machine leaves of a sandbox nobody deleted. An app a HostedCleanup row names never gets
// here: that row is a teardown somebody asked for, and the cleanup sweep runs it.
export type OrphanSkip = "live" | "theirs" | "unknown" | "young" | "unreadable" | "forgotten";

const orphanVerdict = (evidence: AppEvidence | undefined, tombstoned: boolean, now: number): OrphanSkip | undefined => {
    if (evidence === undefined) {
        return `unreadable`;
    }
    if (evidence.owner === `theirs`) {
        return `theirs`;
    }
    if (evidence.oldestAt !== undefined && now - evidence.oldestAt.getTime() < REAP_GRACE_MS) {
        return `young`;
    }
    if (evidence.machines > 0 && evidence.owner !== `mine`) {
        return `unknown`;
    }
    return tombstoned || evidence.stock ? undefined : `forgotten`;
};

// Sorts our-prefix apps the database can't explain into collectable (oldest first, so a pass stopped by its cap has
// taken the longest-standing) and skipped-with-reason. Exported so the health watch reports the same verdicts the
// reaper acts on.
export const sortUnknownApps = async (
    config: Config,
    unknown: readonly string[],
    records: AppRecords,
): Promise<{ doomed: string[]; skipped: { app: string; why: OrphanSkip }[] }> => {
    const now = Date.now();
    const doomed: { app: string; since: number }[] = [];
    const skipped: { app: string; why: OrphanSkip }[] = [];
    for (const app of unknown) {
        const id = appTunnelId(config, app);
        if (records.live.has(id)) {
            skipped.push({ app, why: `live` });
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per unknown app, once a day
        const evidence = await appEvidence(config, app);
        const why = orphanVerdict(evidence, records.tombstoned.has(id), now);
        if (why === undefined) {
            doomed.push({ app, since: evidence?.oldestAt?.getTime() ?? 0 });
        } else {
            skipped.push({ app, why });
        }
    }
    return { doomed: doomed.toSorted((left, right) => left.since - right.since).map((entry) => entry.app), skipped };
};

/* WHAT ONE PASS DID, for the retention sweep's log line and the admin digest: the apps it destroyed, the ones it left
 * for the next pass under its cap, the ones it refused to touch at all, the apps of sandboxes this database has no
 * record of (an operator's call), and how many it skipped for each reason. A type, not an interface, so it is the
 * plain record a sweep step logs. */
export type HostedReapReport = {
    readonly destroyed: readonly string[];
    readonly deferred: readonly string[];
    readonly refused: readonly string[];
    readonly forgotten: readonly string[];
    readonly skipped: Readonly<Partial<Record<OrphanSkip, number>>>;
};

const NOTHING_REAPED: HostedReapReport = { destroyed: [], deferred: [], refused: [], forgotten: [], skipped: {} };

const tallyOf = (skipped: readonly { why: OrphanSkip }[]): Partial<Record<OrphanSkip, number>> => {
    const tally: Partial<Record<OrphanSkip, number>> = {};
    for (const { why } of skipped) {
        tally[why] = (tally[why] ?? 0) + 1;
    }
    return tally;
};

// Destroys our-prefix apps with no row behind them whose sandbox was deleted (or that are unclaimed warm stock), using
// ownership read from machine metadata (fly.ts) rather than the name, since a Fly org is shared by every deployment
// holding its credential. A young app is spared, a pass takes the oldest up to its cap, and a pass wanting an
// implausible share of the fleet refuses outright.
export const reapHostedOrphans = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<HostedReapReport> => {
    if (!hostedEnabled(config)) {
        return NOTHING_REAPED;
    }
    const prefix = `${config.hosted.appPrefix}-`;
    const names = (await listAppNames(config.hosted.flyApiToken, config.hosted.flyOrg)).filter((name) => name.startsWith(prefix));
    if (names.length === 0) {
        return NOTHING_REAPED;
    }
    const [machines, pooled, pending, trashed] = await Promise.all([
        prisma.hostedMachine.findMany({ select: { appName: true } }),
        prisma.hostedPoolMachine.findMany({ select: { appName: true } }),
        prisma.hostedCleanup.findMany({ select: { appName: true } }),
        // A deleted sandbox's app has no machine row by design — it is held for the owner's recovery window, and
        // without this the reaper would read that absence as litter and destroy the disk inside the hour.
        prisma.sandboxTrash.findMany({ where: { appName: { not: null } }, select: { appName: true } }),
    ]);
    const known = new Set([...machines, ...pooled, ...pending, ...trashed].map((row) => row.appName).filter((name): name is string => name !== null));
    const unknown = names.filter((candidate) => !known.has(candidate));
    const { doomed, skipped } = await sortUnknownApps(config, unknown, await appRecordsOf(prisma, config, unknown));
    const forgotten = skipped.filter((entry) => entry.why === `forgotten`).map((entry) => entry.app);
    const others = skipped.filter((entry) => entry.why !== `forgotten`);
    if (others.length > 0) {
        // One line an operator can act on: every skipped app is one this platform cannot prove is its own.
        logger.warn({ skipped: others }, `hosted reaper: apps left standing because this platform cannot prove they are its own`);
    }
    if (forgotten.length > 0) {
        logger.warn(
            { forgotten },
            `hosted reaper: apps of sandboxes this database has neither a row nor a deletion record for, left standing for an operator (a restore from an older backup leaves exactly these)`,
        );
    }
    const report = { forgotten, skipped: tallyOf(skipped) };
    if (doomed.length > REAP_MAX_APPS && doomed.length > names.length * REAP_MAX_SHARE) {
        logger.error(
            { doomed: doomed.length, share: REAP_MAX_SHARE, ourApps: names.length, apps: doomed },
            `hosted reaper: refusing to destroy this share of the fleet at once; the database, not the fleet, is the likely fault`,
        );
        return { ...report, destroyed: [], deferred: [], refused: doomed };
    }
    const cap = Math.max(REAP_MAX_APPS, Math.floor(names.length * REAP_PASS_SHARE));
    const deferred = doomed.slice(cap);
    if (deferred.length > 0) {
        logger.warn({ cap, deferred }, `hosted reaper: more collectable apps than one pass destroys; the oldest go now, the rest on the next pass`);
    }
    const destroyed: string[] = [];
    for (const name of doomed.slice(0, cap)) {
        logger.warn({ app: name }, `hosted reaper: destroying an app whose sandbox was deleted, or warm stock nobody claimed`);
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on the API; a handful at most
            await deleteApp(config.hosted.flyApiToken, name);
            destroyed.push(name);
        } catch (error) {
            logger.error({ err: error, app: name }, `hosted reaper: destroying an orphaned app failed; retried tomorrow`);
        }
    }
    return { ...report, destroyed, deferred, refused: [] };
};
