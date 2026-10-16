import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { SANDBOX_ID } from "../ids/tunnel-ids.js";

// The platform's signed word that a signed-in person controls an email address, spent on one sandbox's daemon. It is how
// an address no identity provider vouches for (a custom domain on Fastmail, Proton, a company's own mail server) reaches
// a sandbox: the platform confirmed the address by mailing it a code, and nobody else could. The daemon accepts it only
// where its owner opted in for that person (the owner record or the member row says `emailSignIn`), and on hosted
// machines, where the platform already holds the machine. Signed with a key of its own (IDENTITY_SIGNING_KEY), never the
// ingress key, so neither credential can stand in for the other.

const ASSERTION_PREFIX = "pa1";

// One round trip to the daemon and a retry; a lifted assertion is dead before anyone reads the log it sat in.
export const IDENTITY_ASSERTION_TTL_MS = 2 * 60_000;
// The longest life a daemon accepts whatever the claim says, so a platform minting with a wrong clock or a wrong ttl
// still cannot hand out a credential that outlives a replay window the daemon can hold in memory.
export const IDENTITY_ASSERTION_MAX_TTL_MS = 5 * 60_000;

// The env var that carries the platform's identity key on a hosted machine, which boots before its first announce. A
// sandbox on its owner's own machine learns the same key from the announce answer (`AnnounceAcceptedSchema`).
export const ENV_PLATFORM_IDENTITY_KEY = "PLATFORM_IDENTITY_KEY";

// How the platform confirmed the address it vouches for: a code it mailed, or a Google sign-in it verified.
export const IdentityAssertionMethodSchema = z.enum(["email", "google"]);
export type IdentityAssertionMethod = z.infer<typeof IdentityAssertionMethodSchema>;

// The signed claim, times in seconds like the owner ticket's. `nonce` is unique per mint: the daemon spends each once.
export interface IdentityAssertion {
    readonly sandboxId: string;
    readonly email: string;
    readonly method: IdentityAssertionMethod;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly nonce: string;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

// The prefix is part of what is signed, so an assertion is never a valid signature over anything else the same key
// might one day sign, and an owner ticket or a grant (which sign their bare payload) is never an assertion.
const signedBytes = (payload: Buffer): Buffer => Buffer.concat([Buffer.from(`${ASSERTION_PREFIX}.`, "utf8"), payload]);

export const isIdentityAssertion = (bearer: string): boolean => bearer.startsWith(`${ASSERTION_PREFIX}.`);

export const mintIdentityAssertion = (
    privateKeyPem: string,
    claim: {
        readonly sandboxId: string;
        readonly email: string;
        readonly method: IdentityAssertionMethod;
        readonly issuedAtMs: number;
        readonly ttlMs?: number;
    },
): string => {
    if (!SANDBOX_ID.test(claim.sandboxId)) {
        throw new Error(`an identity assertion names a 12-hex sandbox id, got "${claim.sandboxId}"`);
    }
    if (claim.email.trim() === "") {
        throw new Error("an identity assertion names an address");
    }
    const ttlMs = claim.ttlMs ?? IDENTITY_ASSERTION_TTL_MS;
    if (ttlMs <= 0 || ttlMs > IDENTITY_ASSERTION_MAX_TTL_MS) {
        throw new Error(`an identity assertion lives at most ${IDENTITY_ASSERTION_MAX_TTL_MS} ms`);
    }
    const iat = Math.floor(claim.issuedAtMs / 1000);
    const exp = Math.floor((claim.issuedAtMs + ttlMs) / 1000);
    const payload = Buffer.from(
        JSON.stringify({
            v: 1,
            sub: claim.sandboxId,
            email: claim.email.trim().toLowerCase(),
            amr: claim.method,
            iat,
            exp,
            jti: base64url(randomBytes(16)),
        }),
        "utf8",
    );
    const signature = edSign(null, signedBytes(payload), createPrivateKey(privateKeyPem));
    return `${ASSERTION_PREFIX}.${base64url(payload)}.${base64url(signature)}`;
};

// What the signed payload must be, read only after the signature checked out.
const AssertionPayloadSchema = z.object({
    v: z.literal(1),
    sub: z.string().regex(SANDBOX_ID),
    email: z.string().min(1),
    amr: IdentityAssertionMethodSchema,
    iat: z.number(),
    exp: z.number(),
    jti: z.string().min(16),
});

const parsePayload = (payload: Buffer): z.infer<typeof AssertionPayloadSchema> | undefined => parseJsonWith(payload.toString("utf8"), AssertionPayloadSchema);

// Verifies an assertion against the platform's public key at nowMs; undefined for any way of being invalid (wrong
// prefix, bad signature, malformed claim, expired, issued in the future, living longer than the daemon allows). The
// caller checks sandboxId against its own id and spends the nonce.
export const verifyIdentityAssertion = (publicKeyPem: string, token: string, nowMs: number): IdentityAssertion | undefined => {
    const [prefix, encodedPayload, encodedSignature, ...rest] = token.split(".");
    if (prefix !== ASSERTION_PREFIX || encodedPayload === undefined || encodedSignature === undefined || rest.length > 0) {
        return undefined;
    }
    const payload = Buffer.from(encodedPayload, "base64url");
    try {
        if (!edVerify(null, signedBytes(payload), createPublicKey(publicKeyPem), Buffer.from(encodedSignature, "base64url"))) {
            return undefined;
        }
    } catch {
        // allow(silent-catch): a key or signature that does not parse verifies nothing: the assertion is invalid, said as undefined.
        return undefined;
    }
    const claim = parsePayload(payload);
    if (claim === undefined) {
        return undefined;
    }
    // A minute of clock skew either way, as the daemon allows Google's tokens; never a claim from further ahead.
    if (claim.exp * 1000 <= nowMs || claim.iat * 1000 > nowMs + 60_000 || (claim.exp - claim.iat) * 1000 > IDENTITY_ASSERTION_MAX_TTL_MS) {
        return undefined;
    }
    return { sandboxId: claim.sub, email: claim.email, method: claim.amr, issuedAt: claim.iat, expiresAt: claim.exp, nonce: claim.jti };
};
