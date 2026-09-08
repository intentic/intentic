import { ImageDataUrlSchema } from "@intentic/api-contract";
import { LEGAL_VERSION } from "@intentic/constants";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { oneTap, oneTimeToken } from "better-auth/plugins";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { cancelHostedPlan } from "./sandbox/hosted/hosted-plan.js";
import type { PrismaClient } from "@intentic/prisma";

export type Auth = ReturnType<typeof createAuth>;

// The clickwrap version stamped at sign-up, sourced from @intentic/constants so it can't drift from the docs.
const TERMS_VERSION = LEGAL_VERSION;

// Encrypts the Google OAuth token columns on Account (crypto.ts); only fields present in the write are touched.
const encryptAccountTokens = (config: Config, account: { accessToken?: string | null; refreshToken?: string | null; idToken?: string | null }) => ({
    ...(typeof account.accessToken === `string` && { accessToken: encryptSecret(config, account.accessToken) }),
    ...(typeof account.refreshToken === `string` && { refreshToken: encryptSecret(config, account.refreshToken) }),
    ...(typeof account.idToken === `string` && { idToken: encryptSecret(config, account.idToken) }),
});

// Mounted at /api/auth/** in app.ts; baseURL is the API origin, webOrigin is trusted for post-sign-in redirects. Dev's
// mismatched ports are same-site over https, so the Secure, SameSite=Lax session cookie still rides cross-port.
export const createAuth = (config: Config, prisma: PrismaClient, logger: Logger) =>
    betterAuth({
        secret: config.betterAuth.secret,
        baseURL: config.api.url,
        basePath: "/api/auth",
        trustedOrigins: [config.webOrigin],
        database: prismaAdapter(prisma, { provider: "postgresql" }),
        emailAndPassword: { enabled: false },
        socialProviders: {
            google: {
                clientId: config.google.clientId,
                clientSecret: config.google.clientSecret,
            },
        },
        user: {
            additionalFields: {
                termsAcceptedAt: { type: `date`, required: false, input: false },
                termsVersion: { type: `string`, required: false, input: false },
            },
            // Cancels the Stripe subscription before the cascade removes the plan row: Stripe does not cascade with us.
            deleteUser: {
                enabled: true,
                beforeDelete: async (user) => {
                    await cancelHostedPlan(prisma, config, logger, user.id);
                },
            },
        },
        databaseHooks: {
            // Stamps which clickwrap version the login page showed when the account was created.
            user: {
                create: {
                    before: async (user) => ({ data: { ...user, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION } }),
                },
                // Caps name length and avatar size on Better Auth's /update-user; only fields present in the write are
                // checked.
                update: {
                    before: async (user) => {
                        if (typeof user.name === `string` && (user.name.trim().length === 0 || user.name.length > 60)) {
                            throw new APIError(`BAD_REQUEST`, { message: `Name must be 1-60 characters.` });
                        }
                        if (typeof user.image === `string` && !ImageDataUrlSchema.safeParse(user.image).success) {
                            throw new APIError(`BAD_REQUEST`, { message: `Avatar must be a small data-URL image.` });
                        }
                    },
                },
            },
            account: {
                create: { before: async (account) => ({ data: { ...account, ...encryptAccountTokens(config, account) } }) },
                update: { before: async (account) => ({ data: { ...account, ...encryptAccountTokens(config, account) } }) },
            },
        },
        // oneTimeToken mints a short-lived token so a sign-in can cross into the desktop app's webview.
        plugins: [
            oneTimeToken(),
            // Accepts the browser's own Google ID token, settling both this platform's and the sandbox's sign-in at
            // once.
            oneTap(),
        ],
    });
