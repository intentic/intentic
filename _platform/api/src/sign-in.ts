import type { SignInMethod, SignInOptions } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import type { Logger } from "pino";
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
// (_editor/web /login/confirm), so a scanner that opens every link in a mail signs nobody in.
export const signInCodeLink = (config: Config, email: string, code: string): string => {
    const link = new URL(`/login/confirm`, config.webOrigin);
    link.searchParams.set(`email`, email);
    link.searchParams.set(`code`, code);
    return link.toString();
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

// Mails a sign-in code, or quietly does not: the address is the canary's (which nobody may sign in as), or it was sent
// its share of codes already. Either way the asker hears what they would have heard, so the form says nothing about
// which addresses exist or were asked for.
export const sendSignInCode = async (
    deps: { readonly config: Config; readonly allowances: CodeAllowances; readonly logger: Logger },
    request: { readonly email: string; readonly code: string },
): Promise<void> => {
    const email = request.email.trim().toLowerCase();
    const address = sha256Hex(email).slice(0, 12);
    const canary = deps.config.hosted.canaryEmail.trim().toLowerCase();
    if (canary !== `` && email === canary) {
        deps.logger.warn({ address }, `sign-in code: refused for the canary's address, which nobody signs in as`);
        return;
    }
    if (!(await takeCodeAllowance(deps.allowances, email))) {
        deps.logger.warn({ address }, `sign-in code: this address was sent its share of codes for now; not sending another`);
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

// The public half of the identity key, answered to every announce so each sandbox can verify assertions; undefined on a
// platform that signs none. Derived rather than configured, so the two halves cannot drift.
let derivedFrom: string | undefined;
let derived: string | undefined;
export const identityKeyOf = (config: Config): string | undefined => {
    if (config.identity.signingKey === ``) {
        return undefined;
    }
    if (derivedFrom !== config.identity.signingKey) {
        derived = publicKeyPemOf(config.identity.signingKey);
        derivedFrom = config.identity.signingKey;
    }
    return derived;
};
