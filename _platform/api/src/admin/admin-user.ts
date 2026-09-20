import type { AdminUserDetail, AnnounceRefusal, BootReport, SetupReport } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { DAY_MS } from "../durations.js";

/* THE SUPPORT PAGE — one account, everything operational the platform knows, assembled so "it doesn't work" is answerable without psql. */

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

// Enough strikes to read a pattern; the ledger keeps more.
const STRIKES = 20;

export const adminUserDetail = async (
    prisma: PrismaClient,
    idOrEmail: string,
    now: () => Date = () => new Date(),
): Promise<AdminUserDetail | null> => {
    const needle = idOrEmail.trim();
    const user = await prisma.user.findFirst({
        where: { OR: [{ id: needle }, { email: { equals: needle, mode: `insensitive` } }] },
        select: { id: true, email: true, name: true, image: true, createdAt: true, termsVersion: true, hostedSuspendedAt: true, hostedSuspendedReason: true },
    });
    if (user === null) {
        return null;
    }
    const at = now();
    const week = Array.from({ length: 7 }, (_, index) => utcDayOf(new Date(at.getTime() - (6 - index) * DAY_MS)));
    const month = at.toISOString().slice(0, 7);
    const memberEmail = user.email.toLowerCase();

    const [sessions, accounts, plan, trialRows, hostedRows, wallets, sandboxes, memberships, strikes] = await Promise.all([
        prisma.session.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: `desc` },
            take: 5,
            select: { createdAt: true, expiresAt: true, ipAddress: true, userAgent: true },
        }),
        prisma.account.findMany({ where: { userId: user.id }, select: { providerId: true } }),
        prisma.hostedPlan.findUnique({ where: { userId: user.id }, select: { status: true, currentPeriodEnd: true } }),
        prisma.trialUsage.findMany({
            where: { userId: user.id, day: { in: week } },
            orderBy: { day: `desc` },
            select: { day: true, messages: true, lastModel: true },
        }),
        prisma.hostedUsage.aggregate({ where: { month, sandbox: { ownerId: user.id } }, _sum: { minutes: true } }),
        prisma.wallet.findMany({
            where: { userId: user.id },
            select: { id: true, network: true, address: true, perPaymentMaxUsd: true, dailyCapUsd: true },
        }),
        prisma.sandbox.findMany({
            where: { ownerId: user.id },
            orderBy: { createdAt: `desc` },
            select: {
                id: true,
                name: true,
                createdAt: true,
                lastSeenAt: true,
                daemonUrl: true,
                setupCodeClaimedAt: true,
                setupReport: true,
                bootReport: true,
                announceRefusal: true,
                hosted: { select: { region: true, appName: true, wokeAt: true, idleWarnedAt: true } },
                members: { select: { email: true, role: true, acceptedAt: true } },
            },
        }),
        prisma.sandboxMember.findMany({
            where: { email: memberEmail },
            select: { role: true, acceptedAt: true, sandbox: { select: { name: true, owner: { select: { email: true } } } } },
        }),
        prisma.hostedStrike.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: `desc` },
            take: STRIKES,
            select: { appName: true, kind: true, measure: true, windowMinutes: true, action: true, createdAt: true },
        }),
    ]);

    // Payment counts per wallet, bounded by the wallet count (one per network).
    const paymentCounts = await Promise.all(
        wallets.map((wallet) =>
            prisma.walletPayment.count({ where: { walletId: wallet.id, createdAt: { gte: new Date(at.getTime() - 30 * DAY_MS) } } }),
        ),
    );

    return {
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            createdAt: user.createdAt.toISOString(),
            termsVersion: user.termsVersion,
        },
        sessions: sessions.map((session) => ({
            createdAt: session.createdAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
            ipAddress: session.ipAddress,
            userAgent: session.userAgent,
        })),
        providers: [...new Set(accounts.map((account) => account.providerId))],
        plan: plan ? { status: plan.status, currentPeriodEnd: plan.currentPeriodEnd.toISOString() } : null,
        trialDays: trialRows,
        hostedMonthMinutes: hostedRows._sum.minutes ?? 0,
        hostedSuspended: user.hostedSuspendedAt ? { at: user.hostedSuspendedAt.toISOString(), reason: user.hostedSuspendedReason ?? `` } : null,
        // The rows are written by the watch with these words; an unknown one is a bug there, not a page to blank.
        strikes: strikes.map((strike) => ({
            appName: strike.appName,
            kind: strike.kind === `egress` ? (`egress` as const) : (`cpu` as const),
            measure: strike.measure,
            windowMinutes: strike.windowMinutes,
            action: strike.action === `suspended` ? (`suspended` as const) : strike.action === `reported` ? (`reported` as const) : (`stopped` as const),
            at: strike.createdAt.toISOString(),
        })),
        wallets: wallets.map((wallet, index) => ({
            network: wallet.network,
            address: wallet.address,
            perPaymentMaxUsd: wallet.perPaymentMaxUsd,
            dailyCapUsd: wallet.dailyCapUsd,
            payments30d: paymentCounts[index] ?? 0,
        })),
        sandboxes: sandboxes.map((sandbox) => ({
            id: sandbox.id,
            name: sandbox.name,
            createdAt: sandbox.createdAt.toISOString(),
            lastSeenAt: sandbox.lastSeenAt?.toISOString() ?? null,
            daemonUrl: sandbox.daemonUrl,
            setupClaimedAt: sandbox.setupCodeClaimedAt?.toISOString() ?? null,
            setupReport: sandbox.setupReport as SetupReport | null,
            bootReport: sandbox.bootReport as BootReport | null,
            announceRefusal: sandbox.announceRefusal as AnnounceRefusal | null,
            hosted: sandbox.hosted
                ? {
                      region: sandbox.hosted.region,
                      appName: sandbox.hosted.appName,
                      wokeAt: sandbox.hosted.wokeAt?.toISOString() ?? null,
                      idleWarnedAt: sandbox.hosted.idleWarnedAt?.toISOString() ?? null,
                  }
                : null,
            members: sandbox.members.map((member) => ({ email: member.email, role: member.role, accepted: member.acceptedAt !== null })),
        })),
        memberOf: memberships.map((row) => ({
            sandboxName: row.sandbox.name,
            ownerEmail: row.sandbox.owner.email,
            role: row.role,
            accepted: row.acceptedAt !== null,
        })),
    };
};
