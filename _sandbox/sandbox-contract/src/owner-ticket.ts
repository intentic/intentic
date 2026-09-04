import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

/* THE OWNER TICKET: the platform's signed word for who owns a HOSTED sandbox, so the browser that just signed in
 * to the platform can sign in to that sandbox's daemon without being asked for Google a second time.
 *
 * THE RULE IT BENDS, AND WHY THAT IS ALLOWED HERE. Every sandbox authenticates its owner against Google itself
 * (the daemon's auth/auth.ts): the platform never holds or forges a daemon credential, so a platform breach can
 * read a sandbox's address and drive nothing. That rule stands for every lane but one. On the HOSTED lane the
 * platform already creates the machine, holds its power and its disk, and injects its owner's email into its
 * env before the daemon ever runs (ARCHITECTURE.md names this the stated exception). A platform that can already
 * open the machine gains no new power from being able to say "this browser is the owner" to it, and the user
 * gains the one thing the second Google prompt was costing: a sign-in that is one sign-in.
 *
 * So a hosted daemon, and only a hosted daemon, accepts a ticket the platform signs with the SAME Ed25519 key
 * that signs reachability grants (ingress-contract.ts), verified offline against the public half the machine's
 * env carries (ENV_PLATFORM_PUBLIC_KEY, set by the provisioner and by nothing else). The ticket names the
 * sandbox (its 12-hex id, which the daemon checks against its own) and the owner's email (which the daemon
 * checks against OWNER_EMAIL on first-bind, exactly as it checks a Google proof), and it expires in minutes:
 * it is spent once, on the daemon's /system/session, for the same daemon-minted session a Google proof buys.
 *
 * A different prefix from the grant's, so neither can ever be presented as the other: a grant verifies only as
 * a grant, a ticket only as a ticket, under one key. */

const TICKET_PREFIX = "ot1";

// Long enough for the exchange it exists for (one round trip to the daemon after the platform answers), short
// enough that a ticket lifted from a network log is worthless by the time anyone reads it.
export const OWNER_TICKET_TTL_MS = 5 * 60_000;

// The env var a hosted machine carries the platform's public key in (PEM, SPKI). Absent on every other lane,
// which is what keeps the ticket a hosted-only credential: a daemon with no key verifies no ticket.
export const ENV_PLATFORM_PUBLIC_KEY = "PLATFORM_PUBLIC_KEY";

const base64url = (bytes: Buffer): string => bytes.toString("base64url");
const SANDBOX_ID = /^[0-9a-f]{12}$/;

// The signed claim, times in seconds like the grant's.
export interface OwnerTicket {
    readonly sandboxId: string;
    readonly email: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
}

export const isOwnerTicket = (bearer: string): boolean => bearer.startsWith(`${TICKET_PREFIX}.`);

export const mintOwnerTicket = (
    privateKeyPem: string,
    claim: { readonly sandboxId: string; readonly email: string; readonly issuedAtMs: number; readonly ttlMs?: number },
): string => {
    if (!SANDBOX_ID.test(claim.sandboxId)) {
        throw new Error(`an owner ticket names a 12-hex sandbox id, got "${claim.sandboxId}"`);
    }
    if (claim.email === "") {
        throw new Error("an owner ticket names an owner");
    }
    const iat = Math.floor(claim.issuedAtMs / 1000);
    const exp = Math.floor((claim.issuedAtMs + (claim.ttlMs ?? OWNER_TICKET_TTL_MS)) / 1000);
    const payload = Buffer.from(JSON.stringify({ sub: claim.sandboxId, email: claim.email.toLowerCase(), iat, exp }), "utf8");
    const signature = edSign(null, payload, createPrivateKey(privateKeyPem));
    return `${TICKET_PREFIX}.${base64url(payload)}.${base64url(signature)}`;
};

/* Verify a ticket against the platform's public key, at `nowMs`. Undefined for every way of not being a valid
 * ticket: the wrong prefix, a bad signature, a malformed claim, or one past its expiry. The CALLER checks that
 * `sandboxId` is its own and that `email` is the owner it expects: those are the daemon's facts, not this
 * function's. */
export const verifyOwnerTicket = (publicKeyPem: string, token: string, nowMs: number): OwnerTicket | undefined => {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) {
        return undefined;
    }
    try {
        const payload = Buffer.from(parts[1] as string, "base64url");
        const signature = Buffer.from(parts[2] as string, "base64url");
        if (!edVerify(null, payload, createPublicKey(publicKeyPem), signature)) {
            return undefined;
        }
        const parsed = JSON.parse(payload.toString("utf8")) as { sub?: unknown; email?: unknown; iat?: unknown; exp?: unknown };
        if (
            typeof parsed.sub !== "string" ||
            !SANDBOX_ID.test(parsed.sub) ||
            typeof parsed.email !== "string" ||
            parsed.email === "" ||
            typeof parsed.iat !== "number" ||
            typeof parsed.exp !== "number"
        ) {
            return undefined;
        }
        if (parsed.exp * 1000 <= nowMs) {
            return undefined;
        }
        return { sandboxId: parsed.sub, email: parsed.email, issuedAt: parsed.iat, expiresAt: parsed.exp };
    } catch {
        return undefined;
    }
};

// The public half of the platform's signing key, in the PEM the daemon's env carries. Derived rather than
// configured: one key, two readers (the ingress and every hosted daemon), no second value to keep in step.
export const publicKeyPemOf = (privateKeyPem: string): string =>
    createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }) as string;
