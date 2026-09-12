import { Prisma, type PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { encryptSecret } from "../../crypto.js";
import { connectTokenIdentity, mintConnectToken } from "../mint-sandbox.js";
import { appExists, deleteApp } from "./fly/fly.js";
import { withHostedAppLock } from "./hosted-app-lock.js";
import { closeHostedStretch } from "./hosted-usage.js";

export class HostedProvisionCancelled extends Error {
    constructor() {
        super(`hosted setup was cancelled`);
    }
}

export class HostedAlreadyProvisioned extends Error {}

// Identity rotation revokes both a provision in flight and the old daemon's announcements.
export const assertHostedIdentity = async (prisma: Prisma.TransactionClient, sandboxId: string, connectToken: string): Promise<void> => {
    const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId }, select: { tokenDigest: true } });
    if (sandbox?.tokenDigest !== sha256Hex(connectToken)) {
        throw new HostedProvisionCancelled();
    }
};

// Release and the final machine handoff must agree on one sandbox identity atomically.
export const lockHostedSandbox = async (tx: Prisma.TransactionClient, sandboxId: string): Promise<void> => {
    await tx.$queryRaw`SELECT id FROM sandbox WHERE id = ${sandboxId} FOR UPDATE`;
};

const cleanupApp = async (prisma: PrismaClient, config: Config, appName: string): Promise<void> => {
    // A committed handoff may outlive a lost transaction response.
    if ((await prisma.hostedCleanup.findUnique({ where: { appName } })) === null) {
        return;
    }
    await deleteApp(config.hosted.flyApiToken, appName);
    if (await appExists(config.hosted.flyApiToken, appName)) {
        throw new Error(`hosted app deletion is still pending`);
    }
    await prisma.hostedPoolMachine.deleteMany({ where: { appName, state: `claimed` } });
    await prisma.hostedCleanup.deleteMany({ where: { appName } });
};

// A cleanup record exists before any provider write and disappears only with a committed handoff or confirmed deletion.
export const withHostedApp = async <T>(
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    args: { sandboxId: string; connectToken: string },
    appName: string,
    work: () => Promise<T>,
): Promise<T> => {
    const result = await withHostedAppLock(config, appName, true, async () => {
        const existing = await prisma.hostedMachine.findUnique({ where: { appName } });
        if (existing !== null) {
            if (existing.sandboxId === args.sandboxId) {
                throw new HostedAlreadyProvisioned(`this sandbox already has a machine`);
            }
            throw new Error(`this app belongs to another sandbox`);
        }
        await prisma.hostedCleanup.create({ data: { appName } });
        try {
            await assertHostedIdentity(prisma, args.sandboxId, args.connectToken);
            return { value: await work() };
        } catch (error) {
            await cleanupApp(prisma, config, appName).catch((cleanupError: unknown) =>
                logger.error({ err: cleanupError, app: appName }, `hosted cleanup failed; durable retry pending`),
            );
            throw error;
        }
    });
    if (result === undefined) {
        throw new HostedProvisionCancelled();
    }
    return result.value;
};

export const releaseHosted = async (prisma: PrismaClient, config: Config, sandboxId: string): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        await lockHostedSandbox(tx, sandboxId);
        const sandbox = await tx.sandbox.findUniqueOrThrow({ where: { id: sandboxId }, include: { hosted: true } });
        if (sandbox.hosted !== null) {
            await tx.hostedCleanup.upsert({ where: { appName: sandbox.hosted.appName }, create: { appName: sandbox.hosted.appName }, update: {} });
            await closeHostedStretch(tx, sandbox.hosted, sandbox.ownerId);
            await tx.hostedMachine.delete({ where: { id: sandbox.hosted.id } });
        }
        const token = mintConnectToken();
        await tx.sandbox.update({
            where: { id: sandboxId },
            data: {
                token: encryptSecret(config, token),
                ...connectTokenIdentity(token),
                daemonUrl: null,
                lastSeenAt: null,
                setupCode: null,
                setupCodeExpiresAt: null,
                setupCodeClaimedAt: null,
                setupPayload: Prisma.DbNull,
                setupReport: Prisma.DbNull,
                bootReport: Prisma.DbNull,
                announceRefusal: Prisma.DbNull,
            },
        });
    });
};

export const reconcileHostedCleanup = async (prisma: PrismaClient, config: Config, logger: Logger): Promise<void> => {
    const pending = await prisma.hostedCleanup.findMany({ orderBy: { createdAt: `asc` } });
    for (const { appName } of pending) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- provider teardowns are sequential and skip active provisions
        await withHostedAppLock(config, appName, false, () => cleanupApp(prisma, config, appName)).catch((error: unknown) =>
            logger.error({ err: error, app: appName }, `hosted cleanup failed; durable retry pending`),
        );
    }
};

export const kickHostedCleanup = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (config.hosted.flyApiToken === ``) {
        return;
    }
    void reconcileHostedCleanup(prisma, config, logger).catch((error: unknown) => logger.error({ err: error }, `hosted cleanup sweep failed`));
};

export const startHostedCleanup = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    kickHostedCleanup(prisma, config, logger);
    setInterval(() => kickHostedCleanup(prisma, config, logger), 60_000);
};
