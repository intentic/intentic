import { S2sFingerprintSchema, S2sPublicKeysSchema, S2sRecoveryFingerprintSchema } from "../../schemas/s2s-identity.js";
import { fromBase64Url } from "./canonical.js";
import { fingerprintOf, generateKeySet, keySetFromSeeds, recoveryFingerprintOf, recoveryKeyFromSecret } from "./keys.js";
import { keySetFor, recoveryKeyFor, seededRandom } from "./s2s.testing.js";

describe("a hybrid key set", () => {
    it("holds four public keys of each algorithm's length and four seeds", () => {
        const set = keySetFor(`ops`);
        expect(S2sPublicKeysSchema.parse(set.public)).toEqual(set.public);
        expect(fromBase64Url(set.public.ed25519)?.length).toBe(32);
        expect(fromBase64Url(set.public.mldsa65)?.length).toBe(1952);
        expect(fromBase64Url(set.public.x25519)?.length).toBe(32);
        expect(fromBase64Url(set.public.mlkem768)?.length).toBe(1184);
        expect(Object.fromEntries(Object.entries(set.secret).map(([name, seed]) => [name, fromBase64Url(seed)?.length]))).toEqual({
            ed25519: 32,
            mldsa65: 32,
            x25519: 32,
            mlkem768: 64,
        });
    });

    it("is derived again, whole, from the seeds alone", () => {
        const set = keySetFor(`ops`);
        expect(keySetFromSeeds({ ...set.secret })).toEqual(set);
    });

    it("is the same set for the same randomness and another for other randomness", () => {
        expect(generateKeySet(seededRandom(`a`)).fingerprint).toBe(generateKeySet(seededRandom(`a`)).fingerprint);
        expect(generateKeySet(seededRandom(`a`)).fingerprint).not.toBe(generateKeySet(seededRandom(`b`)).fingerprint);
        expect(generateKeySet().fingerprint).not.toBe(generateKeySet().fingerprint);
    });

    it("refuses a seed of the wrong length", () => {
        const set = keySetFor(`ops`);
        expect(() => keySetFromSeeds({ ...set.secret, mlkem768: set.secret.x25519 })).toThrow(`s2s key set: the mlkem768 seed is not 64 bytes of base64url`);
    });
});

describe("a fingerprint", () => {
    it("is isk1: and 52 base32 characters over the canonical public keys, whatever order they were listed in", () => {
        const set = keySetFor(`ops`);
        expect(S2sFingerprintSchema.safeParse(set.fingerprint).success).toBe(true);
        const { ed25519, mldsa65, x25519, mlkem768 } = set.public;
        expect(fingerprintOf({ mlkem768, x25519, mldsa65, ed25519 })).toBe(set.fingerprint);
    });

    it("changes when any one key does", () => {
        const set = keySetFor(`ops`);
        const other = keySetFor(`other`);
        for (const name of [`ed25519`, `mldsa65`, `x25519`, `mlkem768`] as const) {
            expect(fingerprintOf({ ...set.public, [name]: other.public[name] })).not.toBe(set.fingerprint);
        }
    });
});

describe("a recovery key", () => {
    it("is a signing pair whose fingerprint is isr1:, never an isk1: one", () => {
        const recovery = recoveryKeyFor(`ops`);
        expect(S2sRecoveryFingerprintSchema.safeParse(recovery.fingerprint).success).toBe(true);
        expect(recovery.fingerprint.startsWith(`isr1:`)).toBe(true);
        expect(recoveryFingerprintOf(recovery.public)).toBe(recovery.fingerprint);
    });

    it("comes back whole from its pasted secret, whitespace forgiven", () => {
        const recovery = recoveryKeyFor(`ops`);
        expect(recovery.secret.startsWith(`isrs1.`)).toBe(true);
        expect(recoveryKeyFromSecret(`  ${recovery.secret}\n`)).toEqual(recovery);
    });

    it("refuses a secret without its prefix, cut short, or carrying a stray character", () => {
        const { secret } = recoveryKeyFor(`ops`);
        expect(recoveryKeyFromSecret(secret.slice(`isrs1.`.length))).toBeUndefined();
        expect(recoveryKeyFromSecret(secret.slice(0, -4))).toBeUndefined();
        expect(recoveryKeyFromSecret(`${secret.slice(0, 10)}+${secret.slice(11)}`)).toBeUndefined();
    });
});
