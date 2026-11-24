import { ACCOUNT_PREFERENCES_MAX, apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { dataExportOf } from "./data-export.js";
import { isInternalAccount } from "./internal-accounts.js";
import { hasGoogleAccount, signInMethodsOf, signInOptionsOf } from "../sign-in.js";
import { patchedPreferences, storedPreferences } from "./preferences.js";

const os = implement(apiContract).$context<OrpcContext>();

export const meRoutes = {
    get: os.me.get.handler(async ({ context }) => {
        if (context.user === null) {
            return null;
        }
        const { emailVerified: _verified, ...user } = context.user;
        // `internal` is the account's own answer only (internal-accounts.ts); the list it is read from stays here.
        return {
            ...user,
            signInMethods: signInMethodsOf(await hasGoogleAccount(context.prisma, user.id), context.config),
            internal: isInternalAccount(context.config, user.email),
        };
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
    // GDPR data export: every row the platform holds about the caller, credentials left out (data-export.ts).
    export: os.me.export.handler(async ({ context }) => dataExportOf(context.prisma, requireUser(context))),
};
