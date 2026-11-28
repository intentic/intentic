import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import type { S2sPublicKeys } from "../../schemas/s2s-identity.js";
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from "./canonical.js";
import type { RandomBytes, S2sSecretKeys } from "./keys.js";

// The hybrid key agreement both envelopes and call sessions use: an ephemeral X25519 exchange and an ML-KEM-768
// encapsulation to the receiver's key set, their shared secrets combined by HKDF-SHA256 (ML-KEM's first), so the key
// holds while either family does.

// What the sender sends for it: its ephemeral X25519 public key and the ML-KEM ciphertext, base64url.
export interface HybridEncapsulation {
    readonly x25519: string;
    readonly mlkem768: string;
}

// The combined input keying material: mlkem_ss ‖ x25519_ss.
export type SharedSecret = Uint8Array;

// A fresh agreement: what the sender sends, and the secret both sides end up holding.
export interface Encapsulated {
    readonly enc: HybridEncapsulation;
    readonly secret: SharedSecret;
}

// A fresh agreement to the receiver's public keys: what to send, and the secret both sides will hold.
export const encapsulate = (to: Pick<S2sPublicKeys, "x25519" | "mlkem768">, random: RandomBytes = randomBytes): Encapsulated => {
    const theirX = fromBase64Url(to.x25519);
    const theirKem = fromBase64Url(to.mlkem768);
    if (theirX === undefined || theirKem === undefined) {
        throw new Error("s2s: the receiver's key-agreement keys are not base64url");
    }
    const ephemeral = random(32);
    const kem = ml_kem768.encapsulate(theirKem, random(32));
    return {
        enc: { x25519: toBase64Url(x25519.getPublicKey(ephemeral)), mlkem768: toBase64Url(kem.cipherText) },
        secret: concatBytes(kem.sharedSecret, x25519.getSharedSecret(ephemeral, theirX)),
    };
};

// The same secret on the receiving side, or undefined when the encapsulation is malformed (a key of the wrong length, a
// low-order X25519 point). ML-KEM decapsulation never fails outright: a wrong ciphertext yields a wrong secret, which
// the AEAD then refuses.
export const decapsulate = (enc: HybridEncapsulation, keys: Pick<S2sSecretKeys, "x25519" | "mlkem768">): SharedSecret | undefined => {
    const theirX = fromBase64Url(enc.x25519);
    const cipherText = fromBase64Url(enc.mlkem768);
    if (theirX === undefined || cipherText === undefined) {
        return undefined;
    }
    try {
        return concatBytes(ml_kem768.decapsulate(cipherText, keys.mlkem768), x25519.getSharedSecret(keys.x25519, theirX));
    } catch {
        // allow(silent-catch): the library throws on a malformed key or ciphertext; it is a key nobody can derive.
        return undefined;
    }
};

// A 32-byte key from the shared secret, salted with the hash of what it protects and bound to what it is for.
export const deriveKey = (secret: SharedSecret, salt: Uint8Array, info: string): Uint8Array => hkdf(sha256, secret, salt, utf8(info), 32);
