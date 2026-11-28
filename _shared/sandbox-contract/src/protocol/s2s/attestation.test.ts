import {
    S2S_ATTESTATION_VALID_MAX_MS,
    S2S_ATTESTATIONS_KEPT_MAX,
    S2S_CLAIM_VALUE_MAX,
    S2S_CLAIMS_BYTES_MAX,
    S2S_CLAIMS_MAX,
    S2S_DOMAINS_MAX,
    S2S_IDENTITY_MAX_BYTES,
    type S2sAttestation,
    S2sAttestationSchema,
    type S2sSandboxVouch,
    SandboxIdentitySchema,
} from "../../schemas/s2s-identity.js";
import { type AttestationInput, attestationIdOf, sandboxVouchOf, signAttestation, verifyAttestation, verifyAttestations } from "./attestation.js";
import { canonicalBytes, canonicalJson } from "./canonical.js";
import { type IdentityFacts, signIdentity, verifyIdentity, vouchFor } from "./identity-doc.js";
import { secretKeysOf } from "./keys.js";
import { keySetFor, recoveryKeyFor } from "./s2s.testing.js";
import { hybridSign } from "./sign.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const issuerKeys = keySetFor(`notary`);
const first = keySetFor(`subject first`);
const second = keySetFor(`subject second`);
const third = keySetFor(`subject third`);
const recovery = recoveryKeyFor(`subject`);
const facts: IdentityFacts = { sandbox: `0123456789ab`, name: `ops`, host: `0123456789ab.sandbox.example`, domains: [], recovery: recovery.fingerprint, issuedAt: NOW };

const subjectDoc = signIdentity(facts, first);
const rotatedOnce = signIdentity({ ...facts, issuedAt: NOW + 1 }, second, vouchFor(facts.sandbox, second, { by: `key`, keySet: first }, NOW + 1));
const rotatedTwice = signIdentity({ ...facts, issuedAt: NOW + 2 }, third, vouchFor(facts.sandbox, third, { by: `key`, keySet: second }, NOW + 2));
const recovered = signIdentity({ ...facts, issuedAt: NOW + 3 }, second, vouchFor(facts.sandbox, second, { by: `recovery`, recovery }, NOW + 3));

const input: AttestationInput = {
    issuer: { sandbox: `notary-sandbox`, address: `notary.example`, name: `Notary` },
    subject: { sandbox: facts.sandbox, address: facts.host, fingerprint: first.fingerprint },
    claims: { kind: `organisation`, verifiedBy: `document`, country: `PL`, over18: true },
    issuedAt: NOW,
    validUntil: NOW + 90 * DAY,
};
const vouch = signAttestation(input, issuerKeys);
const at = { now: NOW + DAY };

// The vouch with a change made after signing, which its signature no longer covers.
const tampered = (change: Partial<S2sSandboxVouch>): S2sSandboxVouch => ({ ...vouch, ...change });

// A vouch signed over whatever fields are given, as a later or a careless issuer might make one.
const signedAs = (fields: Readonly<Record<string, unknown>>): S2sAttestation => {
    const unsigned = { ...fields };
    return S2sAttestationSchema.parse({ ...unsigned, sig: hybridSign(`attestation`, canonicalBytes(unsigned), secretKeysOf(issuerKeys.secret)) });
};

describe("a sandbox vouch", () => {
    it("carries its issuer's four public keys and fingerprint, the subject's key, the claims and the dates", () => {
        expect(vouch).toMatchObject({
            v: 1,
            type: `sandbox-vouch`,
            issuer: { sandbox: `notary-sandbox`, address: `notary.example`, name: `Notary`, fingerprint: issuerKeys.fingerprint, keys: issuerKeys.public },
            subject: { sandbox: facts.sandbox, address: facts.host, fingerprint: first.fingerprint },
            claims: { kind: `organisation`, verifiedBy: `document`, country: `PL`, over18: true },
            issuedAt: NOW,
            validUntil: NOW + 90 * DAY,
        });
        expect(Object.keys(vouch.issuer.keys).toSorted()).toEqual([`ed25519`, `mldsa65`, `mlkem768`, `x25519`]);
    });

    it("verifies against its subject's document, trusted only by a reader who lists its issuer", () => {
        expect(verifyAttestation(vouch, subjectDoc, at)).toEqual({ ok: true, trusted: false });
        expect(verifyAttestation(vouch, subjectDoc, { ...at, trustedIssuers: [issuerKeys.fingerprint] })).toEqual({ ok: true, trusted: true });
        expect(verifyAttestation(vouch, subjectDoc, { ...at, trustedIssuers: new Set([second.fingerprint]) })).toEqual({ ok: true, trusted: false });
    });

    it("survives JSON and the schema whole, and is read back as a vouch", () => {
        const arrived = S2sAttestationSchema.parse(JSON.parse(JSON.stringify(vouch)));
        expect(arrived).toEqual(vouch);
        expect(sandboxVouchOf(arrived)).toEqual(vouch);
        expect(verifyAttestation(arrived, subjectDoc, at)).toEqual({ ok: true, trusted: false });
    });

    it("lapses at validUntil and is not taken from ahead of the reader's clock", () => {
        expect(verifyAttestation(vouch, subjectDoc, { now: input.validUntil - 1 })).toEqual({ ok: true, trusted: false });
        expect(verifyAttestation(vouch, subjectDoc, { now: input.validUntil })).toEqual({ ok: false, trusted: false, reason: `it lapsed at ${new Date(input.validUntil).toISOString()}` });
        expect(verifyAttestation(vouch, subjectDoc, { now: NOW - 5 * 60 * 1000 })).toEqual({ ok: true, trusted: false });
        expect(verifyAttestation(vouch, subjectDoc, { now: NOW - 5 * 60 * 1000 - 1 })).toEqual({
            ok: false,
            trusted: false,
            reason: `it is dated ${new Date(NOW).toISOString()}, ahead of this clock`,
        });
    });

    it("is never signed or taken for longer than a year", () => {
        expect(signAttestation({ ...input, validUntil: NOW + S2S_ATTESTATION_VALID_MAX_MS }, issuerKeys).validUntil).toBe(NOW + S2S_ATTESTATION_VALID_MAX_MS);
        expect(() => signAttestation({ ...input, validUntil: NOW + S2S_ATTESTATION_VALID_MAX_MS + 1 }, issuerKeys)).toThrow(
            `an attestation cannot be signed: it claims to be valid for more than a year`,
        );
        expect(() => signAttestation({ ...input, validUntil: NOW }, issuerKeys)).toThrow(`an attestation cannot be signed: it lapses before it was made`);
        const { sig: _sig, ...unsigned } = vouch;
        const long = signedAs({ ...unsigned, validUntil: NOW + S2S_ATTESTATION_VALID_MAX_MS + 1 });
        expect(verifyAttestation(long, subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `it claims to be valid for more than a year` });
    });

    it("fails once any claim, date or party is changed after signing", () => {
        const changes: readonly Partial<S2sSandboxVouch>[] = [
            { claims: { ...vouch.claims, over18: false } },
            { claims: { ...vouch.claims, country: `DE` } },
            { claims: { ...vouch.claims, extra: `added` } },
            { validUntil: vouch.validUntil + 1 },
            { issuedAt: vouch.issuedAt - 1 },
            { subject: { ...vouch.subject, address: `elsewhere.example` } },
            { issuer: { ...vouch.issuer, name: `Notary Inc.` } },
        ];
        for (const change of changes) {
            expect(verifyAttestation(tampered(change), subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `its signature does not verify` });
        }
    });

    it("fails when its issuer's keys are not the ones its fingerprint is over, or another's keys signed it", () => {
        const other = keySetFor(`impostor`);
        expect(verifyAttestation(tampered({ issuer: { ...vouch.issuer, keys: other.public } }), subjectDoc, at)).toEqual({
            ok: false,
            trusted: false,
            reason: `its issuer's fingerprint is not over the keys it carries`,
        });
        const forged = signAttestation(input, other);
        expect(verifyAttestation({ ...forged, issuer: vouch.issuer }, subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `its signature does not verify` });
    });

    it("fails against another sandbox's document, or a key of this one it does not name", () => {
        const elsewhere = signIdentity({ ...facts, sandbox: `ba9876543210` }, first);
        expect(verifyAttestation(vouch, elsewhere, at)).toEqual({ ok: false, trusted: false, reason: `it is about sandbox ${facts.sandbox}, not ba9876543210` });
        const rekeyed = signIdentity(facts, second);
        expect(verifyAttestation(vouch, rekeyed, at)).toEqual({
            ok: false,
            trusted: false,
            reason: `it names key ${first.fingerprint}, which is neither this sandbox's key nor the one before it: its issuer has to vouch again`,
        });
    });

    it("still holds after the subject rotated once, and not after a second rotation or a recovery", () => {
        expect(verifyAttestation(vouch, rotatedOnce, at)).toEqual({ ok: true, trusted: false });
        const twice = verifyAttestation(vouch, rotatedTwice, at);
        expect(twice).toEqual({ ok: false, trusted: false, reason: `it names key ${first.fingerprint}, which is neither this sandbox's key nor the one before it: its issuer has to vouch again` });
        expect(verifyAttestation(vouch, recovered, at).ok).toBe(false);
    });

    it("is refused from the subject itself, under its key or the one before", () => {
        const own = signAttestation({ ...input, issuer: { sandbox: facts.sandbox, address: facts.host } }, first);
        expect(verifyAttestation(own, subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `a sandbox cannot vouch for itself` });
        const before = signAttestation({ ...input, subject: { ...input.subject, fingerprint: second.fingerprint } }, first);
        expect(verifyAttestation(before, rotatedOnce, at)).toEqual({ ok: false, trusted: false, reason: `a sandbox cannot vouch for itself` });
    });

    it("has one id for what it says, whoever re-signs it, and another once anything it says changes", () => {
        const again = signAttestation(input, issuerKeys);
        expect(attestationIdOf(again)).toBe(attestationIdOf(vouch));
        expect(attestationIdOf(vouch)).toMatch(/^[a-z2-7]{26}$/u);
        expect(attestationIdOf(signAttestation({ ...input, claims: { kind: `person` } }, issuerKeys))).not.toBe(attestationIdOf(vouch));
    });
});

describe("other attestation types", () => {
    const eudi = S2sAttestationSchema.parse({
        v: 1,
        type: `eudi-pid`,
        format: `dc+sd-jwt`,
        presentation: `eyJhbGciOiJFUzI1NiJ9.e30.c2ln~`,
        subject: input.subject,
        issuedAt: NOW,
        validUntil: NOW + DAY * 30,
    });
    const future = S2sAttestationSchema.parse({ type: `zk-uniqueness`, v: 3, proof: `AAEC`, nested: { deep: [1, 2] } });

    it("parses an EU wallet's slot and says it is not supported yet", () => {
        expect(eudi.type).toBe(`eudi-pid`);
        expect(verifyAttestation(eudi, subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `an EU wallet attestation is not supported yet` });
    });

    it("keeps a type this build does not know whole, and never takes it", () => {
        expect(future).toEqual({ type: `zk-uniqueness`, v: 3, proof: `AAEC`, nested: { deep: [1, 2] } });
        expect(verifyAttestation(future, subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `a zk-uniqueness attestation is not one this build reads` });
        expect(sandboxVouchOf(future)).toBe(undefined);
    });

    it("keeps a vouch it cannot read whole too, a later version or a field nested deeper", () => {
        const later = S2sAttestationSchema.parse({ ...vouch, v: 2 });
        expect(later).toEqual({ ...vouch, v: 2 });
        expect(verifyAttestation(later, subjectDoc, at)).toEqual({ ok: false, trusted: false, reason: `it does not read as a sandbox vouch` });
        const deeper = S2sAttestationSchema.parse({ ...vouch, issuer: { ...vouch.issuer, keys: { ...vouch.issuer.keys, slhdsa: `AAAA` } } });
        expect(canonicalJson(deeper)).toBe(canonicalJson({ ...vouch, issuer: { ...vouch.issuer, keys: { ...vouch.issuer.keys, slhdsa: `AAAA` } } }));
    });
});

describe("an identity document carrying attestations", () => {
    const later = S2sAttestationSchema.parse({ type: `zk-uniqueness`, v: 3, proof: `AAEC` });
    const carrying = signIdentity({ ...facts, attestations: [vouch, later] }, first);
    // The schema of a build from before attestations: the same loose document, without the field.
    const EarlierSchema = SandboxIdentitySchema.omit({ attestations: true }).loose();

    it("lists them in its signed body, and leaves the field out when there are none, as before attestations", () => {
        expect(carrying.attestations).toEqual([vouch, later]);
        expect(verifyIdentity(carrying)).toEqual({ ok: true });
        expect(Object.keys(signIdentity({ ...facts, attestations: [] }, first))).not.toContain(`attestations`);
        // ML-DSA signs with fresh randomness, so the bodies are compared: the very bytes signed before attestations existed.
        const { sig: _none, ...withNone } = signIdentity({ ...facts, attestations: [] }, first);
        const { sig: _before, ...before } = subjectDoc;
        expect(canonicalJson(withNone)).toBe(canonicalJson(before));
    });

    it("parses and verifies under this build's schema and an earlier build's, which keeps the field it does not know", () => {
        const wire = JSON.parse(JSON.stringify(carrying));
        const here = SandboxIdentitySchema.parse(wire);
        expect(here).toEqual(carrying);
        expect(verifyIdentity(here)).toEqual({ ok: true });
        const earlier = EarlierSchema.parse(wire);
        expect(earlier[`attestations`]).toEqual(wire.attestations);
        expect(verifyIdentity(SandboxIdentitySchema.parse(earlier))).toEqual({ ok: true });
    });

    it("has each checked against it once the document itself verifies", () => {
        expect(verifyAttestations(carrying, { ...at, trustedIssuers: [issuerKeys.fingerprint] })).toEqual([
            { id: attestationIdOf(vouch), attestation: vouch, check: { ok: true, trusted: true } },
            { id: attestationIdOf(later), attestation: later, check: { ok: false, trusted: false, reason: `a zk-uniqueness attestation is not one this build reads` } },
        ]);
        expect(verifyAttestations({ ...carrying, name: `opz` }, at).map((checked) => checked.check)).toEqual([
            { ok: false, trusted: false, reason: `the document carrying it does not verify: its signature does not verify` },
            { ok: false, trusted: false, reason: `the document carrying it does not verify: its signature does not verify` },
        ]);
    });

    it("fits the most this sandbox keeps, each as large as a vouch gets, beside the largest document, inside what a daemon reads", () => {
        const longest = (label: string): string => `${label}${`a`.repeat(63 - label.length)}`;
        const domains = Array.from({ length: S2S_DOMAINS_MAX }, (_, index) => `${longest(`d${index}`)}.${longest(`x`)}.${longest(`y`)}.${`z`.repeat(53)}.example`);
        // Claims filled to the last byte they may take.
        const claims: Record<string, string> = {};
        for (let index = 0; index < S2S_CLAIMS_MAX; index++) {
            const room = S2S_CLAIMS_BYTES_MAX - JSON.stringify({ ...claims, [`claim${index}`]: `` }).length;
            if (room > 0) {
                claims[`claim${index}`] = `x`.repeat(Math.min(S2S_CLAIM_VALUE_MAX, room));
            }
        }
        expect(JSON.stringify(claims).length).toBe(S2S_CLAIMS_BYTES_MAX);
        const largest = Array.from({ length: S2S_ATTESTATIONS_KEPT_MAX }, (_, index) =>
            signAttestation(
                {
                    ...input,
                    issuer: { sandbox: `i`.repeat(100), address: domains[index] ?? ``, name: `n`.repeat(120) },
                    subject: { sandbox: `s`.repeat(100), address: domains[index] ?? ``, fingerprint: second.fingerprint },
                    claims,
                },
                keySetFor(`issuer ${index}`),
            ),
        );
        const fullest = signIdentity(
            { ...facts, name: `n`.repeat(120), domains, attestations: largest },
            second,
            vouchFor(facts.sandbox, second, { by: `key`, keySet: first }, NOW),
        );
        expect(SandboxIdentitySchema.parse(fullest).domains.map((domain) => domain.length)).toEqual(Array.from({ length: S2S_DOMAINS_MAX }, () => 253));
        expect(new TextEncoder().encode(JSON.stringify(fullest)).length).toBeLessThanOrEqual(S2S_IDENTITY_MAX_BYTES);
    });
});
