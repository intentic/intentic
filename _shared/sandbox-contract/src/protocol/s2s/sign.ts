import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { type HybridSig, S2S_INFO, type S2sSigningKeys } from "../../schemas/s2s-identity.js";
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from "./canonical.js";
import type { ExtensionSignDomain } from "./extension-sign.js";

// Hybrid signatures: Ed25519 and ML-DSA-65 over the same bytes, and a signature verifies only when both halves do, so it
// holds while either family does. Every signature names what it is for (its domain), so one made over an identity
// document can never be passed off as one over an envelope or a session.

export const SIGN_DOMAINS = ["identity", "identity-prev", "envelope", "session", "attestation"] as const;
export type SignDomain = (typeof SIGN_DOMAINS)[number];

// The secret signing keys, raw: an Ed25519 seed and an expanded ML-DSA-65 secret key (keys.ts secretKeysOf, or a
// recovery key).
export interface SigningSecret {
    readonly ed25519: Uint8Array;
    readonly mldsa65: Uint8Array;
}

// What is actually signed: the protocol, the domain and a newline, then the message.
export const signedBytes = (domain: SignDomain | ExtensionSignDomain, message: Uint8Array): Uint8Array => concatBytes(utf8(`${S2S_INFO} ${domain}\n`), message);

export const hybridSign = (domain: SignDomain | ExtensionSignDomain, message: Uint8Array, secret: SigningSecret): HybridSig => {
    const bytes = signedBytes(domain, message);
    return { ed25519: toBase64Url(ed25519.sign(bytes, secret.ed25519)), mldsa65: toBase64Url(ml_dsa65.sign(bytes, secret.mldsa65)) };
};

const verifiesWith = (verify: () => boolean): boolean => {
    try {
        return verify();
    } catch {
        // allow(silent-catch): a key or signature of the wrong length throws in the library; it verifies nothing.
        return false;
    }
};

// True only when both halves verify over the domain's bytes with these public keys; any malformed part is false.
export const hybridVerify = (domain: SignDomain | ExtensionSignDomain, message: Uint8Array, sig: HybridSig, keys: S2sSigningKeys): boolean => {
    const parts = {
        edSig: fromBase64Url(sig.ed25519),
        dsaSig: fromBase64Url(sig.mldsa65),
        edKey: fromBase64Url(keys.ed25519),
        dsaKey: fromBase64Url(keys.mldsa65),
    };
    const { edSig, dsaSig, edKey, dsaKey } = parts;
    if (edSig === undefined || dsaSig === undefined || edKey === undefined || dsaKey === undefined) {
        return false;
    }
    const bytes = signedBytes(domain, message);
    // RFC 8032's strict reading, not ZIP 215's: one signature per message and key, no other encodings of it.
    return verifiesWith(() => ed25519.verify(edSig, bytes, edKey, { zip215: false })) && verifiesWith(() => ml_dsa65.verify(dsaSig, bytes, dsaKey));
};
