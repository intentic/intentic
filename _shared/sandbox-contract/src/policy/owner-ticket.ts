import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { SANDBOX_ID } from "../ids/tunnel-ids.js";

// The platform's signed word for who owns a HOSTED sandbox, so a signed-in browser skips a second Google prompt. A
// hosted-only exception: the platform already controls the machine, so gains no new power by vouching for its owner
// too. Signed with the grant's own Ed25519 key but a different prefix; short-lived, spent once.

const TICKET_PREFIX = "ot1";

// Long enough for one round trip to the daemon; short enough a ticket lifted from a log is worthless when read.
export const OWNER_TICKET_TTL_MS = 5 * 60_000;

// The env var carrying the platform's key on a hosted machine; absent elsewhere, keeping this hosted-only.
export const ENV_PLATFORM_PUBLIC_KEY = "PLATFORM_PUBLIC_KEY";

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

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

// Verifies a ticket against the platform's public key at nowMs; undefined for any way of being invalid (wrong prefix,
// bad signature, malformed claim, expired). The caller checks sandboxId and email against its own facts.
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

// The platform's public signing key, derived not configured: one key, two readers, nothing to keep in sync.
export const publicKeyPemOf = (privateKeyPem: string): string =>
    createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }) as string;
