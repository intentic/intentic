import { apiContract } from "@intentic-app/api-contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";

const os = implement(apiContract).$context<OrpcContext>();

export const meRoutes = {
    get: os.me.get.handler(({ context }) => context.user),
    // GDPR data export: every personal-data row the platform holds for the caller, as downloadable JSON.
    // Credentials are deliberately excluded — session tokens, OAuth tokens, sandbox connect tokens and
    // setup payloads are secrets, not personal data.
    export: os.me.export.handler(async ({ context }) => {
        const user = requireUser(context);
        const [sessions, accounts, sandboxes, memberships, invitesSent, poolMembership, donations, creditSpends, serviceRuns] = await Promise.all([
            context.prisma.session.findMany({
                where: { userId: user.id },
                select: { createdAt: true, expiresAt: true, ipAddress: true, userAgent: true },
            }),
            context.prisma.account.findMany({
                where: { userId: user.id },
                select: { providerId: true, accountId: true, scope: true, createdAt: true },
            }),
            context.prisma.sandbox.findMany({
                where: { ownerId: user.id },
                select: { id: true, name: true, image: true, daemonUrl: true, createdAt: true },
            }),
            context.prisma.sandboxMember.findMany({ where: { email: user.email.toLowerCase() }, select: { sandboxId: true, createdAt: true } }),
            context.prisma.sandboxMember.findMany({
                where: { sandbox: { ownerId: user.id } },
                select: { sandboxId: true, email: true, createdAt: true },
            }),
            // The creator pool's rows about this account: the membership mirror and the use-day ledger.
            context.prisma.membership.findUnique({
                where: { userId: user.id },
                select: { status: true, currentPeriodEnd: true, createdAt: true },
            }),
            context.prisma.donation.findMany({
                where: { userId: user.id },
                select: { extensionId: true, month: true, credits: true },
            }),
            context.prisma.creditSpend.findMany({
                where: { userId: user.id },
                select: { day: true, credits: true },
            }),
            context.prisma.serviceRun.findMany({
                where: { userId: user.id },
                select: { serviceId: true, credits: true, status: true, createdAt: true },
            }),
        ]);
        return { user, sessions, accounts, sandboxes, memberships, invitesSent, poolMembership, donations, creditSpends, serviceRuns };
    }),
};
