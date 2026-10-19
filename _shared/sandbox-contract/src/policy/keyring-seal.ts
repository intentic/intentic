import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
    KEYRING_GRANT_TTL_MAX_MS,
    KEYRING_KEY_RE,
    KeyringGrantSchema,
    type KeyringGrant,
    type SealedBox,
    SealedBoxSchema,
    type SignedKeyringGrant,
} from "../schemas/keyring.js";

// The two primitives a device-held secret rides on (schemas/keyring.ts): a SEALED BOX, a value only the holder of one
// X25519 key can open, and a GRANT, the sandbox's Ed25519-signed word for one use of one value. Shared by the daemon,
// which signs grants and opens what is sealed to it, and the keyring, which verifies grants and seals; one file so the
// two cannot drift on an encoding.

const SEAL_INFO = Buffer.from("intentic-keyring/seal/v1", "utf8");
const GRANT_DOMAIN = Buffer.from("intentic-keyring/grant/v1\0", "utf8");
// A clock on either side may run a little ahead; a grant from much further in the future is not one this sandbox made.
const GRANT_SKEW_MS = 30_000;

// A key pair as it is stored: both halves raw, base64url, the `x` and `d` of their JWK.
export interface KeyringKeyPair {
    readonly publicKey: string;
    readonly privateKey: string;
}

type Curve = "X25519" | "Ed25519";

// The halves of an OKP key's JWK, which Node always writes for a private key it just made.
const OkpJwkSchema = z.object({ x: z.string().regex(KEYRING_KEY_RE), d: z.string().regex(KEYRING_KEY_RE) });

const pairOf = (curve: Curve): KeyringKeyPair => {
    const { privateKey } = curve === "X25519" ? generateKeyPairSync("x25519") : generateKeyPairSync("ed25519");
    const jwk = OkpJwkSchema.parse(privateKey.export({ format: "jwk" }));
    return { publicKey: jwk.x, privateKey: jwk.d };
};

export const newSealKeyPair = (): KeyringKeyPair => pairOf("X25519");
export const newSignKeyPair = (): KeyringKeyPair => pairOf("Ed25519");

const publicKeyOf = (curve: Curve, x: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: curve, x }, format: "jwk" });
const privateKeyOf = (curve: Curve, pair: KeyringKeyPair): KeyObject =>
    createPrivateKey({ key: { kty: "OKP", crv: curve, x: pair.publicKey, d: pair.privateKey }, format: "jwk" });

// What a box is sealed FOR, mixed into its authentication tag: a box opened under any other purpose fails, so a value
// released for one grant cannot be presented as another's, nor a typing payload as an inbox item.
export type SealPurpose =
    | { readonly kind: "release"; readonly sandbox: string; readonly secret: string; readonly nonce: string }
    | { readonly kind: "type"; readonly sandbox: string; readonly secret: string; readonly nonce: string }
    | { readonly kind: "inbox"; readonly sandbox: string; readonly secret: string }
    | { readonly kind: "copy"; readonly sandbox: string; readonly secret: string; readonly updatedAt: number }
    | { readonly kind: "sync"; readonly account: string; readonly device: string; readonly revision: number }
    // A credential seen in use and sent to be kept (schemas/keyring.ts KeyringCaptureItem): bound to who saw it and when,
    // so a box lifted from one capture cannot be replayed as another's.
    | { readonly kind: "capture"; readonly via: string; readonly at: number }
    // A value released to a paired phone for one autofill (KeyringPhoneFill), bound to that request's nonce.
    | { readonly kind: "phone"; readonly device: string; readonly nonce: string };

export const sealAad = (purpose: SealPurpose): Buffer => {
    switch (purpose.kind) {
        case "release":
        case "type":
            return Buffer.from(`${purpose.kind}\0${purpose.sandbox}\0${purpose.secret}\0${purpose.nonce}`, "utf8");
        case "inbox":
            return Buffer.from(`inbox\0${purpose.sandbox}\0${purpose.secret}`, "utf8");
        case "copy":
            return Buffer.from(`copy\0${purpose.sandbox}\0${purpose.secret}\0${String(purpose.updatedAt)}`, "utf8");
        case "sync":
            return Buffer.from(`sync\0${purpose.account}\0${purpose.device}\0${String(purpose.revision)}`, "utf8");
        case "capture":
            return Buffer.from(`capture\0${purpose.via}\0${String(purpose.at)}`, "utf8");
        case "phone":
            return Buffer.from(`phone\0${purpose.device}\0${purpose.nonce}`, "utf8");
    }
};

const boxKey = (shared: Buffer, epk: string, recipient: string): Buffer =>
    Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(epk, "base64url"), Buffer.from(recipient, "base64url")]), SEAL_INFO, 32));

// Seals `plaintext` to the holder of `recipient`'s private half, for `purpose` alone, with a caller-chosen ephemeral
// key and IV. The phone app's unit tests and golden/keyring-seal.json call this with fixed inputs so Kotlin can match.
export const sealWithEphemeral = (
    recipient: string,
    plaintext: string,
    purpose: SealPurpose,
    ephemeralPair: KeyringKeyPair,
    iv: Buffer,
): SealedBox => {
    const shared = diffieHellman({ privateKey: privateKeyOf("X25519", ephemeralPair), publicKey: publicKeyOf("X25519", recipient) });
    const cipher = createCipheriv("aes-256-gcm", boxKey(shared, ephemeralPair.publicKey, recipient), iv);
    cipher.setAAD(sealAad(purpose));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
        v: 1,
        epk: ephemeralPair.publicKey,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: data.toString("base64url"),
    };
};

// Seals `plaintext` to the holder of `recipient`'s private half, for `purpose` alone.
export const seal = (recipient: string, plaintext: string, purpose: SealPurpose): SealedBox => {
    const ephemeral = newSealKeyPair();
    return sealWithEphemeral(recipient, plaintext, purpose, ephemeral, randomBytes(12));
};

// Opens a box sealed to `pair` for `purpose`; throws on any way of not being one (malformed, another key, another purpose).
export const unseal = (pair: KeyringKeyPair, box: SealedBox, purpose: SealPurpose): string => {
    const parsed = SealedBoxSchema.parse(box);
    const shared = diffieHellman({ privateKey: privateKeyOf("X25519", pair), publicKey: publicKeyOf("X25519", parsed.epk) });
    const decipher = createDecipheriv("aes-256-gcm", boxKey(shared, parsed.epk, pair.publicKey), Buffer.from(parsed.iv, "base64url"));
    decipher.setAAD(sealAad(purpose));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64url")), decipher.final()]).toString("utf8");
};

// A fresh grant's nonce: 16 random bytes, base64url.
export const grantNonce = (): string => randomBytes(16).toString("base64url");

export const signGrant = (pair: KeyringKeyPair, grant: KeyringGrant): SignedKeyringGrant => {
    const body = KeyringGrantSchema.parse(grant);
    if (body.expiresAt - body.issuedAt > KEYRING_GRANT_TTL_MAX_MS || body.expiresAt <= body.issuedAt) {
        throw new Error(`a keyring grant lives at most ${String(KEYRING_GRANT_TTL_MAX_MS / 1000)} s`);
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const sig = sign(null, Buffer.concat([GRANT_DOMAIN, payload]), privateKeyOf("Ed25519", pair));
    return { payload: payload.toString("base64url"), sig: sig.toString("base64url") };
};

export type GrantVerdict =
    | { readonly ok: true; readonly grant: KeyringGrant }
    | { readonly ok: false; readonly code: "bad-grant" | "expired"; readonly reason: string };

// Verifies `signed` against the sandbox's pinned signing key at `nowMs`. The keyring checks the nonce, the share and
// the target against its own facts; this says only whether the sandbox said it, and said it recently.
export const verifyGrant = (signKey: string, signed: SignedKeyringGrant, nowMs: number): GrantVerdict => {
    let payload: Buffer;
    try {
        payload = Buffer.from(signed.payload, "base64url");
        if (!verify(null, Buffer.concat([GRANT_DOMAIN, payload]), publicKeyOf("Ed25519", signKey), Buffer.from(signed.sig, "base64url"))) {
            return { ok: false, code: "bad-grant", reason: "the grant's signature is not the sandbox's" };
        }
    } catch {
        return { ok: false, code: "bad-grant", reason: "the grant could not be read" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload.toString("utf8"));
    } catch {
        return { ok: false, code: "bad-grant", reason: "the grant is not JSON" };
    }
    const grant = KeyringGrantSchema.safeParse(parsed);
    if (!grant.success) {
        return { ok: false, code: "bad-grant", reason: "the grant is not one this keyring knows how to read" };
    }
    const { issuedAt, expiresAt } = grant.data;
    if (expiresAt - issuedAt > KEYRING_GRANT_TTL_MAX_MS || expiresAt <= issuedAt || issuedAt > nowMs + GRANT_SKEW_MS) {
        return { ok: false, code: "bad-grant", reason: "the grant's times are not ones this sandbox would sign" };
    }
    if (expiresAt <= nowMs) {
        return { ok: false, code: "expired", reason: "the grant has expired: the sandbox asks again" };
    }
    return { ok: true, grant: grant.data };
};

// A short, readable fingerprint of a public key, for a person comparing what two screens show.
export const keyFingerprint = (key: string): string => {
    const raw = Buffer.from(key, "base64url");
    const hex = raw.subarray(0, 8).toString("hex").toUpperCase();
    return hex.replace(/(.{4})(?=.)/gu, "$1-");
};
