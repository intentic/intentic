import { type SetupClaimer, SetupClaimerSchema } from "@intentic/api-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import { ENV_INGRESS_URL, ENV_SANDBOX_GRANT } from "@intentic/sandbox-contract/ingress-contract";
import type { Config } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { mintSetupCode } from "./mint-sandbox.js";
import { ENV_DEFINITION_SEED } from "./profiles/profiles.js";
import { ensureReachability, ingressEnabled } from "./reachability.js";
import { z } from "zod";

// THE CLAIM a machine redeems to become a sandbox, minted in one place because two doors ask for one: the owner's
// browser (sandbox.setupCode, a session) and an agent's provisioning token (/fleet/provision). Both must produce
// byte-identical payloads — `ic sandbox connect` reads exactly these keys and nothing tells it which door it came
// from — so the composition lives here rather than being written twice and kept in step by review.

// Long enough to retry a failed install command; short enough that a leaked pasted command goes stale fast.
export const SETUP_CODE_TTL_MS = 30 * 60 * 1000;

/** The platform has no reachability fabric, so no sandbox it mints for could be reached. Each door words its own refusal. */
export class ReachabilityUnavailable extends Error {}

export interface SetupCodeAsk {
    // Seeds the daemon's owner binding, so ownership always matches the intentic account rather than whoever first
    // opens the box.
    readonly ownerEmail: string;
    // A sandbox.toml the new box applies once, on a workspace that arrived empty. Carries repos, capability names and
    // an overlay the owner still approves there — never a credential, which is what makes it safe to put in a payload.
    readonly definitionSeed?: string | undefined;
}

export interface MintedSetupCode {
    readonly code: string;
    readonly hostname: string;
    readonly expiresAt: string;
}

/** A sandbox row as minting reads it: its identity, and whatever code it is already holding. */
export interface MintableSandbox {
    readonly id: string;
    readonly token: string;
    readonly setupCode: string | null;
    readonly setupCodeExpiresAt: Date | null;
    // A Json column, and the ciphertext this writes is a string in it; `unknown` rather than a narrower lie, since the
    // only read of it is the `typeof` that tells an encrypted payload from a row that never had one.
    readonly setupPayload: unknown;
}

// The KEY=value map `ic` reads out of its claim. Its exact bytes are also the identity of an ask, which is what the
// held-code check below compares against.
const payloadFor = (
    config: Config,
    sandbox: MintableSandbox,
    ask: SetupCodeAsk,
): { readonly payload: Record<string, string>; readonly hostname: string } => {
    const grant = ensureReachability(config, sandbox);
    const seeded = ask.definitionSeed !== undefined && ask.definitionSeed !== "";
    return {
        hostname: grant.hostname,
        payload: {
            [ENV_SANDBOX_GRANT]: grant.grant,
            [ENV_INGRESS_URL]: grant.ingressUrl,
            SANDBOX_HOSTNAME: grant.hostname,
            OWNER_EMAIL: ask.ownerEmail.toLowerCase(),
            ...(seeded ? { [ENV_DEFINITION_SEED]: ask.definitionSeed as string } : {}),
        },
    };
};

// Re-minting is NOT free, which is why an unchanged ask returns the live code untouched. Rotating it would orphan an
// install already under way: /setup/claim and /setup/report both find a sandbox BY its setup code, so the running
// machine's stage reports stop matching any row, and the claim stamp is the wizard's only evidence the command was
// ever pasted. The wizard mints on every mount, so without this a reload mid-install tells a reader "still nothing"
// about a machine that is pulling the image right then.
// `?? null` throughout: these columns are optional as well as nullable, and `undefined !== null` would read an
// unminted row as holding a live code.
const heldCodeFor = (config: Config, sandbox: MintableSandbox, payload: Record<string, string>, hostname: string): MintedSetupCode | undefined => {
    const held = sandbox.setupCode ?? null;
    const heldUntil = sandbox.setupCodeExpiresAt ?? null;
    if (held === null || heldUntil === null || heldUntil.getTime() <= Date.now() || typeof sandbox.setupPayload !== `string`) {
        return undefined;
    }
    // Ciphertext is not comparable (encryptSecret salts each call), so the plaintext is what settles it.
    return decryptSecret(config, sandbox.setupPayload) === JSON.stringify(payload)
        ? { code: held, hostname, expiresAt: heldUntil.toISOString() }
        : undefined;
};

export const mintSetupCodeFor = async (
    prisma: PrismaClient,
    config: Config,
    sandbox: MintableSandbox,
    ask: SetupCodeAsk,
): Promise<MintedSetupCode> => {
    if (!ingressEnabled(config)) {
        throw new ReachabilityUnavailable(`this platform has no reachability fabric configured`);
    }
    const { payload, hostname } = payloadFor(config, sandbox, ask);
    const held = heldCodeFor(config, sandbox, payload, hostname);
    if (held !== undefined) {
        return held;
    }
    const code = mintSetupCode();
    const expiresAt = new Date(Date.now() + SETUP_CODE_TTL_MS);
    // Claim stamp belongs to the code: a fresh code must start unclaimed, or the wizard would report a stale claim.
    await prisma.sandbox.update({
        where: { id: sandbox.id },
        data: {
            setupCode: code,
            setupCodeExpiresAt: expiresAt,
            setupCodeClaimedAt: null,
            // The machine that claimed the last code; a fresh code may go to any machine.
            setupClaimedBy: Prisma.DbNull,
            // Cleared here too: a fresh code means a fresh run, and last run's report would narrate the wrong one.
            setupReport: Prisma.DbNull,
            setupPayload: encryptSecret(config, JSON.stringify(payload)),
        },
    });
    return { code, hostname, expiresAt: expiresAt.toISOString() };
};

/* WHICH MACHINE REDEEMED THE CODE (2026-10-05). A code stays claimable for its thirty minutes so a failed run can be run
 * again, and the claim recorded nothing about who ran it, so the same command pasted into PowerShell and into WSL on one
 * PC (or on two PCs) started two containers on one token, which then took turns holding the sandbox's tunnel. An `ic`
 * new enough names the machine in its claim (SetupClaimerSchema: `host`, `os`, its own run's `instance`); the first claim
 * that names one is kept on the row (`setupClaimedBy`), and a later claim of the same code naming a DIFFERENT machine is
 * refused (`secondMachine`), while the same machine running it again is let through. A claim that names nothing is
 * never refused for it, and never recorded: nothing about it could be compared. Removing the first copy (its farewell
 * stamps `removedAt`) lets the code go to another machine, which is how a person moves a sandbox they set up in the
 * wrong place. */

export type HeldClaimer = SetupClaimer & { readonly at: string };

// One form field, trimmed and held to the contract's bounds; dropped when it is not one.
const claimerField = (schema: (typeof SetupClaimerSchema.shape)[keyof typeof SetupClaimerSchema.shape], value: unknown): string | undefined => {
    const parsed = schema.safeParse(typeof value === `string` ? value.trim() : undefined);
    return parsed.success && parsed.data !== `` ? parsed.data : undefined;
};

// What a claim's form says about the machine sending it; empty from an `ic` that names nothing.
export const claimerOf = (form: Readonly<Record<string, unknown>>): SetupClaimer => {
    const host = claimerField(SetupClaimerSchema.shape.host, form[`host`]);
    const os = claimerField(SetupClaimerSchema.shape.os, form[`os`]);
    const instance = claimerField(SetupClaimerSchema.shape.instance, form[`instance`]);
    return { ...(host === undefined ? {} : { host }), ...(os === undefined ? {} : { os }), ...(instance === undefined ? {} : { instance }) };
};

// Whether a claim names a machine at all: a run id alone says nothing about which machine it ran on.
export const namesMachine = (claimer: SetupClaimer): boolean => claimer.host !== undefined || claimer.os !== undefined;

// The row's record of the first claimer, or undefined for none (or one that no longer parses).
export const heldClaimerOf = (stored: unknown): HeldClaimer | undefined => {
    const parsed = SetupClaimerSchema.extend({ at: z.string() }).safeParse(stored);
    return parsed.success ? parsed.data : undefined;
};

// Another machine, as far as both claims say: a different name (case aside: Windows spells it in capitals, WSL does
// not) or a different side. Anything one of them leaves unsaid is not a difference.
const otherMachine = (held: SetupClaimer, next: SetupClaimer): boolean =>
    (held.host !== undefined && next.host !== undefined && held.host.toLowerCase() !== next.host.toLowerCase()) ||
    (held.os !== undefined && next.os !== undefined && held.os !== next.os);

const machineWords = (claimer: SetupClaimer): string =>
    claimer.os === undefined ? (claimer.host ?? `another machine`) : `${claimer.host ?? `a machine`} (${claimer.os})`;

/* The refusal's sentence when this claim would start a second copy, or undefined to let it through: the code was claimed
 * by a machine that named itself, no removal has been reported since, and this claim names a different one. */
export const secondMachine = (
    sandbox: { readonly setupCodeClaimedAt: Date | null; readonly setupClaimedBy: unknown; readonly removedAt: Date | null },
    next: SetupClaimer,
): string | undefined => {
    const held = heldClaimerOf(sandbox.setupClaimedBy);
    const claimedAt = sandbox.setupCodeClaimedAt;
    if (held === undefined || claimedAt === null || (sandbox.removedAt !== null && sandbox.removedAt >= claimedAt) || !otherMachine(held, next)) {
        return undefined;
    }
    const minutes = Math.max(1, Math.round((Date.now() - claimedAt.getTime()) / 60_000));
    return `this setup code was already used on ${machineWords(held)} ${minutes} minute${minutes === 1 ? `` : `s`} ago, and running it on ${machineWords(next)} as well would start a second copy of the same sandbox, the two taking turns at being reachable. If setup failed on ${machineWords(held)}, run the command there again; to move the sandbox here instead, remove it there first (ic sandbox remove) and run this command again.`;
};
