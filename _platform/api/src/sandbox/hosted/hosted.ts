import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import { ENV_PLATFORM_PUBLIC_KEY, publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { decryptSecret } from "../../crypto.js";
import { connectTokenIdentity } from "../mint-sandbox.js";
import { ingressEnabled, sandboxHostname } from "../reachability.js";
import {
    createApp,
    createMachine,
    createVolume,
    deleteApp,
    FLY_META_PLATFORM,
    flySandboxRole,
    getMachine,
    isFlyCapacity,
    isFlyGone,
    listAppNames,
    listMachines,
    listVolumes,
    startMachine,
    updateMachine,
    LIVE_STATES,
} from "./fly/fly.js";
import { AT_CAPACITY_MESSAGE, HostedAtCapacity, hostedCapacity, noteProviderAtCapacity } from "./hosted-capacity.js";
import { resolveHostedImage } from "./build/hosted-image.js";
import { hostedSlotsOf } from "./hosted-plan.js";

// Hosted lane orchestration over fly.ts: one machine and one volume in one app per sandbox, named `<prefix>-<12-hex
// tunnel id>` always. Reachability is a replay: the edge answers `sandbox-<id>` with `fly-replay: app=<prefix>-<id>`,
// derived from the hostname with no lookup. The daemon's announce is the only up signal; the platform only flips power,
// never dials the machine.

// Both the Fly credential and the edge are required: hosted machines are reached only via the edge's replay under its
// wildcard.
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

// Raised when a concurrent provision already gave this sandbox a machine; the caller should answer with the existing
// machine, not a failure.
export class HostedAlreadyProvisioned extends Error {}

/* THE OWNER HAS NO SLOT LEFT, thrown where the row would have been written. Its own class for the route's sake:
 * this is a refusal in the owner's own words (BAD_REQUEST, "remove one first"), never a provider fault. */
export class HostedSlotsExhausted extends Error {}

// The one sentence both refusals say, the route's early one and the write's binding one, so they cannot drift.
export const slotsMessage = (used: number): string =>
    `you already have ${used === 1 ? `a hosted sandbox` : `${used} hosted sandboxes`}; remove one first, or add a slot to your plan`;

/* WRITE THE MACHINE ROW UNDER THE OWNER'S SLOT COUNT, atomically.
 *
 * The route checks the allowance before anything is built (sandbox.routes.ts assertHostedAllowance), and that
 * check is a read with no lock behind it: `sandbox.create` is unlimited, so N sandboxes and N concurrent
 * provisions all read "0 of 1 used" and all proceed, and the only brake left was the provider's own refusal,
 * which on a platform with no ceiling configured is a hundred machines away. HostedMachine is unique per
 * SANDBOX, not per owner, so no constraint catches it either. This is the check that binds: a transaction-scoped
 * advisory lock keyed on the owner serializes every row-write for that owner, and the count taken under it sees
 * whatever a competing write just committed. Held for milliseconds (a count and an insert), never across a
 * provider call, which is why the lock is here and not around the whole provision.
 *
 * Every caller has already created or claimed a machine by the time it reaches this, so a refusal here costs one
 * provider create-and-destroy in the racing case (the cold path's own cleanup). That is the right price: the
 * alternative was an unbounded fleet on one free account. */
const withHostedSlot = async <T>(
    prisma: PrismaClient,
    config: Config,
    sandboxId: string,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
    prisma.$transaction(async (tx) => {
        const { ownerId } = await tx.sandbox.findUniqueOrThrow({ where: { id: sandboxId }, select: { ownerId: true } });
        // Two int4 keys, the first naming the purpose, so nothing else on this database can share the owner's lock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hosted-slot'), hashtext(${ownerId}))`;
        const [used, slots] = await Promise.all([tx.hostedMachine.count({ where: { sandbox: { ownerId } } }), hostedSlotsOf(tx, config, ownerId)]);
        if (used >= slots) {
            throw new HostedSlotsExhausted(slotsMessage(used));
        }
        return write(tx);
    });

/* Did this sandbox get its machine from somewhere else while this call was building one?
 *
 * Asked of the DATABASE rather than read off the unique violation's `target`, which Prisma spells differently
 * per database: HostedMachine has TWO unique columns and they mean opposite things here. `sandboxId` is
 * another provision winning the race, which is terminal and answers with the winner's machine; `appName` is a
 * pool app that some other row already adopted, which is one bad candidate and nothing more. Only the first
 * may stop the claim loop, so the question is put to the column that decides it. */
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
}

// Single composer for both cold-provision and pool-claim configs, so the two origins cannot drift; a hosted machine's
// env carries no tunnel grant or edge address. Overlay is the only thing that varies; `null` on both means the stock
// image.
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
    /* WHICH STOCK IMAGE TO BOOT, when the caller knows a more exact name for it than the configured tag —
     * which, for a warm machine, is the digest already on its disk (hosted-image.ts). Passing it is what makes
     * a claim a start rather than a pull: hand Fly the tag again and it re-resolves, and after a re-push that
     * means a different digest, a fresh pull, and a claim that times out before the machine ever runs.
     * `baseImage` stays the configured tag on purpose: it is the overlay bookkeeping's key, not the rootfs. */
    stockImage: string = config.hosted.image,
) => {
    const hostname = sandboxHostname(config.ingress.zone, args.connectToken);
    return {
        ...flyMachineConfig({
            name: machineName,
            image: overlay.image ?? stockImage,
            baseImage: config.hosted.image,
            ...(overlay.image !== null && overlay.environmentHash !== null ? { environmentHash: overlay.environmentHash } : {}),
            guest: { cpus: config.hosted.cpus, memoryMb: config.hosted.memoryMb },
            volumeId,
            env: [
                [`GOOGLE_CLIENT_ID`, config.google.clientId],
                [`CONNECT_TOKEN`, args.connectToken],
                [`OWNER_EMAIL`, args.ownerEmail],
                [`WEB_ORIGIN`, config.webOrigin],
                [`SANDBOX_PUBLIC_URL`, `https://${hostname}`],
                [`PLATFORM_URL`, config.api.url],
                // Public signing key: lets this machine's daemon accept the platform's owner ticket without a second
                // sign-in.
                [ENV_PLATFORM_PUBLIC_KEY, publicKeyPemOf(config.ingress.signingKey)],
                [`IDLE_STOP_MINUTES`, String(config.hosted.idleStopMinutes)],
            ],
            frontDoor: { hostname },
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

// Starts a stopped machine; Fly's refusal for one that's already live or mid-replace both read as success here — the
// browser's own probe decides when the sandbox is truly back.
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

// After a config replacement, a machine refuses starts (412) while `replacing`, and an update never starts one that was
// stopped. Wait for it to settle, then start, then confirm it ran.
const SETTLE_ATTEMPTS = 60;
const SETTLE_MS = 500;
const RUNNING_STATES = new Set([`created`, `starting`, `started`]);
export const startAfterUpdate = async (config: Config, hosted: { appName: string; machineId: string }): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- settling is sequential by definition
        const machine = await getMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch(() => undefined);
        if (machine !== undefined && RUNNING_STATES.has(machine.state)) {
            return;
        }
        // Still replacing (or unreadable): starting now would only earn the 412 above.
        if (machine !== undefined && machine.state !== `replacing`) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            await startMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error: unknown) => {
                lastError = error;
            });
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        await delay(SETTLE_MS);
    }
    // Settled but still won't run: broken, not busy; the claim must fail rather than hand over a dead machine.
    throw new Error(
        `fly machine ${hosted.machineId} did not start after its config was replaced${lastError === undefined ? `` : `: ${String(lastError)}`}`,
    );
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
    const ready = await prisma.hostedPoolMachine.findMany({
        // Rows with no token predate identities and name no app the edge could route to; reconcile replaces them.
        where: { region: args.region, state: `ready`, NOT: { token: `` } },
        orderBy: { createdAt: `asc` },
    });
    // Resolved only once there is something to match it against: an empty pool is the ordinary cold path, and it
    // must not pay for a registry round trip to learn it has nothing.
    if (ready.length === 0) {
        return undefined;
    }
    /* ROWS ON ANY OTHER IMAGE ARE DRIFT, not stock. Their machine holds a digest the tag no longer names, so
     * adopting one would rewrite its config onto the current image and make it pull before it could start —
     * thirty seconds of settle budget against a minutes-long pull, which is exactly the failure this whole
     * change exists to end. Reconcile destroys them on its own tick; the claim simply does not touch them. */
    const stockImage = await resolveHostedImage(config, logger);
    const candidates = ready.filter((row) => row.image === stockImage);
    for (const row of candidates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each iteration races other claimers for one row; parallelism is the bug
        const won = await prisma.hostedPoolMachine.updateMany({ where: { id: row.id, state: `ready` }, data: { state: `claimed` } });
        if (won.count === 0) {
            continue;
        }
        try {
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
            // oxlint-disable-next-line eslint/no-await-in-loop
            await startAfterUpdate(config, row);
            // oxlint-disable-next-line eslint/no-await-in-loop
            await withHostedSlot(prisma, config, args.sandboxId, async (tx) => {
                await tx.hostedMachine.create({
                    data: {
                        sandboxId: args.sandboxId,
                        appName: row.appName,
                        machineId: row.machineId,
                        volumeId: row.volumeId,
                        region: row.region,
                        warm: true,
                        wokeAt: new Date(),
                    },
                });
                await tx.hostedPoolMachine.delete({ where: { id: row.id } });
                // The ciphertext moves as it is (same key, and a fresh IV bought nothing); the derived
                // columns are the same derivation the mint writes.
                await tx.sandbox.update({ where: { id: args.sandboxId }, data: { token: row.token, ...connectTokenIdentity(connectToken) } });
            });
            return { appName: row.appName, region: row.region, warm: true };
        } catch (error) {
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

// Creates the machine, warm from the pool (seconds) or built to order (minutes); either way the row is stamped last. A
// failed cold build deletes its half-made app for a clean retry; a failed claim falls through to the cold path.
export const provisionHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: HostedProvisionArgs,
): Promise<HostedProvisioned> => {
    const { flyApiToken, flyOrg, volumeGb } = config.hosted;
    const { region } = args;
    const claimed = await claimPoolMachine(prisma, config, logger, args);
    if (claimed !== undefined) {
        return claimed;
    }
    // Checked after the pool claim, so a fleet at its ceiling can still serve warm stock, and before Fly is asked, so a
    // full org fails in plain words instead of a 422 naming an app the reader has never seen.
    const capacity = await hostedCapacity(prisma, config, region);
    if (capacity.headroom === 0) {
        logger.error(
            { used: capacity.used, cap: capacity.cap, reason: capacity.reason, region },
            `hosted: no room for another machine; refusing the lane in plain words rather than failing at the provider`,
        );
        throw new HostedAtCapacity(AT_CAPACITY_MESSAGE);
    }
    const appName = hostedAppName(config, args.sandboxId, args.connectToken);
    // Pinned like the pool's, so cold and warm machines are the same rootfs and a later config replacement on
    // this machine (an overlay, a wake) cannot silently re-resolve the tag underneath it.
    const stockImage = await resolveHostedImage(config, logger);
    await createApp(flyApiToken, flyOrg, appName);
    try {
        const { volumeId } = await createVolume(flyApiToken, appName, region, volumeGb);
        const { machineId } = await createMachine(flyApiToken, appName, {
            name: appName,
            region,
            config: hostedMachineConfig(config, args, appName, volumeId, STOCK_OVERLAY, stockImage),
        });
        // `wokeAt` opens the hour meter's first stretch: a machine is RUNNING from the moment it is created,
        // so the free lane's clock starts here rather than at the first wake, which is the only version that
        // does not hand out an uncounted first session to everyone who ever provisions one.
        await withHostedSlot(prisma, config, args.sandboxId, (tx) =>
            tx.hostedMachine.create({
                data: { sandboxId: args.sandboxId, appName, machineId, volumeId, region, warm: false, wokeAt: new Date() },
            }),
        );
        return { appName, region, warm: false };
    } catch (error) {
        await deleteApp(flyApiToken, appName).catch((cleanupError: unknown) =>
            logger.warn({ err: cleanupError, appName }, `hosted: cleanup after failed provision failed; orphaned for the reaper`),
        );
        // The claim loop's race, one step later: this call's own app can't collide by name (that would fail at
        // createApp), so the winner's machine is the answer, not a failure.
        if (await alreadyProvisioned(prisma, args.sandboxId, error)) {
            throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
        }
        // Read as the same refusal whatever the cause, and latched briefly so the next arrivals skip the round trip;
        // logged at error because only an operator raising a quota fixes it.
        if (isFlyCapacity(error)) {
            noteProviderAtCapacity(region);
            logger.error({ err: error, region, appName }, `hosted: the provider has no machine left to give; the lane is full`);
            throw new HostedAtCapacity(AT_CAPACITY_MESSAGE);
        }
        throw error;
    }
};

// Explicit repair/update boundary: a plain stop/start can't fix a boot-crashing machine pinned to its original rootfs,
// so this replaces the full config while stopped, then wakes it as one metered transition.
export const refreshHosted = async (
    config: Config,
    args: HostedProvisionArgs,
    hosted: { appName: string; machineId: string; volumeId: string; image?: string | null; environmentHash?: string | null },
): Promise<void> => {
    // Keeps the machine's existing overlay; a moved base image is a rebuild's job (hosted-build.ts), not this call's.
    const overlay: HostedOverlay = { image: hosted.image ?? null, environmentHash: hosted.environmentHash ?? null };
    await updateMachine(
        config.hosted.flyApiToken,
        hosted.appName,
        hosted.machineId,
        hostedMachineConfig(config, args, hosted.appName, hosted.volumeId, overlay),
    );
    await startAfterUpdate(config, hosted);
};

// Tears the app down (machines and volume go with it); 404-tolerant by fly.ts's contract.
export const destroyHosted = async (config: Config, appName: string): Promise<void> => deleteApp(config.hosted.flyApiToken, appName);

// Drops the machine row and clears `daemonUrl`, so the browser reads "not connected" instead of reconnecting into a
// machine that's gone. `lastSeenAt` stays: it's what keeps this a workspace to reopen, not a fresh setup.
export const forgetHostedMachine = async (prisma: PrismaClient, hostedMachineId: string, sandboxId: string): Promise<void> => {
    await prisma.$transaction([
        prisma.hostedMachine.delete({ where: { id: hostedMachineId } }),
        prisma.sandbox.update({ where: { id: sandboxId }, data: { daemonUrl: null } }),
    ]);
};

// A cold provision runs app to volume to machine to row over minutes; inside this window it's in progress, not litter.
const REAP_GRACE_MS = 30 * 60 * 1000;

// Ceiling on one pass's destruction: a wrong database looks identical to a real orphan glut, so a pass wanting more
// than this stops and logs instead.
const REAP_MAX_APPS = 3;
const REAP_MAX_SHARE = 0.25;

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

// Everything the sweep needs about an unknown app, or undefined if Fly won't answer (read as "not now", not a verdict).
// Age is the oldest resource in the app, not the newest machine.
const appEvidence = async (config: Config, app: string): Promise<{ owner: AppOwner; oldestAt: Date | undefined; machines: number } | undefined> => {
    try {
        const machines = await listMachines(config.hosted.flyApiToken, app);
        const volumes = machines.length > 0 ? [] : await listVolumes(config.hosted.flyApiToken, app);
        const stamps = [...machines.map((machine) => machine.createdAt), ...volumes.map((volume) => volume.createdAt)].filter(
            (at): at is Date => at !== undefined,
        );
        return {
            owner: appOwner(machines, hostedInstanceId(config)),
            oldestAt: stamps.length === 0 ? undefined : new Date(Math.min(...stamps.map((at) => at.getTime()))),
            machines: machines.length,
        };
    } catch (error) {
        return isFlyGone(error) ? { owner: `mine`, oldestAt: undefined, machines: 0 } : undefined;
    }
};

// Why an app is left standing (order matters):
// 1. unreadable: Fly wouldn't answer; never a verdict
// 2. theirs: a machine names another deployment (checked first, and true regardless of age)
// 3. young: inside the grace window, likely mid-provision
// 4. unknown: has machines, none carrying a stamp; predates the stamp, left standing on purpose
// An app with no machines is not skipped: emptiness is its own evidence that it's collectable.
export type OrphanSkip = "theirs" | "unknown" | "young" | "unreadable";

const orphanVerdict = (evidence: Awaited<ReturnType<typeof appEvidence>>, now: number): OrphanSkip | undefined => {
    if (evidence === undefined) {
        return `unreadable`;
    }
    if (evidence.owner === `theirs`) {
        return `theirs`;
    }
    if (evidence.oldestAt !== undefined && now - evidence.oldestAt.getTime() < REAP_GRACE_MS) {
        return `young`;
    }
    if (evidence.machines === 0) {
        return undefined;
    }
    return evidence.owner === `mine` ? undefined : `unknown`;
};

// Sorts our-prefix apps the database can't explain into collectable and skipped-with-reason. Exported so the health
// watch reports the same verdicts the reaper acts on.
export const sortUnknownApps = async (
    config: Config,
    unknown: string[],
): Promise<{ doomed: string[]; skipped: { app: string; why: OrphanSkip }[] }> => {
    const now = Date.now();
    const doomed: string[] = [];
    const skipped: { app: string; why: OrphanSkip }[] = [];
    for (const app of unknown) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small read per unknown app, once a day
        const why = orphanVerdict(await appEvidence(config, app), now);
        if (why === undefined) {
            doomed.push(app);
        } else {
            skipped.push({ app, why });
        }
    }
    return { doomed, skipped };
};

// Destroys every our-prefix app with no row behind it, using ownership read from machine metadata (fly.ts) rather than
// the name, since a Fly org is shared by every deployment holding its credential. A young app is spared, and a pass
// wanting to destroy too much refuses outright.
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
    const { doomed, skipped } = await sortUnknownApps(
        config,
        names.filter((candidate) => !known.has(candidate)),
    );
    if (skipped.length > 0) {
        // One line an operator can act on: skipped apps are either somebody else's, or ours from before the stamp.
        logger.warn({ skipped }, `hosted reaper: apps left standing because this platform cannot prove they are its own`);
    }
    const ceiling = Math.max(REAP_MAX_APPS, Math.floor(names.length * REAP_MAX_SHARE));
    if (doomed.length > ceiling) {
        logger.error(
            { doomed: doomed.length, ceiling, ourApps: names.length, apps: doomed },
            `hosted reaper: refusing to destroy this many apps at once; the database, not the fleet, is the likely fault`,
        );
        return;
    }
    for (const name of doomed) {
        logger.warn({ app: name }, `hosted reaper: destroying orphaned app`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on the API; a handful at most
        await deleteApp(config.hosted.flyApiToken, name).catch((error: unknown) =>
            logger.error({ err: error, app: name }, `hosted reaper: destroying orphaned app failed; retried tomorrow`),
        );
    }
};
