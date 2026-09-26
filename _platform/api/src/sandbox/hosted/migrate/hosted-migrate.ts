import { sleep as pause } from "@intentic/base/async";
import { type HostedShape, type HostedTierId, hostedShapeLine, hostedTier } from "@intentic/constants";
import type { HostedMigration, PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { decryptSecret } from "../../../crypto.js";
import { MINUTE_MS } from "../../../durations.js";
import {
    createMachine,
    createVolume,
    createVolumeSnapshot,
    destroyMachine,
    destroyVolume,
    extendVolume,
    flySandboxRole,
    getMachine,
    getVolume,
    isFlyCapacity,
    listVolumeSnapshots,
    stopMachine,
    updateMachine,
} from "../fly/fly.js";
import { HostedAtCapacity, AT_CAPACITY_MESSAGE, noteProviderAtCapacity, providerWords } from "../hosted-capacity.js";
import { withHostedAppLock } from "../hosted-app-lock.js";
import { hostedEnabled, hostedInstanceId, hostedMachineConfig, type HostedProvisionArgs, startAfterUpdate } from "../hosted.js";
import { hostedShapeFor, sameShape, shapeOfRow } from "../hosted-shape.js";
import { runningImageOf } from "../gate/state-gate.js";

/* MOVING A SANDBOX FROM ONE MACHINE TO ANOTHER, and being able to undo it.
 *
 * Two operations, and the difference is whether any data moves.
 *
 * A RESIZE replaces the guest where it stands: same app, same volume, same host, one restart, and the disk grown
 * first if the rung it is going to has more. Seconds, and nothing is copied.
 *
 * A MOVE builds a new volume from a fork or a snapshot and a new machine on it. It is what a region change needs, and
 * what a host with no room for the bigger guest leaves as the only way up. The APP does not change, so the hostname,
 * the connect token, the edge's replay and the app name are all untouched: from outside, the sandbox is where it was.
 *
 * The safety rule is one sentence, and every step below is arranged around it: THE OLD DISK IS DESTROYED ONLY AFTER
 * THE NEW MACHINE HAS ANNOUNCED ITSELF ON THE NEW ONE. Before that, any failure destroys what this run built and
 * starts the original back up. A snapshot is taken before anything happens at all and outlives even the rollback, so
 * the disk as it was is recoverable after the machine has already been put back.
 *
 * Downgrades never shrink the disk. Fly volumes grow and never shrink, and a snapshot restores only into an
 * equal-or-larger volume, so the only way down is a file-level copy. Keeping the bigger disk costs $0.15 a GB a month
 * and removes the whole class of failure. */

export const MIGRATION_KINDS = ["resize", "move"] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

// planned → snapshotting → applying → verifying → done, or off to failed/rolledBack. Anything but the last three is
// a run still in flight, which is what the sweep and the `migratingId` lock read.
export const MIGRATION_STATES = ["planned", "snapshotting", "applying", "verifying", "done", "failed", "rolledBack"] as const;
export type MigrationState = (typeof MIGRATION_STATES)[number];

const TERMINAL: ReadonlySet<string> = new Set<MigrationState>([`done`, `failed`, `rolledBack`]);

export const isMigrationOver = (state: string): boolean => TERMINAL.has(state);

/* WHY A MIGRATION WAS NOT STARTED, in the words the route and the card show. Every code means nothing was spent. */
export type MigrationRefusal = "off" | "no-machine" | "busy" | "nothing-to-do" | "unknown-tier" | "capacity";

export class HostedMigrationRefused extends Error {
    readonly code: MigrationRefusal;

    constructor(code: MigrationRefusal, message: string) {
        super(message);
        this.code = code;
    }
}

// A snapshot Fly has scheduled but not finished; polled until it is `created`, because restoring from one that is
// still `running` restores nothing. Generous, since a big disk takes minutes.
const SNAPSHOT_DEADLINE_MS = 10 * MINUTE_MS;
const SNAPSHOT_POLL_MS = 5_000;

// Announce after a restart or a fresh boot. A move's machine may pull the image onto a new host first, which is the
// same minutes a cold provision spends; past this a real person would already have written in.
const ANNOUNCE_DEADLINE_MS = 12 * MINUTE_MS;
const ANNOUNCE_POLL_MS = 5_000;

// A run whose process died leaves a row in flight and the machine locked. The sweep frees both past this, and cleans
// up whatever the dead run had built, since nothing unfinished is ever the truth.
const STUCK_AFTER_MS = 45 * MINUTE_MS;

/** Where a machine is going: the rung, the shape it implies, and the region, which only a move can change. */
export interface MigrationTarget {
    readonly tier: HostedTierId;
    readonly region?: string;
}

export interface MigrationPlan {
    readonly kind: MigrationKind;
    readonly from: { readonly tier: HostedTierId; readonly shape: HostedShape; readonly region: string };
    readonly to: { readonly tier: HostedTierId; readonly shape: HostedShape; readonly region: string };
}

/** The machine as this module needs it: its identity on Fly, its shape, and the sandbox it belongs to. */
export interface MigratableMachine {
    readonly id: string;
    readonly sandboxId: string;
    readonly appName: string;
    readonly machineId: string;
    readonly volumeId: string;
    readonly region: string;
    readonly tier: string;
    readonly cpuKind: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly volumeGb: number;
    readonly image: string | null;
    readonly environmentHash: string | null;
    readonly migratingId: string | null;
    readonly buildingId: string | null;
    readonly sandbox: { readonly token: string; readonly owner: { readonly email: string } };
}

/**
 * What changing this machine to that rung actually involves. A region change is the one thing a resize cannot do, so
 * it decides the kind; the disk takes the larger of what it has and what the rung asks for, because it cannot shrink.
 */
export const planMigration = (config: Config, machine: MigratableMachine, target: MigrationTarget): MigrationPlan => {
    const from = { tier: hostedTier(machine.tier).id, shape: shapeOfRow(machine), region: machine.region };
    const rung = hostedShapeFor(config, target.tier);
    const region = target.region ?? machine.region;
    return {
        kind: region === machine.region ? `resize` : `move`,
        from,
        to: {
            tier: target.tier,
            shape: { ...rung, volumeGb: Math.max(from.shape.volumeGb, rung.volumeGb) },
            region,
        },
    };
};

/** Whether a plan would change anything at all; an unchanged machine is refused rather than restarted for nothing. */
export const planChangesNothing = (plan: MigrationPlan): boolean =>
    plan.from.tier === plan.to.tier && plan.from.region === plan.to.region && sameShape(plan.from.shape, plan.to.shape);

const provisionArgsOf = (config: Config, machine: MigratableMachine, tier: HostedTierId): HostedProvisionArgs => ({
    sandboxId: machine.sandboxId,
    connectToken: decryptSecret(config, machine.sandbox.token),
    ownerEmail: machine.sandbox.owner.email,
    region: machine.region,
    tier,
});

/** How a wait passes the time; the suites hand in one that does not, so a poll loop cannot outlive a test. */
export type Sleep = (ms: number) => Promise<void>;

/* WAITS FOR THE SNAPSHOT TO EXIST, not merely to be scheduled: a restore from one still running restores nothing.
 * Bounded by a count of attempts rather than the clock, so a stubbed sleep cannot spin forever. */
const awaitSnapshot = async (config: Config, appName: string, volumeId: string, snapshotId: string, sleep: Sleep): Promise<void> => {
    for (let attempt = 0; attempt < Math.ceil(SNAPSHOT_DEADLINE_MS / SNAPSHOT_POLL_MS); attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
        const snapshots = await listVolumeSnapshots(config.hosted.flyApiToken, appName, volumeId);
        if (snapshots.find((snapshot) => snapshot.id === snapshotId)?.status === `created`) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(SNAPSHOT_POLL_MS);
    }
    throw new Error(`the pre-flight snapshot ${snapshotId} was still not finished after ${SNAPSHOT_DEADLINE_MS / MINUTE_MS} minutes`);
};

/**
 * Waits for the daemon to say it is up, which is the one signal that proves both halves at once: the machine booted
 * AND the workspace volume it booted onto is the workspace. `mark` is what `lastSeenAt` read before the restart, so a
 * stale announce from before cannot be mistaken for this one.
 */
const awaitAnnounce = async (prisma: PrismaClient, sandboxId: string, mark: Date | null, sleep: Sleep): Promise<void> => {
    for (let attempt = 0; attempt < Math.ceil(ANNOUNCE_DEADLINE_MS / ANNOUNCE_POLL_MS); attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll loop is the shape of this wait
        const row = await prisma.sandbox.findUnique({ where: { id: sandboxId }, select: { lastSeenAt: true } });
        const seen = row?.lastSeenAt ?? null;
        if (seen !== null && seen.getTime() !== (mark?.getTime() ?? 0)) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(ANNOUNCE_POLL_MS);
    }
    throw new Error(`the sandbox did not announce itself within ${ANNOUNCE_DEADLINE_MS / MINUTE_MS} minutes of the machine being changed`);
};

const setState = async (prisma: PrismaClient, id: string, state: MigrationState, data: Record<string, unknown> = {}): Promise<void> => {
    await prisma.hostedMigration.update({ where: { id }, data: { state, ...data } });
};

/* CLAIMS THE MACHINE AND WRITES THE ROW, atomically: `migratingId` is the lock, so two callers cannot both start one. */
const openMigration = async (
    prisma: PrismaClient,
    machine: MigratableMachine,
    plan: MigrationPlan,
    requestedBy: string,
): Promise<HostedMigration> =>
    prisma.$transaction(async (tx) => {
        const fresh = await tx.hostedMachine.findUniqueOrThrow({ where: { id: machine.id }, select: { migratingId: true, buildingId: true } });
        if (fresh.migratingId !== null) {
            throw new HostedMigrationRefused(`busy`, `this sandbox's machine is already being changed; wait for that to finish`);
        }
        if (fresh.buildingId !== null) {
            throw new HostedMigrationRefused(`busy`, `this sandbox is building its environment; wait for that to finish`);
        }
        const row = await tx.hostedMigration.create({
            data: {
                hostedMachineId: machine.id,
                sandboxId: machine.sandboxId,
                kind: plan.kind,
                fromTier: plan.from.tier,
                toTier: plan.to.tier,
                fromCpuKind: plan.from.shape.cpuKind,
                fromCpus: plan.from.shape.cpus,
                fromMemoryMb: plan.from.shape.memoryMb,
                fromVolumeGb: plan.from.shape.volumeGb,
                toCpuKind: plan.to.shape.cpuKind,
                toCpus: plan.to.shape.cpus,
                toMemoryMb: plan.to.shape.memoryMb,
                toVolumeGb: plan.to.shape.volumeGb,
                requestedBy,
                ...(plan.kind === `move` ? { oldMachineId: machine.machineId, oldVolumeId: machine.volumeId } : {}),
            },
        });
        await tx.hostedMachine.update({ where: { id: machine.id }, data: { migratingId: row.id } });
        return row;
    });

/* THE SHAPE AND RUNG THE MACHINE ROW NOW CARRIES, plus whatever a move changed about where it lives. */
const commitMigration = async (
    prisma: PrismaClient,
    machineRowId: string,
    migrationId: string,
    plan: MigrationPlan,
    moved?: { machineId: string; volumeId: string },
): Promise<void> => {
    await prisma.$transaction([
        prisma.hostedMachine.update({
            where: { id: machineRowId },
            data: {
                tier: plan.to.tier,
                ...plan.to.shape,
                region: plan.to.region,
                migratingId: null,
                ...(moved === undefined ? {} : { machineId: moved.machineId, volumeId: moved.volumeId }),
            },
        }),
        prisma.hostedMigration.update({
            where: { id: migrationId },
            data: { state: `done`, finishedAt: new Date(), ...(moved === undefined ? {} : { newMachineId: moved.machineId, newVolumeId: moved.volumeId }) },
        }),
    ]);
};

const closeFailed = async (prisma: PrismaClient, machineRowId: string, migrationId: string, state: MigrationState, error: unknown): Promise<void> => {
    await prisma.$transaction([
        prisma.hostedMachine.update({ where: { id: machineRowId }, data: { migratingId: null } }),
        prisma.hostedMigration.update({
            where: { id: migrationId },
            data: { state, finishedAt: new Date(), error: error instanceof Error ? error.message : `the migration failed` },
        }),
    ]);
};

/* GROWS THE DISK AND REPLACES THE GUEST, then starts and waits to be told it came up. Same volume throughout. */
const applyResize = async (prisma: PrismaClient, config: Config, machine: MigratableMachine, plan: MigrationPlan, sleep: Sleep): Promise<void> => {
    const { flyApiToken } = config.hosted;
    if (plan.to.shape.volumeGb > plan.from.shape.volumeGb) {
        await extendVolume(flyApiToken, machine.appName, machine.volumeId, plan.to.shape.volumeGb);
    }
    const args = provisionArgsOf(config, machine, plan.to.tier);
    const overlay = { image: machine.image, environmentHash: machine.environmentHash };
    const mark = (await prisma.sandbox.findUnique({ where: { id: machine.sandboxId }, select: { lastSeenAt: true } }))?.lastSeenAt ?? null;
    await updateMachine(
        flyApiToken,
        machine.appName,
        machine.machineId,
        hostedMachineConfig(config, args, machine.appName, machine.volumeId, overlay, undefined, plan.to.shape),
    );
    await startAfterUpdate(config, machine);
    await awaitAnnounce(prisma, machine.sandboxId, mark, sleep);
};

// Puts the old guest back on the machine it never left. The disk keeps whatever size it was grown to, which is
// harmless: a smaller guest on a bigger disk is a working machine, and shrinking it is not a thing Fly does.
const undoResize = async (config: Config, machine: MigratableMachine, plan: MigrationPlan): Promise<void> => {
    const args = provisionArgsOf(config, machine, plan.from.tier);
    const overlay = { image: machine.image, environmentHash: machine.environmentHash };
    await updateMachine(
        config.hosted.flyApiToken,
        machine.appName,
        machine.machineId,
        hostedMachineConfig(config, args, machine.appName, machine.volumeId, overlay, undefined, plan.from.shape),
    );
    await startAfterUpdate(config, machine);
};

/** What a move built, which is also what its rollback has to take away again. */
interface Built {
    readonly machineId: string;
    readonly volumeId: string;
}

/**
 * Builds the other half: a new volume from this machine's own disk, and a new machine on it. The old machine is
 * stopped first, so the copy is taken from a filesystem nobody is writing to rather than from one mid-write.
 *
 * Same region forks the volume block for block, which is fast and needs no snapshot; another region cannot, so it
 * restores the pre-flight snapshot instead. Either way the new volume asks for a host with room for the new guest,
 * because a volume placed without that hint is how a move discovers the host cannot take the machine.
 */
const applyMove = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: MigratableMachine,
    plan: MigrationPlan,
    snapshotId: string | undefined,
    sleep: Sleep,
): Promise<Built> => {
    const { flyApiToken } = config.hosted;
    // A refused stop is fine only for a machine already stopped; forking a disk still being written copies it torn.
    await stopMachine(flyApiToken, machine.appName, machine.machineId).catch(async (error: unknown) => {
        const { state } = await getMachine(flyApiToken, machine.appName, machine.machineId);
        if (state !== `stopped`) {
            throw error;
        }
    });
    const sameRegion = plan.to.region === machine.region;
    if (!sameRegion && snapshotId === undefined) {
        throw new Error(`a move to another region needs the pre-flight snapshot, and this run has none`);
    }
    const { volumeId } = await createVolume(flyApiToken, machine.appName, plan.to.region, plan.to.shape.volumeGb, {
        ...(sameRegion ? { sourceVolumeId: machine.volumeId } : { snapshotId: snapshotId as string }),
        compute: { cpuKind: plan.to.shape.cpuKind, cpus: plan.to.shape.cpus, memoryMb: plan.to.shape.memoryMb },
        ...(config.hosted.snapshotRetentionDays === 0 ? {} : { snapshotRetention: config.hosted.snapshotRetentionDays }),
    });
    const args = provisionArgsOf(config, machine, plan.to.tier);
    const overlay = { image: machine.image, environmentHash: machine.environmentHash };
    const mark = (await prisma.sandbox.findUnique({ where: { id: machine.sandboxId }, select: { lastSeenAt: true } }))?.lastSeenAt ?? null;
    try {
        const { machineId } = await createMachine(flyApiToken, machine.appName, {
            // Fly names machines per app, and the old one still holds the app's name until it is destroyed.
            name: `${machine.appName}-next`,
            region: plan.to.region,
            config: {
                ...hostedMachineConfig(config, args, machine.appName, volumeId, overlay, undefined, plan.to.shape),
                metadata: flySandboxRole(machine.sandboxId, hostedInstanceId(config), machine.sandbox.owner.email),
            },
        });
        await awaitAnnounce(prisma, machine.sandboxId, mark, sleep);
        return { machineId, volumeId };
    } catch (error) {
        // The volume is this run's alone and holds a copy, never the original; dropping it loses nothing.
        await destroyVolume(flyApiToken, machine.appName, volumeId).catch((cleanupError: unknown) =>
            logger.error(
                { err: cleanupError, app: machine.appName, volumeId },
                `hosted migrate: the copy this failed move made would not go away; nothing else collects it`,
            ),
        );
        throw error;
    }
};

/**
 * Runs one migration start to finish, and undoes it on any failure before the swap. Throws
 * HostedMigrationRefused where nothing was spent, and the underlying error where something was and has been undone.
 */
export const migrateHosted = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: MigratableMachine,
    target: MigrationTarget,
    requestedBy: string,
    sleep: Sleep = pause,
): Promise<HostedMigration> => {
    if (!hostedEnabled(config)) {
        throw new HostedMigrationRefused(`off`, `this platform does not run hosted machines`);
    }
    const plan = planMigration(config, machine, target);
    if (planChangesNothing(plan)) {
        throw new HostedMigrationRefused(`nothing-to-do`, `this sandbox is already on ${hostedShapeLine(plan.to.shape)}`);
    }
    const row = await openMigration(prisma, machine, plan, requestedBy);
    const locked = await withHostedAppLock(config, machine.appName, true, async () => {
        let snapshotId: string | undefined;
        // Whether anything about the machine has actually been changed yet. A run that fails while still taking its
        // snapshot has nothing to undo, and restarting the machine to "put it back" would be the only harm done.
        let applied = false;
        // The version a stock machine runs, pinned for everything below: a resize or a move changes where and on what
        // the sandbox runs, never which version, so it has no stored state to convert (gate/state-gate.ts). An
        // overlay machine names its own image already.
        let pinned = machine;
        try {
            pinned = machine.image === null ? { ...machine, image: await runningImageOf(config, machine) } : machine;
            // Before anything: the disk as it is now, recoverable even after a rollback has put the machine back.
            await setState(prisma, row.id, `snapshotting`);
            const snapshot = await createVolumeSnapshot(config.hosted.flyApiToken, machine.appName, machine.volumeId);
            await awaitSnapshot(config, machine.appName, machine.volumeId, snapshot.id, sleep);
            snapshotId = snapshot.id;
            await setState(prisma, row.id, `applying`, { snapshotId });

            if (plan.kind === `resize`) {
                applied = true;
                await applyResize(prisma, config, pinned, plan, sleep);
                await setState(prisma, row.id, `verifying`);
                await commitMigration(prisma, machine.id, row.id, plan);
                logger.info({ app: machine.appName, from: plan.from.tier, to: plan.to.tier }, `hosted migrate: resized in place`);
                return prisma.hostedMigration.findUniqueOrThrow({ where: { id: row.id } });
            }

            applied = true;
            const built = await applyMove(prisma, config, logger, pinned, plan, snapshotId, sleep);
            await setState(prisma, row.id, `verifying`, { newMachineId: built.machineId, newVolumeId: built.volumeId });
            // The swap, and only now: the new machine has said it is up on the new disk.
            await commitMigration(prisma, machine.id, row.id, plan, built);
            // Best effort, and logged rather than thrown: the sandbox is already living on the new pair, and litter
            // inside a live app is the orphan sweep's to notice, not a reason to fail a migration that worked.
            await destroyMachine(config.hosted.flyApiToken, machine.appName, machine.machineId, { force: true }).catch((error: unknown) =>
                logger.error({ err: error, app: machine.appName, machineId: machine.machineId }, `hosted migrate: the old machine would not go away`),
            );
            await destroyVolume(config.hosted.flyApiToken, machine.appName, machine.volumeId).catch((error: unknown) =>
                logger.error({ err: error, app: machine.appName, volumeId: machine.volumeId }, `hosted migrate: the old volume would not go away`),
            );
            logger.info({ app: machine.appName, from: plan.from.region, to: plan.to.region }, `hosted migrate: moved`);
            return prisma.hostedMigration.findUniqueOrThrow({ where: { id: row.id } });
        } catch (error) {
            if (isFlyCapacity(error)) {
                noteProviderAtCapacity(plan.to.region, providerWords(error));
            }
            const undone =
                applied &&
                (await rollback(config, logger, pinned, plan).then(
                    () => true,
                    (failure: unknown) => {
                        logger.error({ err: failure, app: machine.appName }, `hosted migrate: putting the machine back failed; it needs a person`);
                        return false;
                    },
                ));
            // `rolledBack` means something was changed and put back; `failed` means nothing was changed at all.
            await closeFailed(prisma, machine.id, row.id, undone ? `rolledBack` : `failed`, error);
            logger.error({ err: error, app: machine.appName, undone }, `hosted migrate: failed`);
            throw isFlyCapacity(error) ? new HostedAtCapacity(AT_CAPACITY_MESSAGE) : error;
        }
    });
    // withHostedAppLock answers undefined only when asked not to wait; this call waits.
    return locked as HostedMigration;
};

// Puts the machine back as it was. A resize restores the old guest; a move never touched the original, so it only has
// to be started again. Nothing here destroys anything of the original's, which is the point.
const rollback = async (config: Config, logger: Logger, machine: MigratableMachine, plan: MigrationPlan): Promise<void> => {
    if (plan.kind === `resize`) {
        await undoResize(config, machine, plan);
        return;
    }
    logger.warn({ app: machine.appName }, `hosted migrate: the move failed; starting the original machine again`);
    await startAfterUpdate(config, machine);
};

/** One machine's migrations, newest first: what the Billing page shows while one runs and after it ends. */
export const hostedMigrationsOf = async (prisma: PrismaClient, sandboxId: string, take = 5): Promise<HostedMigration[]> =>
    prisma.hostedMigration.findMany({ where: { sandboxId }, orderBy: { startedAt: `desc` }, take });

/** When this sandbox's disk was last copied somewhere it would survive the machine, or undefined if never. */
export const lastHostedBackupAt = async (config: Config, machine: { appName: string; volumeId: string }): Promise<Date | undefined> => {
    const snapshots = await listVolumeSnapshots(config.hosted.flyApiToken, machine.appName, machine.volumeId);
    return snapshots.find((snapshot) => snapshot.status === `created`)?.createdAt;
};

/**
 * Frees a machine a dead run left locked, and takes away what that run had built. A half-finished move holds a new
 * machine and a new volume that nothing will ever swap to, and both cost money inside an app the orphan sweep will
 * never touch, because the app itself is somebody's. Never finishes the work: this cannot know where it got to.
 */
export const sweepHostedMigrations = async (prisma: PrismaClient, config: Config, logger: Logger, now: Date = new Date()): Promise<number> => {
    if (!hostedEnabled(config)) {
        return 0;
    }
    const stuck = await prisma.hostedMigration.findMany({
        where: { state: { notIn: [`done`, `failed`, `rolledBack`] }, startedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
        include: { machine: { select: { id: true, appName: true } } },
    });
    for (const row of stuck) {
        logger.error(
            { migration: row.id, app: row.machine.appName, state: row.state, startedAt: row.startedAt },
            `hosted migrate: a run stopped without finishing; freeing the machine and collecting what it built`,
        );
        if (row.newMachineId !== null) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential teardown, gentle on a rate-limited API
            await destroyMachine(config.hosted.flyApiToken, row.machine.appName, row.newMachineId, { force: true }).catch((error: unknown) =>
                logger.error({ err: error, machineId: row.newMachineId }, `hosted migrate: collecting an abandoned machine failed`),
            );
        }
        if (row.newVolumeId !== null) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await destroyVolume(config.hosted.flyApiToken, row.machine.appName, row.newVolumeId).catch((error: unknown) =>
                logger.error({ err: error, volumeId: row.newVolumeId }, `hosted migrate: collecting an abandoned volume failed`),
            );
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await closeFailed(prisma, row.machine.id, row.id, `failed`, new Error(`the run stopped in "${row.state}" and was collected`));
    }
    return stuck.length;
};

/** How full this machine's disk is, for a page that wants to say so before offering a bigger one. */
export const hostedDiskUse = async (config: Config, machine: { appName: string; volumeId: string }): Promise<{ sizeGb: number; usedBytes: number | undefined }> => {
    const volume = await getVolume(config.hosted.flyApiToken, machine.appName, machine.volumeId);
    return { sizeGb: volume.sizeGb, usedBytes: volume.usedBytes };
};
