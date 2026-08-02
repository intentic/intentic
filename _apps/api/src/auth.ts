import { stripe as stripePlugin } from "@better-auth/stripe";
import { ImageDataUrlSchema } from "@intentic-app/api-contract";
import { LEGAL_VERSION } from "@intentic/constants";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { oneTimeToken } from "better-auth/plugins";
import type { Config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { getStripe } from "./billing/stripe.js";
import type { PrismaClient } from "@intentic-app/prisma";

export type Auth = ReturnType<typeof createAuth>;

// The clickwrap version stamped on each account at sign-up (the login page's "By continuing you agree…"
// notice), sourced from @intentic/constants — the SAME value intentic.dev renders its documents under, so the
// two can't drift (bump it once in @intentic/constants).
const TERMS_VERSION = LEGAL_VERSION;

// Billing for the platform's own SaaS. The plugin owns the checkout/customer-portal/webhook flow and mounts
// its webhook at /api/auth/stripe/webhook (already covered by the /api/auth/** handler in app.ts, which passes
// the raw Request so signature verification works). Subscription state lands in the Subscription model +
// user.stripeCustomerId — central-account state, the one sanctioned platform store. Registered only when a
// secret key is set: the Stripe client throws on an empty key, and unconfigured dev must still boot (the
// upgrade flow simply 404s until STRIPE_SECRET_KEY is provided, matching the config soft-warn).
const billingPlugins = (config: Config) =>
    config.stripe.secretKey
        ? [
              stripePlugin({
                  stripeClient: getStripe(config),
                  stripeWebhookSecret: config.stripe.webhookSecret,
                  createCustomerOnSignUp: true,
                  subscription: {
                      enabled: true,
                      requireEmailVerification: false, // Google sign-in users are already verified
                      plans: [{ name: `pro`, priceId: config.stripe.proPriceId }],
                  },
              }),
          ]
        : [];

// The Google OAuth token columns on Account, encrypted at rest (crypto.ts). Only fields present in the
// write are touched. There is no decrypt path: the platform never calls Google's APIs with them.
const encryptAccountTokens = (config: Config, account: { accessToken?: string | null; refreshToken?: string | null; idToken?: string | null }) => ({
    ...(typeof account.accessToken === `string` && { accessToken: encryptSecret(config, account.accessToken) }),
    ...(typeof account.refreshToken === `string` && { refreshToken: encryptSecret(config, account.refreshToken) }),
    ...(typeof account.idToken === `string` && { idToken: encryptSecret(config, account.idToken) }),
});

// Better Auth instance. The handler is mounted at /api/auth/** in app.ts; the browser calls it
// directly at the API origin (apiUrl), so baseURL is the API origin. The SPA (webOrigin) is a
// trusted origin so post-sign-in redirects back to it are allowed. localhost:47145 and the API's
// :6480 are same-site, so the SameSite=Lax session cookie still rides cross-port. Both are https in dev
// (the committed @intentic-app/localhost-https cert), which the Secure attribute on that cookie requires.
export const createAuth = (config: Config, prisma: PrismaClient) =>
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
            // GDPR Art. 17: self-service account deletion (Settings → delete account). Google-only users have
            // no password, so Better Auth requires a fresh session instead. The Stripe customer is deleted
            // first (which cancels any subscription) — a Stripe failure aborts the whole delete so billing
            // never dangles; the PrismaClient cascades then remove sessions/accounts/sandboxes/grants with the user.
            deleteUser: {
                enabled: true,
                beforeDelete: async (user) => {
                    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
                    if (dbUser?.stripeCustomerId && config.stripe.secretKey) {
                        await getStripe(config).customers.del(dbUser.stripeCustomerId);
                    }
                },
            },
        },
        databaseHooks: {
            // Consent capture: stamp which clickwrap version the login page showed when the account was created.
            user: {
                create: {
                    before: async (user) => ({ data: { ...user, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION } }),
                },
                // Trust boundary for Better Auth's built-in /update-user endpoint (Settings → profile): the browser
                // sends { name, image } with image a small data URL, but nothing stops a raw client from PUTting
                // megabytes — cap what may be persisted. Only fields present in THIS write are checked (the Stripe
                // plugin and emailVerified updates ride the same hook with neither field).
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
        /* The one-time token plugin is how a sign-in crosses from the user's real browser into the desktop
         * app's webview (see the DesktopHandoff model). It is the library's own answer to "move this session
         * to another user agent": GET /one-time-token/generate mints one for the caller's session, POST
         * /one-time-token/verify spends it and answers with the session cookie — so the webview obtains its
         * cookie through an ordinary HTTP round trip, and nothing hand-rolls a session or forges a cookie.
         * Three minutes by default, which is the right order for a link the app opens the instant it arrives. */
        plugins: [...billingPlugins(config), oneTimeToken()],
    });
