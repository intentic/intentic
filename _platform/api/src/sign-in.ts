import { createPrivateKey, hkdfSync } from "node:crypto";
import type { SignInMethod, SignInOptions } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import { topPath } from "@intentic/sandbox-contract/app-routes";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "./config.js";
import { sendMail, signInCodeEmail } from "./mail.js";

// Sign-in besides Google: a code mailed to the address (Better Auth emailOTP, auth.ts), and the identity assertion that
// carries an email account's sign-in on to its sandboxes (sandbox.identityAssertion, sandbox-contract
// policy/identity-assertion.ts).

// How long a code works and how many wrong tries it takes before it stops: five guesses at a million codes, and a few
// codes an hour per address (below), is nothing worth guessing at.
export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60;
export const SIGN_IN_CODE_ATTEMPTS = 5;

const mailConfigured = (config: Config): boolean => config.email.apiKey !== `` && config.email.from !== ``;

// Whether this platform offers email-code sign-in. Off in production while mail is unconfigured: the code would only
// reach the server log, a door nobody can use and anybody reading logs could. In development the log is how a developer
// reads the code.
export const emailSignInEnabled = (config: Config, env: NodeJS.ProcessEnv = process.env): boolean =>
    config.signIn.email && (mailConfigured(config) || env[`NODE_ENV`] !== `production`);

export const signInOptionsOf = (config: Config): SignInOptions => ({
    google: config.google.clientId !== ``,
    email: emailSignInEnabled(config),
});

// The page the mail's link opens: it shows the address and asks for a Confirm press before it spends the code
// (the editor's `loginConfirm` page), so a scanner that opens every link in a mail signs nobody in.
export const signInCodeLink = (config: Config, email: string, code: string): string => {
    return new URL(topPath(`loginConfirm`, {}, { email, code }), config.webOrigin).toString();
};

// At most one code a minute and five an hour per address, whoever asks and from wherever: the per-IP limit Better Auth
// keeps is per address of the asker, and this is the one that keeps a stranger's inbox from filling up.
const CODE_WINDOWS = [
    { name: `minute`, ms: 60_000, max: 1 },
    { name: `hour`, ms: 60 * 60_000, max: 5 },
] as const;

// One address's count in one window, as the allowance table keeps it.
export interface CodeAllowanceRow {
    readonly count: number;
    readonly windowStart: Date;
}

// The allowance table, as the limit reads and writes it: a fresh window, or one more code in the current one.
export interface CodeAllowances {
    readonly read: (key: string) => Promise<CodeAllowanceRow | null>;
    readonly restart: (key: string, windowStart: Date) => Promise<void>;
    readonly increment: (key: string) => Promise<void>;
}

export const prismaCodeAllowances = (prisma: PrismaClient): CodeAllowances => ({
    read: (key) => prisma.signInCodeAllowance.findUnique({ where: { key }, select: { count: true, windowStart: true } }),
    restart: async (key, windowStart) => {
        await prisma.signInCodeAllowance.upsert({ where: { key }, create: { key, count: 1, windowStart }, update: { count: 1, windowStart } });
    },
    increment: async (key) => {
        await prisma.signInCodeAllowance.update({ where: { key }, data: { count: { increment: 1 } } });
    },
});

export const takeCodeAllowance = async (allowances: CodeAllowances, email: string, now = new Date()): Promise<boolean> => {
    const address = sha256Hex(email.trim().toLowerCase());
    const keys = CODE_WINDOWS.map((window) => `${window.name}:${address}`);
    const rows = await Promise.all(keys.map((key) => allowances.read(key)));
    const current = CODE_WINDOWS.map((window, index) => {
        const row = rows[index];
        return row !== null && row !== undefined && now.getTime() - row.windowStart.getTime() < window.ms ? row : undefined;
    });
    if (CODE_WINDOWS.some((window, index) => (current[index]?.count ?? 0) >= window.max)) {
        return false;
    }
    await Promise.all(keys.map((key, index) => (current[index] === undefined ? allowances.restart(key, now) : allowances.increment(key))));
    return true;
};

// Rows whose every window has passed, for the retention sweep.
export const sweepCodeAllowances = (prisma: PrismaClient, now = new Date()): Promise<{ count: number }> =>
    prisma.signInCodeAllowance.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - Math.max(...CODE_WINDOWS.map((window) => window.ms))) } } });

type CodeDeps = { readonly config: Config; readonly allowances: CodeAllowances; readonly logger: Logger };

// Whether a code may be minted for this address at all, decided BEFORE Better Auth mints one: not for the canary's
// address (which nobody may sign in as), nor for one already sent its share of codes. A yes takes one from the
// allowance, so it is asked exactly once per code that goes out.
// (2026-11-21) Decided here, ahead of the code, rather than in `sendVerificationOTP`: Better Auth's send endpoint stores
// the new code first and only then asks the sender to mail it, so a send skipped for the allowance used to replace the
// code with one that was never mailed, and the code in the earlier mail stopped working (a reader who reloaded and
// pressed again within the minute was left with no code that signed in). Switching to `resendStrategy: "reuse"` was
// passed over: it needs the stored codes encrypted rather than hashed.
export const maySendSignInCode = async (deps: CodeDeps, rawEmail: string): Promise<boolean> => {
    const email = rawEmail.trim().toLowerCase();
    const address = sha256Hex(email).slice(0, 12);
    const canary = deps.config.hosted.canaryEmail.trim().toLowerCase();
    if (canary !== `` && email === canary) {
        deps.logger.warn({ address }, `sign-in code: refused for the canary's address, which nobody signs in as`);
        return false;
    }
    if (!(await takeCodeAllowance(deps.allowances, email))) {
        deps.logger.warn({ address }, `sign-in code: this address was sent its share of codes for now; not minting another`);
        return false;
    }
    return true;
};

export const SEND_CODE_PATH = `/email-otp/send-verification-otp`;

// A send the endpoint would mail, read as the endpoint reads it (lowercased, then checked as an address, untrimmed), so
// the gate takes no allowance for a request the endpoint goes on to refuse. Password and change-of-address codes are
// never mailed here, so they pass through untaken.
const SendCodeBodySchema = z.object({ email: z.string().toLowerCase().pipe(z.email()), type: z.enum([`sign-in`, `email-verification`]) });

// The gate in front of Better Auth's send endpoint: a refused address gets the answer a sent code gets (so the form says
// nothing about which addresses exist or were asked for), and no code is minted, so the one already mailed still works.
export const signInCodeGate = (deps: CodeDeps) =>
    ({
        id: `intentic-sign-in-code-gate`,
        hooks: {
            before: [
                {
                    matcher: (context) => context.path === SEND_CODE_PATH,
                    handler: createAuthMiddleware(async (ctx) => {
                        const body = SendCodeBodySchema.safeParse(ctx.body);
                        if (!body.success || (await maySendSignInCode(deps, body.data.email))) {
                            return;
                        }
                        return ctx.json({ success: true });
                    }),
                },
            ],
        },
    }) satisfies BetterAuthPlugin;

// Mails a code the gate above let through. The canary is checked again in case a send ever reaches here another way;
// the allowance is not, since the gate already took it for this code.
export const sendSignInCode = async (deps: Omit<CodeDeps, `allowances`>, request: { readonly email: string; readonly code: string }): Promise<void> => {
    const email = request.email.trim().toLowerCase();
    const address = sha256Hex(email).slice(0, 12);
    const canary = deps.config.hosted.canaryEmail.trim().toLowerCase();
    if (canary !== `` && email === canary) {
        deps.logger.warn({ address }, `sign-in code: refused for the canary's address, which nobody signs in as`);
        return;
    }
    const link = signInCodeLink(deps.config, email, request.code);
    const delivery = await sendMail(deps.config, deps.logger, {
        to: email,
        subject: `Your intentic sign-in code`,
        link,
        html: signInCodeEmail({ code: request.code, link, minutes: SIGN_IN_CODE_TTL_SECONDS / 60 }),
        forThisMachine: true,
    });
    if (delivery !== `sent`) {
        deps.logger.warn({ address, delivery }, `sign-in code: not mailed (development: the link above carries the code)`);
    }
};

export const hasGoogleAccount = async (prisma: Pick<PrismaClient, "account">, userId: string): Promise<boolean> =>
    (await prisma.account.count({ where: { userId, providerId: `google` } })) > 0;

// How this account can prove its address: Google when a Google account is linked to it, and email wherever this platform
// mails codes (any account may sign in with a code for its own address).
export const signInMethodsOf = (hasGoogle: boolean, config: Config): SignInMethod[] => {
    const methods: SignInMethod[] = [];
    if (hasGoogle) {
        methods.push(`google`);
    }
    if (emailSignInEnabled(config)) {
        methods.push(`email`);
    }
    return methods;
};

/* THE IDENTITY KEY: what the platform signs identity assertions with (sandbox.identityAssertion), and its public half,
answered to every announce so each sandbox can verify them. IDENTITY_SIGNING_KEY when it is set; otherwise a key derived
from BETTER_AUTH_SECRET with HKDF and a fixed label, as the hosted-standing hash key is (README), so a deployment that
leaves it unset still lets the people it signs in by email into their sandboxes. (2026-10-26: production ran without
one, and every member who signed in with a code met "try again in a moment" on every press, for good.) Rotating
BETTER_AUTH_SECRET rotates a derived key; sandboxes learn the new public half at their next announce. */

const IDENTITY_KEY_LABEL = `intentic identity assertion signing key v1`;
// An Ed25519 private key in PKCS8 DER is this prefix and then its 32-byte seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from(`302e020100300506032b657004220420`, `hex`);

let derivedFor: string | undefined;
let derivedKey: string | undefined;
const derivedSigningKey = (secret: string): string => {
    if (derivedFor !== secret || derivedKey === undefined) {
        const seed = Buffer.from(hkdfSync(`sha256`, secret, ``, IDENTITY_KEY_LABEL, 32));
        derivedKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: `der`, type: `pkcs8` })
            .export({ format: `pem`, type: `pkcs8` })
            .toString();
        derivedFor = secret;
    }
    return derivedKey;
};

// The private half, Ed25519 in PKCS8 PEM: the configured key, else the derived one.
export const identitySigningKeyOf = (config: Config): string =>
    config.identity.signingKey === `` ? derivedSigningKey(config.betterAuth.secret) : config.identity.signingKey;

// Its public half; derived rather than configured, so the two halves cannot drift.
let publicFrom: string | undefined;
let publicKey: string | undefined;
export const identityKeyOf = (config: Config): string => {
    const signingKey = identitySigningKeyOf(config);
    if (publicFrom !== signingKey || publicKey === undefined) {
        publicKey = publicKeyPemOf(signingKey);
        publicFrom = signingKey;
    }
    return publicKey;
};
