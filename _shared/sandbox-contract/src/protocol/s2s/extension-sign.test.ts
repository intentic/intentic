import { canonicalBytes, fromBase64Url, utf8 } from "./canonical.js";
import {
    EXTENSION_SIGN_PAYLOAD_MAX_BYTES,
    extensionSignDomain,
    extensionSignDomainParts,
    extensionSignProblem,
    signExtensionPayload,
    verifyExtensionPayload,
} from "./extension-sign.js";
import { secretKeysOf } from "./keys.js";
import { keySetFor } from "./s2s.testing.js";
import { hybridSign, hybridVerify, SIGN_DOMAINS, signedBytes } from "./sign.js";

const set = keySetFor(`ops`);
const other = keySetFor(`other`);
const secret = secretKeysOf(set.secret);
const record = { "@type": `Article`, name: `Hello`, at: 1_764_288_000_000, tags: [`a`, `b`] };

describe("an extension sign domain", () => {
    it("is ext:<publisher.name>/<purpose>, and its signed bytes carry it behind the protocol prefix", () => {
        expect<string>(extensionSignDomain(`intentic.network`, `log.entry`)).toBe(`ext:intentic.network/log.entry`);
        expect(signedBytes(extensionSignDomain(`intentic.network`, `log.entry`), utf8(`x`))).toEqual(utf8(`intentic-s2s/1 ext:intentic.network/log.entry\nx`));
    });

    it("refuses an id that is not publisher.name and a purpose outside its pattern, naming which", () => {
        expect(() => extensionSignDomain(`network`, `log`)).toThrow(`extension sign domain: "network" is not an extension id (publisher.name, each a lowercase word)`);
        expect(() => extensionSignDomain(`Intentic.network`, `log`)).toThrow(TypeError);
        expect(() => extensionSignDomain(`intentic.net/work`, `log`)).toThrow(TypeError);
        expect(() => extensionSignDomain(`intentic.network`, `log/entry`)).toThrow(
            `extension sign domain: "log/entry" is not a signing purpose: a lowercase word of up to 64 characters, dots and dashes inside`,
        );
        expect(() => extensionSignDomain(`intentic.network`, `log\nentry`)).toThrow(TypeError);
        expect(() => extensionSignDomain(`intentic.network`, `.log`)).toThrow(TypeError);
        expect(() => extensionSignDomain(`intentic.network`, ``)).toThrow(TypeError);
        expect(extensionSignProblem(`intentic.network`, `a`.repeat(64))).toBeUndefined();
        expect(extensionSignProblem(`intentic.network`, `a`.repeat(65))).toBe(
            `"${`a`.repeat(65)}" is not a signing purpose: a lowercase word of up to 64 characters, dots and dashes inside`,
        );
    });

    it("reads back into its halves, and nothing else does", () => {
        expect(extensionSignDomainParts(`ext:intentic.network/log.entry`)).toEqual({ extension: `intentic.network`, purpose: `log.entry` });
        expect(extensionSignDomainParts(`identity`)).toBeUndefined();
        expect(extensionSignDomainParts(`ext:intentic.network/log/entry`)).toBeUndefined();
        expect(extensionSignDomainParts(`ext:network/log`)).toBeUndefined();
    });
});

describe("an extension's signature over a payload", () => {
    const sig = signExtensionPayload(`intentic.network`, `log.entry`, record, secret);

    it("verifies with the signer's keys for the same extension, purpose and payload, in any key order", () => {
        expect(fromBase64Url(sig.ed25519)?.length).toBe(64);
        expect(verifyExtensionPayload(`intentic.network`, `log.entry`, record, sig, set.public)).toBe(true);
        const reordered = { tags: [`a`, `b`], at: 1_764_288_000_000, name: `Hello`, "@type": `Article` };
        expect(verifyExtensionPayload(`intentic.network`, `log.entry`, reordered, sig, set.public)).toBe(true);
    });

    it("does not verify for another purpose, another extension, another payload or another key set", () => {
        expect(verifyExtensionPayload(`intentic.network`, `log.checkpoint`, record, sig, set.public)).toBe(false);
        expect(verifyExtensionPayload(`acme.network`, `log.entry`, record, sig, set.public)).toBe(false);
        expect(verifyExtensionPayload(`intentic.network`, `log.entry`, { ...record, name: `Hullo` }, sig, set.public)).toBe(false);
        expect(verifyExtensionPayload(`intentic.network`, `log.entry`, record, sig, other.public)).toBe(false);
    });

    it("answers false, never throws, for a bad id or purpose and a payload JSON cannot carry", () => {
        expect(verifyExtensionPayload(`network`, `log.entry`, record, sig, set.public)).toBe(false);
        expect(verifyExtensionPayload(`intentic.network`, `LOG`, record, sig, set.public)).toBe(false);
        // A number JSON cannot spell: canonical JSON refuses it rather than sign `null` in its place.
        expect(verifyExtensionPayload(`intentic.network`, `log.entry`, { n: Number.NaN }, sig, set.public)).toBe(false);
        expect(verifyExtensionPayload(`intentic.network`, `log.entry`, record, { ...sig, ed25519: `not base64!` }, set.public)).toBe(false);
    });

    it("signs the payload's canonical bytes, so the core's verifier agrees under the same domain", () => {
        expect(hybridVerify(extensionSignDomain(`intentic.network`, `log.entry`), canonicalBytes(record), sig, set.public)).toBe(true);
    });

    it("is capped at the door at 256 KiB of canonical JSON, a constant the daemon and the SDK both read", () => {
        expect(EXTENSION_SIGN_PAYLOAD_MAX_BYTES).toBe(262_144);
    });
});

describe("an extension's signature is never one of the core's", () => {
    const domain = extensionSignDomain(`intentic.network`, `log.entry`);
    const message = canonicalBytes(record);
    const sig = hybridSign(domain, message, secret);

    it("has no core domain spelled like an extension's: each is a word with no `:`, `/` or newline", () => {
        for (const core of SIGN_DOMAINS) {
            expect({ core, word: /^[a-z][a-z-]*$/u.test(core) }).toEqual({ core, word: true });
        }
    });

    it("covers bytes no core domain's signature covers, for any message, since the domain ends at the first newline", () => {
        const signed = signedBytes(domain, message);
        const head = new TextDecoder().decode(signed.slice(0, signed.indexOf(10) + 1));
        expect(head).toBe(`intentic-s2s/1 ext:intentic.network/log.entry\n`);
        for (const core of SIGN_DOMAINS) {
            expect({ core, prefixed: head.startsWith(`intentic-s2s/1 ${core}\n`) }).toEqual({ core, prefixed: false });
        }
    });

    it("does not verify under any core domain, over the payload or over the extension's whole signed bytes", () => {
        for (const core of SIGN_DOMAINS) {
            expect({ core, payload: hybridVerify(core, message, sig, set.public) }).toEqual({ core, payload: false });
            // The bytes after the core's own prefix would have to be the extension's prefix and payload: they still differ.
            expect({ core, whole: hybridVerify(core, signedBytes(domain, message), sig, set.public) }).toEqual({ core, whole: false });
        }
    });

    it("and a core signature does not verify as an extension's", () => {
        for (const core of SIGN_DOMAINS) {
            const theirs = hybridSign(core, message, secret);
            expect({ core, ext: verifyExtensionPayload(`intentic.network`, `log.entry`, record, theirs, set.public) }).toEqual({ core, ext: false });
        }
    });
});
