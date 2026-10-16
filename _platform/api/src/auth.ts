import { ImageDataUrlSchema } from "@intentic/api-contract";
import { LEGAL_VERSION } from "@intentic/constants";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { emailOTP, oneTap, oneTimeToken } from "better-auth/plugins";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { eraseAccount, OwnsOrganisationSandboxes } from "./account-erase.js";
import { emailSignInEnabled, prismaCodeAllowances, SIGN_IN_CODE_ATTEMPTS, SIGN_IN_CODE_TTL_SECONDS, sendSignInCode } from "./sign-in.js";
import type { PrismaClient } from "@intentic/prisma";

export type Auth = ReturnType<typeof createAuth>;

// The clickwrap version stamped at sign-up, sourced from @intentic/constants so it can't drift from the docs.
const TERMS_VERSION = LEGAL_VERSION;

// Encrypts the OAuth token columns on Account (crypto.ts); only fields present in the write are touched.
const encryptAccountTokens = (config: Config, account: { accessToken?: string | null; refreshToken?: string | null; idToken?: string | null }) => ({
    ...(typeof account.accessToken === `string` && { accessToken: encryptSecret(config, account.accessToken) }),
    ...(typeof account.refreshToken === `string` && { refreshToken: encryptSecret(config, account.refreshToken) }),
    ...(typeof account.idToken === `string` && { idToken: encryptSecret(config, account.idToken) }),
});

// A code mailed to the address, for a person whose address no identity provider vouches for (sign-in.ts). One code,
// stored hashed, offered two ways in one mail: typed in, or opened from a link whose page asks for a Confirm press first.
// Better Auth's magic-link plugin was passed over (2026-10-12): its verify step is a GET, which the link scanners
// company mail runs (Safe Links and the like) spend before the person clicks. Better Auth limits each asker to a few
// codes a minute; sign-in.ts limits each address.
const emailCodes = (config: Config, prisma: PrismaClient, logger: Logger) =>
    emailOTP({
        otpLength: 6,
        expiresIn: SIGN_IN_CODE_TTL_SECONDS,
        allowedAttempts: SIGN_IN_CODE_ATTEMPTS,
        storeOTP: `hashed`,
        rateLimit: { window: 60, max: 5 },
        // Only sign-in codes: there are no passwords here to reset, so that kind is never mailed.
        sendVerificationOTP: async ({ email, otp, type }) => {
            if (type === `forget-password`) {
                return;
            }
            await sendSignInCode({ config, allowances: prismaCodeAllowances(prisma), logger }, { email, code: otp });
        },
    });

// What a new account is called before its owner names it: the part of the address before the @, since an emailed code
// carries no name the way a Google profile does.
const nameFor = (user: { name?: string | null; email: string }): string => {
    const name = user.name?.trim() ?? ``;
    return name.length > 0 ? name : (user.email.split(`@`)[0] ?? user.email).slice(0, 60);
};

// Mounted at /api/auth/** in app.ts; baseURL is the API origin, webOrigin is trusted for post-sign-in redirects. Dev's
// mismatched ports are same-site over https, so the Secure, SameSite=Lax session cookie still rides cross-port.
export const createAuth = (config: Config, prisma: PrismaClient, logger: Logger) =>
    betterAuth({
        secret: config.betterAuth.secret,
        baseURL: config.api.url,
        basePath: "/api/auth",
        trustedOrigins: [config.webOrigin],
        database: prismaAdapter(prisma, { provider: "postgresql" }),
        // A session's address is read from the one header the proxy sets (client-ip.ts), never a forwarded chain the
        // caller could have written.
        advanced: { ipAddress: { ipAddressHeaders: config.api.trustedIpHeader === `` ? [] : [config.api.trustedIpHeader] } },
        emailAndPassword: { enabled: false },
        socialProviders: {
            google: {
                clientId: config.google.clientId,
                clientSecret: config.google.clientSecret,
            },
        },
        // One account per address, however it signs in: an emailed code for an address that has an account enters that
        // account, and a Google sign-in for an account made with a code links Google to it (Google says the address is
        // verified, so it is trusted to). Said here rather than left to Better Auth's defaults, which are the same today.
        account: { accountLinking: { enabled: true, trustedProviders: [`google`] } },
        user: {
            additionalFields: {
                termsAcceptedAt: { type: `date`, required: false, input: false },
                termsVersion: { type: `string`, required: false, input: false },
            },
            // The one erase path (account-erase.ts), before the cascade takes every row that names the account's hosted
            // apps, its Stripe customer and its standing; the admin delete runs the same.
            deleteUser: {
                enabled: true,
                beforeDelete: async (user) => {
                    // An account that owns an organisation's sandboxes is not erased until its admin releases them.
                    await eraseAccount(prisma, config, logger, user.id).catch((error: Error) => {
                        if (error instanceof OwnsOrganisationSandboxes) {
                            throw new APIError(`FORBIDDEN`, { message: error.message });
                        }
                        throw error;
                    });
                },
            },
        },
        databaseHooks: {
            // Stamps which clickwrap version the login page showed when the account was created.
            user: {
                create: {
                    before: async (user) => ({ data: { ...user, name: nameFor(user), termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION } }),
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
            // Absent where email sign-in is off, so its routes do not exist there at all.
            ...(emailSignInEnabled(config) ? [emailCodes(config, prisma, logger)] : []),
        ],
    });
