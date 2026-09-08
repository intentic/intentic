import { createHmac, randomBytes } from "node:crypto";
import { PrismaClient } from "@intentic/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

// Sign-in is seeded, not performed, staging a later real Google sign-in. Gets a browser past the platform's session
// cookie but not past the box, since a provisioned daemon verifies Google for real; SIGN_IN_IS_SEEDED skips that half.
// Seeds a user row, a session row, and a cookie minted and proven the way the server mints it.

// Whether this tier's sign-in is still seeded; flips to false with the change that makes it real.
export const SIGN_IN_IS_SEEDED = true;

export const SEED = {
    userId: `onboarding-user`,
    email: `onboarding@intentic.dev`,
    name: `Onboarding User`,
} as const;

// Re-exported so this seed stays the one import a harness needs.
export { GOOGLE_TOKEN_STORAGE_KEY } from "@intentic/constants";

// Https world, so this is the `__Secure-`-prefixed cookie name, the same one the server and production use.
export const SESSION_COOKIE_NAME = `__Secure-better-auth.session_token`;

const signedCookie = (token: string, secret: string): string => `${token}.${createHmac(`sha256`, secret).update(token).digest(`base64`)}`;

const base64Json = (value: object): string => Buffer.from(JSON.stringify(value)).toString(`base64url`);

// Well-formed but unsigned; the loopback daemon never verifies the bearer, and the browser only reads exp and email
// from a cached token before restoring it. Enough to keep sandbox calls flowing with no network round trip to Google.
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

// Proves the cookie recipe against the server that will verify it, before any spec depends on it.
export const verifySession = async (apiUrl: string, session: SeededSession): Promise<void> => {
    const response = await fetch(`${apiUrl}/api/auth/get-session`, {
        headers: { cookie: `${session.cookieName}=${session.cookieValue}` },
    });
    const body = (await response.json().catch(() => undefined)) as { user?: { email?: string } } | null | undefined;
    if (body?.user?.email !== SEED.email) {
        throw new Error(
            `the seeded session cookie was rejected by ${apiUrl}/api/auth/get-session (HTTP ${response.status}): ` +
                `the Better Auth cookie recipe in seed.ts no longer matches the server`,
        );
    }
};
