import { type SandboxIdentity, SandboxIdentitySchema } from "../../schemas/s2s-identity.js";
import { canonicalBytes } from "./canonical.js";
import { classifyIdentityChange, type IdentityFacts, type PinnedIdentity, signIdentity, speaksS2s, verifyIdentity, vouchFor } from "./identity-doc.js";
import { secretKeysOf } from "./keys.js";
import { keySetFor, recoveryKeyFor } from "./s2s.testing.js";
import { hybridSign } from "./sign.js";

const NOW = 1_800_000_000_000;
const HOST = `0123456789ab.sandbox.example`;
const DOMAIN = `ops.acme.example`;
const first = keySetFor(`first`);
const second = keySetFor(`second`);
const stranger = keySetFor(`stranger`);
const recovery = recoveryKeyFor(`ops`);
const facts: IdentityFacts = { sandbox: `0123456789ab`, name: `ops`, host: HOST, domains: [DOMAIN], recovery: recovery.fingerprint, issuedAt: NOW };

const byFirst = vouchFor(facts.sandbox, second, { by: `key`, keySet: first }, NOW + 1);
const byRecovery = vouchFor(facts.sandbox, second, { by: `recovery`, recovery }, NOW + 2);
const original = signIdentity(facts, first);
const rotated = signIdentity({ ...facts, issuedAt: NOW + 1 }, second, byFirst);
const recovered = signIdentity({ ...facts, issuedAt: NOW + 2 }, second, byRecovery);
const rekeyed = signIdentity({ ...facts, issuedAt: NOW + 3 }, second);

const pinned: PinnedIdentity = { address: HOST, fingerprint: first.fingerprint, recovery: recovery.fingerprint };

describe("an identity document", () => {
    it("carries the facts, the key set's public keys and fingerprint, and s2s/1, and verifies", () => {
        expect(original).toMatchObject({
            v: 1,
            sandbox: `0123456789ab`,
            name: `ops`,
            host: HOST,
            domains: [DOMAIN],
            keys: first.public,
            fingerprint: first.fingerprint,
            recovery: recovery.fingerprint,
            protocols: [`s2s/1`],
            issuedAt: NOW,
        });
        expect(Object.keys(original)).not.toContain(`prev`);
        expect(verifyIdentity(original)).toEqual({ ok: true });
        expect(speaksS2s(original)).toBe(true);
    });

    it("lists its domains once each, sorted", () => {
        expect(signIdentity({ ...facts, domains: [`b.example`, `a.example`, `b.example`] }, first).domains).toEqual([`a.example`, `b.example`]);
    });

    it("survives JSON and the schema whole, so what arrives over the wire still verifies", () => {
        const arrived = SandboxIdentitySchema.parse(JSON.parse(JSON.stringify(rotated)));
        expect(arrived).toEqual(rotated);
        expect(verifyIdentity(arrived)).toEqual({ ok: true });
    });

    it("keeps a field this build does not know, which a later build signed, and fails without it", () => {
        const { sig: _sig, ...unsigned } = original;
        const later = { ...unsigned, motto: `hello` };
        const signed = { ...later, sig: hybridSign(`identity`, canonicalBytes(later), secretKeysOf(first.secret)) };
        const arrived = SandboxIdentitySchema.parse(JSON.parse(JSON.stringify(signed)));
        expect(verifyIdentity(arrived)).toEqual({ ok: true });
        const { motto: _motto, ...stripped } = arrived;
        expect(verifyIdentity(stripped)).toEqual({ ok: false, reason: `its signature does not verify` });
    });

    it("fails when any fact is changed after signing", () => {
        const changes: readonly Partial<SandboxIdentity>[] = [
            { name: `opz` },
            { host: `evil.example` },
            { domains: [] },
            { domains: [DOMAIN, `bank.example`] },
            { issuedAt: NOW + 1 },
            { protocols: [`s2s/2`] },
            { recovery: recoveryKeyFor(`other`).fingerprint },
        ];
        for (const change of changes) {
            expect(verifyIdentity({ ...original, ...change })).toEqual({ ok: false, reason: `its signature does not verify` });
        }
    });

    it("fails when its keys are not the ones its fingerprint is over", () => {
        expect(verifyIdentity({ ...original, keys: { ...original.keys, x25519: stranger.public.x25519 } })).toEqual({
            ok: false,
            reason: `its fingerprint is not over its keys`,
        });
        expect(verifyIdentity({ ...original, fingerprint: stranger.fingerprint })).toEqual({ ok: false, reason: `its fingerprint is not over its keys` });
    });

    it("fails when either half of its signature is another's", () => {
        const theirs = signIdentity(facts, stranger);
        expect(verifyIdentity({ ...original, sig: { ...original.sig, ed25519: theirs.sig.ed25519 } }).ok).toBe(false);
        expect(verifyIdentity({ ...original, sig: { ...original.sig, mldsa65: theirs.sig.mldsa65 } }).ok).toBe(false);
    });
});

describe("a document's prev", () => {
    it("names the previous key set and verifies with it", () => {
        expect(rotated.prev).toMatchObject({ by: `key`, fingerprint: first.fingerprint, keys: first.public, at: NOW + 1 });
        expect(verifyIdentity(rotated)).toEqual({ ok: true });
    });

    it("names the recovery key and verifies with it", () => {
        expect(recovered.prev).toMatchObject({ by: `recovery`, fingerprint: recovery.fingerprint, keys: recovery.public, at: NOW + 2 });
        expect(verifyIdentity(recovered)).toEqual({ ok: true });
    });

    it("still verifies when the document is signed again with other facts, the voucher long gone", () => {
        const later = signIdentity({ ...facts, name: `ops 2`, domains: [`other.example`], issuedAt: NOW + 50 }, second, byRecovery);
        expect(verifyIdentity(later)).toEqual({ ok: true });
    });

    it("fails under another successor or for another sandbox", () => {
        expect(verifyIdentity(signIdentity(facts, stranger, byFirst))).toEqual({ ok: false, reason: `its prev signature does not verify` });
        expect(verifyIdentity(signIdentity({ ...facts, sandbox: `fedcba987654` }, second, byFirst))).toEqual({ ok: false, reason: `its prev signature does not verify` });
    });

    it("fails when it claims a key it was not signed by, or a changed time", () => {
        const byStranger = vouchFor(facts.sandbox, second, { by: `key`, keySet: stranger }, NOW + 1);
        const claimed = { ...byStranger, fingerprint: first.fingerprint, keys: first.public };
        expect(verifyIdentity(signIdentity(facts, second, claimed))).toEqual({ ok: false, reason: `its prev signature does not verify` });
        expect(verifyIdentity(signIdentity(facts, second, { ...byFirst, at: NOW + 9 }))).toEqual({ ok: false, reason: `its prev signature does not verify` });
    });

    it("fails when its keys are not the ones its fingerprint names", () => {
        expect(verifyIdentity(signIdentity(facts, second, { ...byFirst, keys: stranger.public }))).toEqual({
            ok: false,
            reason: `its prev keys are not the ones prev's fingerprint names`,
        });
    });
});

describe("the rotation table", () => {
    it("is unchanged for the pinned key at the pinned address", () => {
        expect(classifyIdentityChange({ pinned, next: original, address: HOST })).toEqual({ kind: `unchanged` });
    });

    it("is rotated for a new key whose prev the pinned key signed", () => {
        expect(classifyIdentityChange({ pinned, next: rotated, address: HOST })).toEqual({ kind: `rotated` });
    });

    it("is recovered for a new key whose prev the pinned recovery key signed, and key-changed when none was pinned", () => {
        expect(classifyIdentityChange({ pinned, next: recovered, address: HOST })).toEqual({ kind: `recovered` });
        expect(classifyIdentityChange({ pinned: { address: HOST, fingerprint: first.fingerprint }, next: recovered, address: HOST })).toEqual({ kind: `key-changed` });
    });

    it("is rekeyed-by-domain for a domain contact whose TXT record names the new key and host", () => {
        const byDomain: PinnedIdentity = { ...pinned, address: DOMAIN };
        expect(classifyIdentityChange({ pinned: byDomain, next: rekeyed, address: DOMAIN, txt: { fingerprint: second.fingerprint, host: HOST } })).toEqual({
            kind: `rekeyed-by-domain`,
        });
    });

    it("is key-changed when the record names the old key or another host, when there is none, or when the contact is a host", () => {
        const byDomain: PinnedIdentity = { ...pinned, address: DOMAIN };
        expect(classifyIdentityChange({ pinned: byDomain, next: rekeyed, address: DOMAIN, txt: { fingerprint: first.fingerprint, host: HOST } })).toEqual({ kind: `key-changed` });
        expect(classifyIdentityChange({ pinned: byDomain, next: rekeyed, address: DOMAIN, txt: { fingerprint: second.fingerprint, host: `other.example` } })).toEqual({
            kind: `key-changed`,
        });
        expect(classifyIdentityChange({ pinned: byDomain, next: rekeyed, address: DOMAIN })).toEqual({ kind: `key-changed` });
        expect(classifyIdentityChange({ pinned, next: rekeyed, address: HOST, txt: { fingerprint: second.fingerprint, host: HOST } })).toEqual({ kind: `key-changed` });
    });

    it("is key-changed for a new key whose prev a key nobody pinned signed", () => {
        const elsewhere = signIdentity({ ...facts, issuedAt: NOW + 4 }, second, vouchFor(facts.sandbox, second, { by: `key`, keySet: stranger }, NOW + 4));
        expect(classifyIdentityChange({ pinned, next: elsewhere, address: HOST })).toEqual({ kind: `key-changed` });
    });

    it("is moved for a new address the pinned key, or a prev it or the recovery key signed, proves", () => {
        const at = `fedcba987654.sandbox.example`;
        expect(classifyIdentityChange({ pinned, next: signIdentity({ ...facts, host: at }, first), address: at })).toEqual({ kind: `moved`, via: `same-key` });
        expect(classifyIdentityChange({ pinned, next: signIdentity({ ...facts, host: at }, second, byFirst), address: at })).toEqual({
            kind: `moved`,
            via: `rotated`,
        });
        expect(classifyIdentityChange({ pinned, next: signIdentity({ ...facts, host: at }, second, byRecovery), address: at })).toEqual({
            kind: `moved`,
            via: `recovered`,
        });
    });

    it("is unrelated for a new address with no proof: a new contact, not this one", () => {
        expect(classifyIdentityChange({ pinned, next: signIdentity({ ...facts, host: `x.example` }, stranger), address: `x.example` })).toEqual({ kind: `unrelated` });
    });

    it("is invalid for a document that does not verify, whatever else it claims", () => {
        expect(classifyIdentityChange({ pinned, next: { ...rotated, name: `changed` }, address: HOST })).toEqual({ kind: `invalid`, reason: `its signature does not verify` });
    });
});
