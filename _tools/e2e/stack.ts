import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { PrismaClient } from "@intentic-app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

// The one place the e2e stack's shape lives: origins, credentials, the seeded rows, and the Better Auth
// session-cookie recipe. global-setup boots everything against these; specs import the seeded values.

// Mirrors dev exactly (.env.example): https API on :6480 with this machine's localhost cert, https web on
// :47145, compose postgres on :5440. SECRETS_KEY stays unset so the seeded sandbox token is stored plaintext.
export const API_URL = `https://localhost:6480`;
export const WEB_URL = `https://localhost:47145`;
export const DATABASE_URL = `postgresql://app:app@localhost:5440/app`;

// The cookie signature must match the API that verifies it. When a dev machine's already-running API is
// reused, that API signed up under the root .env's secret — so read it from there first; the constant only
// backs the from-scratch boot (CI), where global-setup starts the API with exactly this value.
const envSecret = (): string | undefined => {
    try {
        return readFileSync(join(repoRoot(import.meta.url), `.env`), `utf8`)
            .match(/^BETTER_AUTH_SECRET=(.+)$/m)?.[1]
            ?.trim();
    } catch {
        return undefined;
    }
};
export const BETTER_AUTH_SECRET = envSecret() ?? `intentic-e2e-secret`;

// The daemon under test: the PUBLISHED sandbox image by default — the real contract a user's browser meets —
// overridable to a source build for cross-repo debugging (SANDBOX_E2E_IMAGE=...).
export const DAEMON_IMAGE = process.env[`SANDBOX_E2E_IMAGE`] ?? `ghcr.io/intentic/sandbox:stable`;
// A non-default host port so the reuse check can never latch onto a REAL sandbox a dev runs on this machine.
export const DAEMON_URL = `http://localhost:18787`;
export const DAEMON_CONTAINER = `intentic-app-e2e-daemon`;

// The public web client id — must match _editor/web/src/environments/environment.local.ts (it keys the cached
// Google ID token's localStorage slot). Drift shows up as the sign-in gate in every spec's trace.
const GOOGLE_CLIENT_ID = `481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com`;

export const SEED = {
    userId: `e2e-user`,
    email: `e2e@intentic.dev`,
    name: `E2E User`,
    sandboxId: `e2e-sandbox`,
    sandboxName: `E2E Sandbox`,
};

const createPrisma = (): PrismaClient => new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

// Better Auth's session cookie, minted the way the server does (better-call signCookieValue): the https API
// origin turns on secure cookies, so the name carries the __Secure- prefix, and the value is the session token
// with an HMAC-SHA256(base64) signature appended. global-setup verifies the recipe against /api/auth/get-session
// before any spec runs, so drift fails fast with a clear message.
export const SESSION_COOKIE_NAME = API_URL.startsWith(`https`) ? `__Secure-better-auth.session_token` : `better-auth.session_token`;

export const signedSessionCookie = (sessionToken: string): string =>
    `${sessionToken}.${createHmac(`sha256`, BETTER_AUTH_SECRET).update(sessionToken).digest(`base64`)}`;

// The sandboxClient refuses to call the daemon without a Google ID token (sandboxClient.ts throws before any
// fetch), but useGoogleIdentity restores a cached one from localStorage without touching Google when its exp
// is >60s out — and the loopback daemon never verifies the bearer. So the seed plants a well-formed fake JWT
// (only the payload's exp/email are ever read) and no FedCM prompt or sign-in gate can appear.
export const GOOGLE_TOKEN_STORAGE_KEY = `intentic.gid.${GOOGLE_CLIENT_ID}`;

const base64Json = (value: object): string => Buffer.from(JSON.stringify(value)).toString(`base64url`);

export const fakeGoogleIdToken = (): string =>
    `${base64Json({ alg: `none`, typ: `JWT` })}.${base64Json({ exp: Math.floor(Date.now() / 1000) + 60 * 60, email: SEED.email })}.e2e`;

// Seed the authenticated world: the user, a week-long session, and one sandbox whose daemonUrl points at the
// loopback daemon. Idempotent — reruns replace the previous seed.
export const seed = async (): Promise<{ sessionToken: string; sandboxToken: string }> => {
    const prisma = createPrisma();
    const sessionToken = randomBytes(24).toString(`base64url`);
    const sandboxToken = randomBytes(16).toString(`base64url`);
    try {
        await prisma.user.upsert({
            where: { id: SEED.userId },
            create: { id: SEED.userId, email: SEED.email, name: SEED.name, emailVerified: true },
            update: { email: SEED.email, name: SEED.name },
        });
        await prisma.session.deleteMany({ where: { userId: SEED.userId } });
        await prisma.session.create({
            data: {
                id: `e2e-session`,
                token: sessionToken,
                userId: SEED.userId,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
        });
        await prisma.sandbox.deleteMany({ where: { id: SEED.sandboxId } });
        await prisma.sandbox.create({
            data: {
                id: SEED.sandboxId,
                name: SEED.sandboxName,
                ownerId: SEED.userId,
                token: sandboxToken,
                tokenDigest: createHash(`sha256`).update(sandboxToken).digest(`hex`),
                daemonUrl: DAEMON_URL,
                lastSeenAt: new Date(),
            },
        });
    } finally {
        await prisma.$disconnect();
    }
    return { sessionToken, sandboxToken };
};

export const unseed = async (): Promise<void> => {
    const prisma = createPrisma();
    try {
        await prisma.sandbox.deleteMany({ where: { id: SEED.sandboxId } });
        await prisma.user.deleteMany({ where: { id: SEED.userId } }); // cascades the session
    } finally {
        await prisma.$disconnect();
    }
};
