import { createHmac, randomBytes } from "node:crypto";
import { PrismaClient } from "@intentic-app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

/* THE SIGNED-IN ACCOUNT, AND THE SEAM WHERE A REAL SIGN-IN WILL GO.
 *
 * The journey's first step is "sign in", and today it is seeded rather than performed. That is a staging
 * decision, not a permanent one: the stand-in Google that really signs tokens is the next piece of this tier.
 *
 * HOW FAR A SEEDED SIGN-IN CAN CARRY A JOURNEY IS NOT A MATTER OF TASTE, and it was measured rather than
 * guessed. It gets a browser past the PLATFORM, which is all the platform's session cookie is for — so
 * arriving signed in, walking the wizard and provisioning a sandbox all work. It does not get the browser past
 * the BOX: a provisioned daemon authenticates people against Google itself (which is the whole reason a
 * sandbox ever asked for Google a second time), so it answers the seeded credential with 401 on every call.
 * `SIGN_IN_IS_SEEDED` is what the journey reads to skip the half that needs more, with that reason attached.
 *
 * What is seeded is exactly what a completed sign-in leaves behind: a user row, a session row, and the cookie
 * the browser would be holding. The cookie is minted the way the server mints it (Better Auth's
 * signCookieValue: the token, then an HMAC-SHA256 of it, base64, appended) and PROVEN against the running
 * /api/auth/get-session before any spec runs — so a Better Auth upgrade that changes the recipe fails here
 * with a sentence, rather than as a blank login page in every journey.
 */

/* Whether this tier's sign-in is still the seeded one. Flipped to false by the change that makes it real —
 * which is the same change that lets the second half of the journey run. */
export const SIGN_IN_IS_SEEDED = true;

export const SEED = {
    userId: `onboarding-user`,
    email: `onboarding@intentic.dev`,
    name: `Onboarding User`,
} as const;

/* The public web client id, which must match the SPA's built-in one: it keys the localStorage slot the cached
 * Google ID token lives in. Drift shows up as a sign-in gate standing in front of the workspace in every spec.
 */
const GOOGLE_CLIENT_ID = `481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com`;
export const GOOGLE_TOKEN_STORAGE_KEY = `intentic.gid.${GOOGLE_CLIENT_ID}`;

/* The api is served over TLS here (certs.ts says why the whole world has to be), so the cookie carries the
 * `__Secure-` prefix and is marked secure — the same branch the server itself takes, and the same name
 * production and the browser tier get. */
export const SESSION_COOKIE_NAME = `__Secure-better-auth.session_token`;

const signedCookie = (token: string, secret: string): string => `${token}.${createHmac(`sha256`, secret).update(token).digest(`base64`)}`;

const base64Json = (value: object): string => Buffer.from(JSON.stringify(value)).toString(`base64url`);

/* A well-formed but unsigned Google ID token.
 *
 * The daemon in this tier runs in loopback mode and never verifies the bearer, while the browser's own
 * `useGoogleIdentity` restores a cached token without touching Google whenever its `exp` is more than a minute
 * out — and only ever reads `exp` and `email` from it. So this is enough to keep every sandbox call flowing
 * and every sign-in gate off the screen, without a network round trip to Google from a CI runner.
 */
export const fakeGoogleIdToken = (): string =>
    `${base64Json({ alg: `none`, typ: `JWT` })}.${base64Json({ exp: Math.floor(Date.now() / 1000) + 60 * 60, email: SEED.email })}.onboarding`;

export interface SeededSession {
    readonly cookieName: string;
    readonly cookieValue: string;
}

export const seedSession = async (databaseUrl: string, betterAuthSecret: string): Promise<SeededSession> => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const token = randomBytes(24).toString(`base64url`);
    try {
        await prisma.user.upsert({
            where: { id: SEED.userId },
            create: { id: SEED.userId, email: SEED.email, name: SEED.name, emailVerified: true },
            update: { email: SEED.email, name: SEED.name },
        });
        await prisma.session.deleteMany({ where: { userId: SEED.userId } });
        await prisma.session.create({
            data: {
                id: `onboarding-session`,
                token,
                userId: SEED.userId,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
        });
    } finally {
        await prisma.$disconnect();
    }
    return { cookieName: SESSION_COOKIE_NAME, cookieValue: signedCookie(token, betterAuthSecret) };
};

// Prove the recipe against the server that will verify it, before any spec depends on it.
export const verifySession = async (apiUrl: string, session: SeededSession): Promise<void> => {
    const response = await fetch(`${apiUrl}/api/auth/get-session`, {
        headers: { cookie: `${session.cookieName}=${session.cookieValue}` },
    });
    const body = (await response.json().catch(() => undefined)) as { user?: { email?: string } } | null | undefined;
    if (body?.user?.email !== SEED.email) {
        throw new Error(
            `the seeded session cookie was rejected by ${apiUrl}/api/auth/get-session (HTTP ${response.status}) — ` +
                `the Better Auth cookie recipe in seed.ts no longer matches the server`,
        );
    }
};
