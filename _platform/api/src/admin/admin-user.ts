import type { AdminUserDetail, AnnounceRefusal, BootReport, SetupReport } from "@intentic-app/api-contract";
import type { PrismaClient } from "@intentic-app/prisma";

/* THE SUPPORT PAGE — one account, everything operational the platform knows, assembled so "it doesn't work"
 * is answerable without psql. Reads only rows the account's own GDPR export already shows the subject, plus
 * the operational sandbox columns (setup/boot reports, refusals) that exist precisely to be read when
 * something is stuck. Null when neither id nor email matches; the route turns that into NOT_FOUND. */

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

export const adminUserDetail = async (prisma: PrismaClient, idOrEmail: string, now: () => Date = () => new Date()): Promise<AdminUserDetail | null> => {
    const needle = idOrEmail.trim();
    const user = await prisma.user.findFirst({
        where: { OR: [{ id: needle }, { email: { equals: needle, mode: `insensitive` } }] },
        select: { id: true, email: true, name: true, image: true, createdAt: true, termsVersion: true },
    });
    if (user === null) {
        return null;
    }
    const at = now();
    const week = Array.from({ length: 7 }, (_, index) => utcDayOf(new Date(at.getTime() - (6 - index) * DAY_MS)));
    const month = at.toISOString().slice(0, 7);
    const memberEmail = user.email.toLowerCase();

    const [sessions, accounts, membership, creditToday, trialRows, hostedRows, wallets, sandboxes, memberships, publishers, services, payouts] =
        await Promise.all([
            prisma.session.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: `desc` },
                take: 5,
                select: { createdAt: true, expiresAt: true, ipAddress: true, userAgent: true },
            }),
            prisma.account.findMany({ where: { userId: user.id }, select: { providerId: true } }),
            prisma.membership.findUnique({ where: { userId: user.id }, select: { status: true, currentPeriodEnd: true } }),
            prisma.creditSpend.findUnique({ where: { userId_day: { userId: user.id, day: utcDayOf(at) } }, select: { credits: true } }),
            prisma.trialUsage.findMany({
                where: { userId: user.id, day: { in: week } },
                orderBy: { day: `desc` },
                select: { day: true, messages: true, lastModel: true },
            }),
            prisma.hostedUsage.findUnique({ where: { userId_month: { userId: user.id, month } }, select: { minutes: true } }),
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
            prisma.publisherClaim.findMany({ where: { userId: user.id }, select: { publisher: true } }),
            prisma.service.findMany({ where: { userId: user.id }, select: { slug: true, status: true, creditsPerRun: true } }),
            prisma.creatorPayout.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: `desc` },
                take: 5,
                select: { amountCents: true, status: true, createdAt: true, lastError: true },
            }),
        ]);

    // Payment counts per wallet, bounded by the wallet count (one per network).
    const paymentCounts = await Promise.all(
        wallets.map((wallet) => prisma.walletPayment.count({ where: { walletId: wallet.id, createdAt: { gte: new Date(at.getTime() - 30 * DAY_MS) } } })),
    );

    const creator =
        publishers.length === 0 && services.length === 0 && payouts.length === 0
            ? null
            : {
                  publishers: publishers.map((claim) => claim.publisher),
                  services,
                  payouts: payouts.map((payout) => ({
                      amountCents: payout.amountCents,
                      status: payout.status,
                      createdAt: payout.createdAt.toISOString(),
                      lastError: payout.lastError,
                  })),
              };

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
        membership: membership ? { status: membership.status, currentPeriodEnd: membership.currentPeriodEnd.toISOString() } : null,
        creditsToday: creditToday?.credits ?? 0,
        trialDays: trialRows,
        hostedMonthMinutes: hostedRows?.minutes ?? 0,
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
        creator,
    };
};
