import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { S2sBase64UrlSchema } from "../../schemas/s2s-identity.js";
import { canonicalBytes, concatBytes, equalBytes, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./canonical.js";

// A PASSKEY CO-SIGNATURE ON AN APPROVAL (2026-11-28, docs/architecture/messages.md "Identity"): proof that a person
// approved one item of the approvals queue with their own passkey, which anyone holding it can check without the
// sandbox. The daemon runs an ordinary WebAuthn assertion whose challenge is not a random nonce but the digest of what
// was approved (cosignChallengeBytes), keeps the assertion with the recorded yes, and hands it to the extension carrying
// the item out (`ApprovedAction.cosign`), which may publish it beside what it did.
//
// The challenge is SHA-256 over the canonical JSON (canonical.ts) of
//     { v: 1, sandbox, item, digest, purpose: "intentic-approval/1" }
// where `sandbox` is the sandbox's id as its identity document names it, `item` the approval's id and `digest` the
// performer's SHA-256 of exactly what it will do. The browser signs `authenticatorData || SHA-256(clientDataJSON)`, and
// clientDataJSON carries that challenge in base64url; so the signature binds the passkey to this sandbox, this item and
// this digest, and to nothing else. Pure: WebCrypto (`globalThis.crypto.subtle`) verifies the signature under Node, Bun
// and a browser alike, and no curve library loads with the schema.

// Mixed into the challenge so no other WebAuthn ceremony's challenge (a sign-in's random 32 bytes) is ever this one.
export const PASSKEY_COSIGN_PURPOSE = "intentic-approval/1";

// COSE algorithm ids a passkey signs with: ES256, EdDSA (Ed25519) and RS256, the three the sandbox registers.
export const PasskeyCosignAlgSchema = z.union([z.literal(-7), z.literal(-8), z.literal(-257)]);

export const PasskeyCosignChallengeSchema = z
    .object({
        v: z.literal(1),
        sandbox: z.string().min(1).max(200).describe("The sandbox's id, as its identity document names it."),
        item: z.string().min(1).max(200).describe("The approval's id in the queue."),
        digest: z.string().min(1).max(200).describe("The performer's SHA-256 of exactly what it will do, hex."),
    })
    .describe("What the passkey approved: which sandbox, which item, which digest.");
export type PasskeyCosignChallenge = z.infer<typeof PasskeyCosignChallengeSchema>;

export const PasskeyCosignSchema = z
    .object({
        v: z.literal(1),
        challenge: PasskeyCosignChallengeSchema,
        credentialId: S2sBase64UrlSchema.describe("The passkey's credential id."),
        publicKey: z
            .object({ alg: PasskeyCosignAlgSchema, jwk: z.record(z.string(), z.string()) })
            .describe("The passkey's public key as the sandbox registered it: a COSE algorithm and the key as a JWK."),
        rpId: z.string().min(1).max(253).describe("The site the passkey is scoped to (the editor's host)."),
        authenticatorData: S2sBase64UrlSchema,
        clientDataJSON: S2sBase64UrlSchema,
        signature: S2sBase64UrlSchema,
        label: z.string().max(200).optional().describe("The passkey's name, as its holder gave it. Never their email."),
    })
    .describe("A person's passkey assertion over an approval: anyone verifies it with verifyPasskeyCosign, no sandbox needed.");
export type PasskeyCosign = z.infer<typeof PasskeyCosignSchema>;

// The 32 bytes the authenticator is handed as its challenge for this approval.
export const cosignChallengeBytes = (challenge: PasskeyCosignChallenge): Uint8Array =>
    sha256(canonicalBytes({ v: challenge.v, sandbox: challenge.sandbox, item: challenge.item, digest: challenge.digest, purpose: PASSKEY_COSIGN_PURPOSE }));

// What WebAuthn's options carry as `challenge` and clientDataJSON repeats back: the bytes in base64url.
export const cosignChallenge = (challenge: PasskeyCosignChallenge): string => toBase64Url(cosignChallengeBytes(challenge));

export type PasskeyCosignCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): PasskeyCosignCheck => ({ ok: false, reason });

// An ES256 signature as WebAuthn sends it (ASN.1 DER: SEQUENCE { INTEGER r, INTEGER s }) in the raw r ‖ s form
// WebCrypto verifies, each 32 bytes; undefined for anything that is not exactly that.
const rawEcdsa = (der: Uint8Array): Uint8Array | undefined => {
    let at = 0;
    const take = (): number | undefined => (at < der.length ? der[at++] : undefined);
    const integer = (): Uint8Array | undefined => {
        const length = take() === 0x02 ? take() : undefined;
        if (length === undefined || length < 1 || length > 33 || at + length > der.length) {
            return undefined;
        }
        const bytes = der.slice(at, at + length);
        at += length;
        const trimmed = bytes.length === 33 && bytes[0] === 0 ? bytes.slice(1) : bytes;
        if (trimmed.length > 32) {
            return undefined;
        }
        const out = new Uint8Array(32);
        out.set(trimmed, 32 - trimmed.length);
        return out;
    };
    if (take() !== 0x30 || take() !== der.length - 2) {
        return undefined;
    }
    const r = integer();
    const s = integer();
    return r === undefined || s === undefined || at !== der.length ? undefined : concatBytes(r, s);
};

// A copy into a fresh ArrayBuffer, the BufferSource every WebCrypto signature takes whatever view it was handed.
const buffer = (bytes: Uint8Array): ArrayBuffer => {
    const out = new ArrayBuffer(bytes.length);
    new Uint8Array(out).set(bytes);
    return out;
};

// The JWK WebCrypto imports for a stored key, its members checked to be what its algorithm needs; undefined otherwise.
const importable = (publicKey: PasskeyCosign["publicKey"]): JsonWebKey | undefined => {
    const { kty, crv, x, y, n, e } = publicKey.jwk;
    if (publicKey.alg === -7) {
        return kty === "EC" && crv === "P-256" && x !== undefined && y !== undefined ? { kty, crv, x, y } : undefined;
    }
    if (publicKey.alg === -8) {
        return kty === "OKP" && crv === "Ed25519" && x !== undefined ? { kty, crv, x } : undefined;
    }
    return kty === "RSA" && n !== undefined && e !== undefined ? { kty, n, e } : undefined;
};

// Whether `signature` is the key's over `signed`, by its algorithm; false for a key or signature that does not import.
const signatureVerifies = async (publicKey: PasskeyCosign["publicKey"], signed: Uint8Array, signature: Uint8Array): Promise<boolean> => {
    const { subtle } = globalThis.crypto;
    const jwk = importable(publicKey);
    if (jwk === undefined) {
        return false;
    }
    try {
        if (publicKey.alg === -7) {
            const raw = rawEcdsa(signature);
            const key = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
            return raw !== undefined && (await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, buffer(raw), buffer(signed)));
        }
        if (publicKey.alg === -8) {
            const key = await subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
            return await subtle.verify({ name: "Ed25519" }, key, buffer(signature), buffer(signed));
        }
        const key = await subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        return await subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, buffer(signature), buffer(signed));
    } catch {
        // allow(silent-catch): a key WebCrypto cannot import, or a signature it cannot read, verifies nothing
        return false;
    }
};

// clientDataJSON's type and challenge, or undefined when it is not JSON naming both as strings.
const clientDataOf = (bytes: Uint8Array): { readonly type: string; readonly challenge: string } | undefined => {
    try {
        const parsed = z.object({ type: z.string(), challenge: z.string() }).safeParse(JSON.parse(fromUtf8(bytes)));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): bytes that are not UTF-8 JSON are no client data, which the caller refuses
        return undefined;
    }
};

// The authenticator data's flag byte: user present, user verified (a PIN or biometric).
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;

/**
 * Whether `cosign` is a passkey's approval of `expected`: the challenge it embeds names this sandbox, this digest (and
 * this item, when given); clientDataJSON is a `webauthn.get` over that challenge; the authenticator data is scoped to
 * `rpId` with the person present and verified; and the signature over `authenticatorData || SHA-256(clientDataJSON)`
 * verifies under the embedded key. It does not say whose key that is (compare `credentialId` or the key with one you
 * trust) nor which origin ran the ceremony, which only the sandbox that asked could check.
 */
export const verifyPasskeyCosign = async (
    cosign: PasskeyCosign,
    expected: { readonly sandbox: string; readonly digest: string; readonly item?: string | undefined },
): Promise<PasskeyCosignCheck> => {
    const parsed = PasskeyCosignSchema.safeParse(cosign);
    if (!parsed.success) {
        return refuse("not a passkey co-signature");
    }
    const { challenge, rpId, publicKey } = parsed.data;
    if (challenge.sandbox !== expected.sandbox || challenge.digest !== expected.digest || (expected.item !== undefined && challenge.item !== expected.item)) {
        return refuse("it approved another sandbox, item or digest");
    }
    const authenticatorData = fromBase64Url(parsed.data.authenticatorData);
    const clientDataJSON = fromBase64Url(parsed.data.clientDataJSON);
    const signature = fromBase64Url(parsed.data.signature);
    if (authenticatorData === undefined || clientDataJSON === undefined || signature === undefined) {
        return refuse("a part of it is not base64url");
    }
    const clientData = clientDataOf(clientDataJSON);
    if (clientData?.type !== "webauthn.get") {
        return refuse("its client data is not a WebAuthn assertion (webauthn.get)");
    }
    if (clientData.challenge !== cosignChallenge(challenge)) {
        return refuse("the passkey signed another challenge than this approval's");
    }
    if (authenticatorData.length < 37 || !equalBytes(authenticatorData.slice(0, 32), sha256(utf8(rpId)))) {
        return refuse(`the passkey is scoped to another site than ${rpId}`);
    }
    const flags = authenticatorData[32] ?? 0;
    if ((flags & USER_PRESENT) === 0 || (flags & USER_VERIFIED) === 0) {
        return refuse("the authenticator did not confirm the person was present and verified");
    }
    const signed = concatBytes(authenticatorData, sha256(clientDataJSON));
    return (await signatureVerifies(publicKey, signed, signature)) ? { ok: true } : refuse("the signature does not verify under its key");
};
