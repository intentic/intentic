import { ACCOUNT_PREFERENCES_MAX, apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { hasGoogleAccount, signInMethodsOf, signInOptionsOf } from "../sign-in.js";
import { patchedPreferences, storedPreferences } from "./preferences.js";

const os = implement(apiContract).$context<OrpcContext>();

export const meRoutes = {
    get: os.me.get.handler(async ({ context }) => {
        if (context.user === null) {
            return null;
        }
        const { emailVerified: _verified, ...user } = context.user;
        return { ...user, signInMethods: signInMethodsOf(await hasGoogleAccount(context.prisma, user.id), context.config) };
    }),
    // Sessionless: the login page reads it before anyone has signed in.
    signInOptions: os.me.signInOptions.handler(({ context }) => signInOptionsOf(context.config)),
    // The person's own look and reading preferences, kept with the account (preferences.ts).
    preferences: os.me.preferences.handler(async ({ context }) => {
        const user = requireUser(context);
        const row = await context.prisma.user.findUnique({ where: { id: user.id }, select: { preferences: true } });
        return { values: storedPreferences(row?.preferences) };
    }),
    // A patch, merged under a lock on the person's row: two devices saving at once both land, the later never writing
    // the earlier's choice back out. Refused whole when the result would pass the cap, so nothing is half kept.
    setPreferences: os.me.setPreferences.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const values = await context.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT id FROM "user" WHERE id = ${user.id} FOR UPDATE`;
            const row = await tx.user.findUnique({ where: { id: user.id }, select: { preferences: true } });
            const next = patchedPreferences(storedPreferences(row?.preferences), input.values);
            if (Object.keys(next).length > ACCOUNT_PREFERENCES_MAX) {
                throw new ORPCError(`BAD_REQUEST`, { message: `an account keeps at most ${ACCOUNT_PREFERENCES_MAX} preferences` });
            }
            await tx.user.update({ where: { id: user.id }, data: { preferences: next } });
            return next;
        });
        return { values };
    }),
    // GDPR data export: every personal-data row the platform holds for the caller, as downloadable JSON.
    // Credentials are deliberately excluded, session tokens, OAuth tokens, sandbox connect tokens and
    // setup payloads are secrets, not personal data.
    export: os.me.export.handler(async ({ context }) => {
        const user = requireUser(context);
        const [sessions, accounts, sandboxes, memberships, invitesSent, hostedPlan, hostedUsage, hostedProvisions, hostedStrikes, standing] = await Promise.all([
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
            // The hosted plan's mirror row and the hosted lane's awake-hour meter, the two per-account rows the
            // platform keeps beyond identity.
            context.prisma.hostedPlan.findUnique({
                where: { userId: user.id },
                select: { status: true, currentPeriodEnd: true, createdAt: true },
            }),
            // By owner rather than through the sandbox: a released machine's minutes stay on the account, keyed by no
            // sandbox, and they are the caller's all the same.
            context.prisma.hostedUsage.findMany({ where: { ownerId: user.id }, select: { month: true, tier: true, minutes: true } }),
            // The address each hosted machine was asked for from, and the abuse watch's verdicts: both about the
            // subject, both kept only as long as they are counted (retention.ts).
            context.prisma.hostedProvision.findMany({ where: { userId: user.id }, select: { ip: true, domain: true, appName: true, createdAt: true } }),
            context.prisma.hostedStrike.findMany({
                where: { userId: user.id },
                select: { appName: true, kind: true, measure: true, windowMinutes: true, action: true, createdAt: true },
            }),
            context.prisma.user.findUnique({ where: { id: user.id }, select: { hostedSuspendedAt: true, hostedSuspendedReason: true, preferences: true } }),
        ]);
        return {
            user,
            sessions,
            accounts,
            sandboxes,
            memberships,
            invitesSent,
            hostedPlan,
            hostedUsage,
            hostedProvisions,
            hostedStrikes,
            hostedSuspended: standing?.hostedSuspendedAt ? { at: standing.hostedSuspendedAt, reason: standing.hostedSuspendedReason } : null,
            // The look and reading preferences kept with the account (preferences.ts).
            preferences: storedPreferences(standing?.preferences),
        };
    }),
};
