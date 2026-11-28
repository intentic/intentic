import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
    S2S_FINGERPRINT_PREFIX,
    S2S_RECOVERY_PREFIX,
    S2S_RECOVERY_SECRET_PREFIX,
    type S2sPublicKeys,
    type S2sSigningKeys,
} from "../../schemas/s2s-identity.js";
import { canonicalBytes, concatBytes, fromBase64Url, toBase32, toBase64Url } from "./canonical.js";

// A sandbox's hybrid key set: Ed25519 and ML-DSA-65 to sign, X25519 and ML-KEM-768 to agree keys. The secret half is
// kept as the four seeds each algorithm derives its key from (32, 32, 32 and 64 bytes), which is all that has to be
// stored; the expanded keys are derived again on load and held in memory.

// The secret half, base64url: each algorithm's seed.
export interface S2sSecretSeeds {
    readonly ed25519: string;
    readonly mldsa65: string;
    readonly x25519: string;
    readonly mlkem768: string;
}

// A key set as one holds it to sign and open: the public keys and fingerprint it publishes, the seeds it stores.
export interface S2sKeySet {
    readonly public: S2sPublicKeys;
    readonly secret: S2sSecretSeeds;
    readonly fingerprint: string;
}

// The expanded secret keys, raw: what signing and decapsulation take.
export interface S2sSecretKeys {
    readonly ed25519: Uint8Array;
    readonly mldsa65: Uint8Array;
    readonly x25519: Uint8Array;
    readonly mlkem768: Uint8Array;
}

// A recovery key: a signing pair alone, which only ever signs a new key set's `prev`.
export interface S2sRecoveryKey {
    readonly public: S2sSigningKeys;
    readonly fingerprint: string;
    // The two seeds as one string to keep off the sandbox: `isrs1.` and the base64url of ed25519 ‖ mldsa65.
    readonly secret: string;
    readonly ed25519: Uint8Array;
    readonly mldsa65: Uint8Array;
}

// The source of fresh bytes, a parameter so a test can make a key set it can name.
export type RandomBytes = (length: number) => Uint8Array;

const SEED_BYTES = { ed25519: 32, mldsa65: 32, x25519: 32, mlkem768: 64 } as const;

const fingerprintWith = (prefix: string, keys: S2sSigningKeys | S2sPublicKeys): string => `${prefix}${toBase32(sha256(canonicalBytes(keys)))}`;

// A key set's fingerprint: `isk1:` and the base32 of the SHA-256 over its canonical public keys.
export const fingerprintOf = (keys: S2sPublicKeys): string =>
    fingerprintWith(S2S_FINGERPRINT_PREFIX, { ed25519: keys.ed25519, mldsa65: keys.mldsa65, x25519: keys.x25519, mlkem768: keys.mlkem768 });

// A recovery key's fingerprint: `isr1:` and the base32 of the SHA-256 over its canonical public signing keys.
export const recoveryFingerprintOf = (keys: S2sSigningKeys): string => fingerprintWith(S2S_RECOVERY_PREFIX, { ed25519: keys.ed25519, mldsa65: keys.mldsa65 });

const seedOf = (seeds: S2sSecretSeeds, algorithm: keyof typeof SEED_BYTES): Uint8Array => {
    const seed = fromBase64Url(seeds[algorithm]);
    if (seed?.length !== SEED_BYTES[algorithm]) {
        throw new Error(`s2s key set: the ${algorithm} seed is not ${SEED_BYTES[algorithm]} bytes of base64url`);
    }
    return seed;
};

interface Expanded {
    readonly set: S2sKeySet;
    readonly secret: S2sSecretKeys;
}

// ML-DSA's key derivation costs milliseconds, so the few key sets a daemon holds are expanded once.
const EXPANDED_KEPT = 8;
const expanded = new Map<string, Expanded>();

const expand = (seeds: S2sSecretSeeds): Expanded => {
    const key = `${seeds.ed25519}.${seeds.mldsa65}.${seeds.x25519}.${seeds.mlkem768}`;
    const known = expanded.get(key);
    if (known !== undefined) {
        return known;
    }
    const edSeed = seedOf(seeds, "ed25519");
    const dsa = ml_dsa65.keygen(seedOf(seeds, "mldsa65"));
    const xSecret = seedOf(seeds, "x25519");
    const kem = ml_kem768.keygen(seedOf(seeds, "mlkem768"));
    const publicKeys: S2sPublicKeys = {
        ed25519: toBase64Url(ed25519.getPublicKey(edSeed)),
        mldsa65: toBase64Url(dsa.publicKey),
        x25519: toBase64Url(x25519.getPublicKey(xSecret)),
        mlkem768: toBase64Url(kem.publicKey),
    };
    const made: Expanded = {
        set: { public: publicKeys, secret: seeds, fingerprint: fingerprintOf(publicKeys) },
        secret: { ed25519: edSeed, mldsa65: dsa.secretKey, x25519: xSecret, mlkem768: kem.secretKey },
    };
    if (expanded.size >= EXPANDED_KEPT) {
        const oldest = expanded.keys().next();
        if (oldest.done !== true) {
            expanded.delete(oldest.value);
        }
    }
    expanded.set(key, made);
    return made;
};

// The key set the seeds derive: its public keys and fingerprint. Throws on a seed of the wrong length.
export const keySetFromSeeds = (seeds: S2sSecretSeeds): S2sKeySet => expand(seeds).set;

// The expanded secret keys the seeds derive, for signing and opening.
export const secretKeysOf = (seeds: S2sSecretSeeds): S2sSecretKeys => expand(seeds).secret;

// A fresh key set from fresh seeds.
export const generateKeySet = (random: RandomBytes = randomBytes): S2sKeySet =>
    keySetFromSeeds({
        ed25519: toBase64Url(random(SEED_BYTES.ed25519)),
        mldsa65: toBase64Url(random(SEED_BYTES.mldsa65)),
        x25519: toBase64Url(random(SEED_BYTES.x25519)),
        mlkem768: toBase64Url(random(SEED_BYTES.mlkem768)),
    });

const recoveryFrom = (edSeed: Uint8Array, dsaSeed: Uint8Array): S2sRecoveryKey => {
    const dsa = ml_dsa65.keygen(dsaSeed);
    const publicKeys: S2sSigningKeys = { ed25519: toBase64Url(ed25519.getPublicKey(edSeed)), mldsa65: toBase64Url(dsa.publicKey) };
    return {
        public: publicKeys,
        fingerprint: recoveryFingerprintOf(publicKeys),
        secret: `${S2S_RECOVERY_SECRET_PREFIX}${toBase64Url(concatBytes(edSeed, dsaSeed))}`,
        ed25519: edSeed,
        mldsa65: dsa.secretKey,
    };
};

// A fresh recovery key. Its `secret` is shown once and kept off the sandbox; only its public half and fingerprint stay.
export const generateRecoveryKey = (random: RandomBytes = randomBytes): S2sRecoveryKey =>
    recoveryFrom(random(SEED_BYTES.ed25519), random(SEED_BYTES.mldsa65));

// The recovery key a pasted secret stands for, or undefined when it is not one (surrounding whitespace forgiven).
export const recoveryKeyFromSecret = (secret: string): S2sRecoveryKey | undefined => {
    const text = secret.trim();
    if (!text.startsWith(S2S_RECOVERY_SECRET_PREFIX)) {
        return undefined;
    }
    const seeds = fromBase64Url(text.slice(S2S_RECOVERY_SECRET_PREFIX.length));
    if (seeds?.length !== SEED_BYTES.ed25519 + SEED_BYTES.mldsa65) {
        return undefined;
    }
    return recoveryFrom(seeds.slice(0, SEED_BYTES.ed25519), seeds.slice(SEED_BYTES.ed25519));
};
