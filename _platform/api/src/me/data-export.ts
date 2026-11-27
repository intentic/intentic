import type { PrismaClient } from "@intentic/prisma";
import type { SessionUser } from "../context.js";
import { storedPreferences } from "./preferences.js";

/* THE ACCOUNT'S DATA EXPORT (GDPR access and portability): every row the platform holds about the caller, keyed by the
 * account or by its address, as one JSON document. Credentials stay out: session and OAuth tokens, a sandbox's connect
 * token, its setup and fix codes and setup payload, an API token's digest, a push device's token and secret, a build's
 * secret. Each is a key to something rather than a fact about the person, and an export is a file people mail around.
 * (2026-11-24) It once named identity, sessions, sandboxes and the hosted lane only, and left out the rest it held: the
 * address's organisations, trash, builds and migrations, trial and Repair usage, API tokens, wallets and payments, push
 * devices, project claims, and most of a sandbox's own columns. A new table that names a user or an address belongs here. */

// A sandbox as its owner's export shows it: what it is, where it answers, and what its machines reported of themselves.
const SANDBOX_FIELDS = {
    id: true,
    name: true,
    image: true,
    color: true,
    tunnelId: true,
    daemonUrl: true,
    daemonVersion: true,
    lastSeenAt: true,
    firstAnnouncedAt: true,
    firstTurnAt: true,
    personSeenAt: true,
    setupCodeClaimedAt: true,
    setupClaimedBy: true,
    setupReport: true,
    setupFailureEmailedAt: true,
    bootReport: true,
    hostReport: true,
    announceRefusal: true,
    seenInstances: true,
    duplicateSince: true,
    activeHost: true,
    removedAt: true,
    removedBy: true,
    orgId: true,
    createdAt: true,
    updatedAt: true,
    hosted: {
        select: {
            appName: true,
            region: true,
            tier: true,
            cpuKind: true,
            cpus: true,
            memoryMb: true,
            volumeGb: true,
            image: true,
            wokeAt: true,
            createdAt: true,
        },
    },
} as const;

// The hosted lane's rows about the account, as queries not yet awaited: the plan, the awake minutes (by owner, since a
// released machine's minutes stay on the account), where each machine was asked for from, the abuse watch's verdicts
// (each kept as long as it counts, retention.ts), and what happened to its machines: builds, moves, out-of-memory kills.
const hostedQueries = (prisma: PrismaClient, userId: string) => {
    const onOwnMachine = { machine: { sandbox: { ownerId: userId } } };
    return {
        hostedPlan: prisma.hostedPlan.findUnique({
            where: { userId },
            select: {
                status: true,
                currentPeriodEnd: true,
                cancelAtPeriodEnd: true,
                createdAt: true,
                items: { select: { tier: true, quantity: true } },
            },
        }),
        hostedUsage: prisma.hostedUsage.findMany({ where: { ownerId: userId }, select: { month: true, tier: true, minutes: true } }),
        hostedProvisions: prisma.hostedProvision.findMany({ where: { userId }, select: { ip: true, domain: true, appName: true, createdAt: true } }),
        hostedStrikes: prisma.hostedStrike.findMany({
            where: { userId },
            select: { appName: true, kind: true, measure: true, windowMinutes: true, action: true, createdAt: true },
        }),
        builds: prisma.hostedBuild.findMany({
            where: onOwnMachine,
            select: {
                id: true,
                machine: { select: { sandboxId: true } },
                state: true,
                baseImage: true,
                content: true,
                image: true,
                digest: true,
                exitCode: true,
                log: true,
                error: true,
                minutes: true,
                requestedBy: true,
                createdAt: true,
                finishedAt: true,
            },
        }),
        migrations: prisma.hostedMigration.findMany({
            where: onOwnMachine,
            select: {
                sandboxId: true,
                kind: true,
                fromTier: true,
                toTier: true,
                state: true,
                requestedBy: true,
                error: true,
                startedAt: true,
                finishedAt: true,
            },
        }),
        outOfMemory: prisma.hostedOom.findMany({ where: onOwnMachine, select: { sandboxId: true, tier: true, memoryMb: true, at: true } }),
    };
};

// Awaits every query of a record at once, each answer under its query's name.
const allOf = async <T extends Record<string, PromiseLike<unknown>>>(queries: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> => {
    const answers = await Promise.all(Object.entries(queries).map(async ([name, query]) => [name, await query] as const));
    // SAFETY: each entry is the awaited answer of the query under the same name, which is what the mapped type states.
    return Object.fromEntries(answers) as { [K in keyof T]: Awaited<T[K]> };
};

export const dataExportOf = async (prisma: PrismaClient, user: SessionUser) => {
    const userId = user.id;
    // Grants, invites and organisation seats are stored under the address, lowercased (invite.routes.ts, org.routes.ts).
    const email = user.email.toLowerCase();
    const { standing, ...rows } = await allOf({
        standing: prisma.user.findUnique({
            where: { id: userId },
            select: { hostedSuspendedAt: true, hostedSuspendedReason: true, preferences: true, termsAcceptedAt: true, termsVersion: true },
        }),
        sessions: prisma.session.findMany({ where: { userId }, select: { createdAt: true, expiresAt: true, ipAddress: true, userAgent: true } }),
        accounts: prisma.account.findMany({ where: { userId }, select: { providerId: true, accountId: true, scope: true, createdAt: true } }),
        sandboxes: prisma.sandbox.findMany({ where: { ownerId: userId }, select: SANDBOX_FIELDS }),
        // What the address holds in other people's sandboxes: grants, and invites not yet taken.
        memberships: prisma.sandboxMember.findMany({
            where: { email },
            select: { sandboxId: true, tier: true, manages: true, acceptedAt: true, inviteExpiresAt: true, createdAt: true },
        }),
        invitesSent: prisma.sandboxMember.findMany({
            where: { sandbox: { ownerId: userId } },
            select: { sandboxId: true, email: true, tier: true, acceptedAt: true, createdAt: true },
        }),
        organisations: prisma.orgMember.findMany({
            where: { email },
            select: { role: true, createdAt: true, org: { select: { id: true, name: true } } },
        }),
        ...hostedQueries(prisma, userId),
        trash: prisma.sandboxTrash.findMany({
            where: { ownerId: userId },
            select: { name: true, image: true, color: true, appName: true, region: true, tier: true, deletedAt: true, purgeAfter: true },
        }),
        trialUsage: prisma.trialUsage.findMany({
            where: { userId },
            select: { day: true, messages: true, lastModel: true, graceSteps: true, updatedAt: true },
        }),
        repairUsage: prisma.repairUsage.findMany({ where: { userId }, select: { day: true, turns: true, updatedAt: true } }),
        apiTokens: prisma.apiToken.findMany({
            where: { userId },
            select: { id: true, label: true, scope: true, createdAt: true, lastUsedAt: true, revokedAt: true },
        }),
        wallets: prisma.wallet.findMany({
            where: { userId },
            select: { network: true, address: true, providerWalletId: true, perPaymentMaxUsd: true, dailyCapUsd: true, createdAt: true },
        }),
        walletPayments: prisma.walletPayment.findMany({
            where: { userId },
            select: { day: true, amountUsd: true, host: true, payTo: true, createdAt: true },
        }),
        pushDevices: prisma.pushDevice.findMany({
            where: { userId },
            select: { platform: true, app: true, sandbox: true, createdAt: true, updatedAt: true },
        }),
        projectClaims: prisma.projectClaim.findMany({ where: { ownerId: userId }, select: { project: true, sandboxId: true, createdAt: true } }),
    });
    return {
        user,
        terms: { acceptedAt: standing?.termsAcceptedAt ?? null, version: standing?.termsVersion ?? null },
        hostedSuspended: standing?.hostedSuspendedAt ? { at: standing.hostedSuspendedAt, reason: standing.hostedSuspendedReason } : null,
        // The look and reading preferences kept with the account (preferences.ts).
        preferences: storedPreferences(standing?.preferences),
        ...rows,
    };
};
