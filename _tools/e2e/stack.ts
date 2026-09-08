import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { PrismaClient } from "@intentic/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

// The e2e stack's shape: origins, credentials, seeded rows, and the Better Auth cookie recipe. global-setup boots
// against these; specs import the seeded values.

// Mirrors dev (.env.example): API :6480, web :47145, postgres :5440; token stays plaintext (SECRETS_KEY unset).
export const API_URL = `https://localhost:6480`;
export const WEB_URL = `https://localhost:47145`;
export const DATABASE_URL = `postgresql://app:app@localhost:5440/app`;

// Reused dev API signed sessions with the root .env's secret, so read that first; the fallback constant only backs a
// from-scratch (CI) boot.
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

// Published sandbox image by default (the real contract a browser meets); override via SANDBOX_E2E_IMAGE.
export const DAEMON_IMAGE = process.env[`SANDBOX_E2E_IMAGE`] ?? `ghcr.io/intentic/sandbox:stable`;
// Non-default port: the reuse check must never latch onto a real sandbox running on this machine.
export const DAEMON_URL = `http://localhost:18787`;
export const DAEMON_CONTAINER = `intentic-app-e2e-daemon`;

// Fixed port lets the API name the stand-in early; a reused dev API sells elsewhere, so billing skips.
export const FAKE_STRIPE = {
    origin: `http://127.0.0.1:18789`,
    port: 18789,
    secretKey: `sk_test_e2e_browser`,
    webhookSecret: `whsec_e2e_browser`,
    priceId: `price_e2e_hosted`,
};

// What global-setup started; teardown and specs that only make sense against a stack this run booted (billing) read it.
export interface StackState {
    apiPid?: number;
    webPid?: number;
    daemonStarted?: boolean;
    fakeStripe?: boolean;
}

export const STACK_STATE_FILE = join(import.meta.dirname, `.cache`, `stack-state.json`);

export const readStackState = (): StackState => {
    try {
        return JSON.parse(readFileSync(STACK_STATE_FILE, `utf8`)) as StackState;
    } catch {
        return {};
    }
};

export const SEED = {
    userId: `e2e-user`,
    email: `e2e@intentic.dev`,
    name: `E2E User`,
    sandboxId: `e2e-sandbox`,
    sandboxName: `E2E Sandbox`,
};

const createPrisma = (): PrismaClient => new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

// https gets the __Secure- prefix; value is the token plus an HMAC-SHA256(base64) signature.
export const SESSION_COOKIE_NAME = API_URL.startsWith(`https`) ? `__Secure-better-auth.session_token` : `better-auth.session_token`;

export const signedSessionCookie = (sessionToken: string): string =>
    `${sessionToken}.${createHmac(`sha256`, BETTER_AUTH_SECRET).update(sessionToken).digest(`base64`)}`;

// A fake JWT suffices: sandboxClient never verifies the bearer over loopback, only reads exp/email.
export { GOOGLE_TOKEN_STORAGE_KEY } from "@intentic/constants";

const base64Json = (value: object): string => Buffer.from(JSON.stringify(value)).toString(`base64url`);

export const fakeGoogleIdToken = (): string =>
    `${base64Json({ alg: `none`, typ: `JWT` })}.${base64Json({ exp: Math.floor(Date.now() / 1000) + 60 * 60, email: SEED.email })}.e2e`;

// Seeds a user, week-long session and a sandbox pointed at the loopback daemon; idempotent, reruns replace it.
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
                // Must match the API's sandboxIdFromToken (sandbox.routes.ts): a public hostname embeds this 12-hex id.
                tunnelId: createHash(`sha256`).update(sandboxToken).digest(`hex`).slice(0, 12),
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
