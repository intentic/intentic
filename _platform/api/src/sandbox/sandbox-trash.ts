import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { RECOVERY_WINDOW_MS } from "../durations.js";
import { isFlyGone, stopMachine, updateMachine } from "./hosted/fly/fly.js";
import { hostedMachineConfig, withHostedSlot, type HostedProvisionArgs } from "./hosted/hosted.js";
import { closeHostedStretch } from "./hosted/hosted-usage.js";
import { lockHostedSandbox } from "./hosted/hosted-cleanup.js";
import { mintSandbox } from "./mint-sandbox.js";

/* THE OWNER HAS NO SANDBOX IN THE TRASH BY THAT ID. */
export class TrashedSandboxGone extends Error {}

/* What has to be written down for a restore to land on the same disk. */
interface TrashedMachine {
    readonly appName: string;
    readonly machineId: string;
    readonly volumeId: string;
    readonly region: string;
    readonly image: string | null;
    readonly baseImage: string | null;
    readonly environmentHash: string | null;
}

/* An own-machine sandbox names no provider resources; the columns exist for the hosted lane alone. */
const NO_MACHINE = { appName: null, machineId: null, volumeId: null, region: null, flyImage: null, baseImage: null, environmentHash: null };

const providerSnapshot = (hosted: TrashedMachine | null) =>
    hosted === null
        ? NO_MACHINE
        : {
              appName: hosted.appName,
              machineId: hosted.machineId,
              volumeId: hosted.volumeId,
              region: hosted.region,
              // `flyImage`, not `image`: the sandbox's own `image` column is the switcher's logo.
              flyImage: hosted.image,
              baseImage: hosted.baseImage,
              environmentHash: hosted.environmentHash,
          };

// Stopping is best-effort by design: a machine Fly no longer has is not an error, since the disk is what this
// protects and a machine that is already gone has nothing left to bill.
const stopForTrash = async (config: Config, logger: Logger, hosted: { appName: string; machineId: string }): Promise<void> => {
    await stopMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error: unknown) => {
        if (!isFlyGone(error)) {
            logger.error({ err: error, app: hosted.appName }, `could not stop a deleted sandbox's machine; it is kept anyway`);
        }
    });
};

// Deletes a sandbox the way the route used to, except that the provider teardown is not scheduled: the machine is
// stopped so it stops costing anybody anything, and its app, volume and overlay are written down so a restore can
// come back onto the same disk.
export const trashSandbox = async (prisma: PrismaClient, config: Config, logger: Logger, sandboxId: string): Promise<void> => {
    const sandbox = await prisma.sandbox.findUniqueOrThrow({ where: { id: sandboxId }, include: { hosted: true } });
    const { hosted } = sandbox;
    if (hosted !== null) {
        await stopForTrash(config, logger, hosted);
    }
    await prisma.$transaction(async (tx) => {
        await lockHostedSandbox(tx, sandboxId);
        if (hosted !== null) {
            await closeHostedStretch(tx, hosted, sandbox.ownerId);
        }
        await tx.sandboxTrash.create({
            data: {
                ownerId: sandbox.ownerId,
                name: sandbox.name,
                image: sandbox.image,
                ...providerSnapshot(hosted),
                purgeAfter: new Date(Date.now() + RECOVERY_WINDOW_MS),
            },
        });
        // The cascade takes HostedMachine with it; the app it named is now spoken for by the trash row above,
        // which is what keeps the orphan reaper off it.
        await tx.sandbox.delete({ where: { id: sandboxId } });
    });
};

export interface TrashedSummary {
    readonly id: string;
    readonly name: string;
    readonly image: string | null;
    readonly deletedAt: Date;
    readonly purgeAfter: Date;
    /** Whether restoring brings a machine and its disk back, or only the sandbox's name and address. */
    readonly hosted: boolean;
}

export const listTrash = async (prisma: PrismaClient, ownerId: string): Promise<TrashedSummary[]> => {
    const rows = await prisma.sandboxTrash.findMany({
        where: { ownerId, purgeAfter: { gt: new Date() } },
        orderBy: { deletedAt: `desc` },
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        image: row.image,
        deletedAt: row.deletedAt,
        purgeAfter: row.purgeAfter,
        hosted: row.appName !== null,
    }));
};

// Brings one back. The connect token died with the old row and is not recoverable, so a new sandbox identity is
// minted and pushed to the machine as a config replacement — which leaves a stopped machine stopped, so a restore
// costs no uptime and the ordinary wake path is what starts it.
export const restoreSandbox = async (prisma: PrismaClient, config: Config, ownerId: string, trashId: string) => {
    const row = await prisma.sandboxTrash.findUnique({ where: { id: trashId } });
    if (row === null || row.ownerId !== ownerId || row.purgeAfter <= new Date()) {
        throw new TrashedSandboxGone(`that sandbox is no longer recoverable`);
    }
    const { token, sandbox } = await mintSandbox(prisma, config, { name: row.name, ownerId });
    if (row.image !== null) {
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { image: row.image } });
    }
    if (row.appName === null || row.machineId === null || row.volumeId === null || row.region === null) {
        await prisma.sandboxTrash.delete({ where: { id: trashId } });
        return { sandbox: { ...sandbox, image: row.image } };
    }

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { email: true } });
    const args: HostedProvisionArgs = { sandboxId: sandbox.id, connectToken: token, ownerEmail: owner.email, region: row.region };
    // Under the owner's slot count like any other machine row: a week in the trash is not a way past the plan.
    const hosted = await withHostedSlot(prisma, config, args, row.appName, (tx) =>
        tx.hostedMachine.create({
            data: {
                sandboxId: sandbox.id,
                appName: row.appName as string,
                machineId: row.machineId as string,
                volumeId: row.volumeId as string,
                region: row.region as string,
                image: row.flyImage,
                baseImage: row.baseImage,
                environmentHash: row.environmentHash,
            },
        }),
    );
    await updateMachine(
        config.hosted.flyApiToken,
        row.appName,
        row.machineId,
        hostedMachineConfig(config, args, row.appName, row.volumeId, { image: row.flyImage, environmentHash: row.environmentHash }),
    );
    await prisma.sandboxTrash.delete({ where: { id: trashId } });
    return { sandbox: { ...sandbox, hosted, image: row.image } };
};

// Hands every expired row's app to the cleanup queue and drops the row. Kept separate from the queue itself so the
// two windows stay legible: this one is the owner's week, the queue's is a teardown that should already have run.
export const sweepSandboxTrash = async (prisma: PrismaClient): Promise<{ purged: number }> => {
    const expired = await prisma.sandboxTrash.findMany({ where: { purgeAfter: { lte: new Date() } }, select: { id: true, appName: true } });
    for (const row of expired) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small write per expired row, once a day
        await prisma.$transaction(async (tx) => {
            if (row.appName !== null) {
                await tx.hostedCleanup.upsert({ where: { appName: row.appName }, create: { appName: row.appName }, update: {} });
            }
            await tx.sandboxTrash.delete({ where: { id: row.id } });
        });
    }
    return { purged: expired.length };
};
