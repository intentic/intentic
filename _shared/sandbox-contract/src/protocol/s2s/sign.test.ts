import { fromBase64Url, toBase64Url, utf8 } from "./canonical.js";
import { secretKeysOf } from "./keys.js";
import { keySetFor } from "./s2s.testing.js";
import { hybridSign, hybridVerify, signedBytes } from "./sign.js";

const set = keySetFor(`ops`);
const other = keySetFor(`other`);
const message = utf8(`the bytes that matter`);
const sig = hybridSign(`envelope`, message, secretKeysOf(set.secret));

// The signature with one byte of one half changed.
const flipped = (half: string, at: number): string => {
    const bytes = fromBase64Url(half) ?? new Uint8Array();
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    return toBase64Url(bytes);
};

describe("a hybrid signature", () => {
    it("verifies with the signer's keys over the same domain and bytes", () => {
        expect(fromBase64Url(sig.ed25519)?.length).toBe(64);
        expect(fromBase64Url(sig.mldsa65)?.length).toBe(3309);
        expect(hybridVerify(`envelope`, message, sig, set.public)).toBe(true);
    });

    it("binds the domain, so a signature over an envelope is none over an identity", () => {
        expect(hybridVerify(`identity`, message, sig, set.public)).toBe(false);
        expect(signedBytes(`session`, utf8(`x`))).toEqual(utf8(`intentic-s2s/1 session\nx`));
    });

    it("does not verify with another key set", () => {
        expect(hybridVerify(`envelope`, message, sig, other.public)).toBe(false);
        expect(hybridVerify(`envelope`, message, sig, { ed25519: set.public.ed25519, mldsa65: other.public.mldsa65 })).toBe(false);
        expect(hybridVerify(`envelope`, message, sig, { ed25519: other.public.ed25519, mldsa65: set.public.mldsa65 })).toBe(false);
    });

    it("does not verify on either algorithm's half alone: the other half from another signer fails it", () => {
        const theirs = hybridSign(`envelope`, message, secretKeysOf(other.secret));
        expect(hybridVerify(`envelope`, message, { ed25519: sig.ed25519, mldsa65: theirs.mldsa65 }, set.public)).toBe(false);
        expect(hybridVerify(`envelope`, message, { ed25519: theirs.ed25519, mldsa65: sig.mldsa65 }, set.public)).toBe(false);
        expect(hybridVerify(`envelope`, message, { ed25519: sig.ed25519, mldsa65: `` }, set.public)).toBe(false);
        expect(hybridVerify(`envelope`, message, { ed25519: ``, mldsa65: sig.mldsa65 }, set.public)).toBe(false);
    });

    it("fails for any changed byte of the message", () => {
        for (let at = 0; at < message.length; at++) {
            const changed = message.slice();
            changed[at] = (changed[at] ?? 0) ^ 0x80;
            expect(hybridVerify(`envelope`, changed, sig, set.public)).toBe(false);
        }
    });

    it("fails for any changed byte of the Ed25519 half, and for changed bytes across the ML-DSA half", () => {
        for (let at = 0; at < 64; at++) {
            expect(hybridVerify(`envelope`, message, { ...sig, ed25519: flipped(sig.ed25519, at) }, set.public)).toBe(false);
        }
        for (const at of [0, 1, 640, 1500, 2420, 3000, 3307, 3308]) {
            expect(hybridVerify(`envelope`, message, { ...sig, mldsa65: flipped(sig.mldsa65, at) }, set.public)).toBe(false);
        }
    });

    it("answers false, never throws, for halves and keys that are not base64url or of the wrong length", () => {
        expect(hybridVerify(`envelope`, message, { ...sig, ed25519: `not base64!` }, set.public)).toBe(false);
        expect(hybridVerify(`envelope`, message, { ...sig, mldsa65: sig.mldsa65.slice(0, 100) }, set.public)).toBe(false);
        expect(hybridVerify(`envelope`, message, sig, { ...set.public, ed25519: set.public.ed25519.slice(0, 20) })).toBe(false);
    });
});
