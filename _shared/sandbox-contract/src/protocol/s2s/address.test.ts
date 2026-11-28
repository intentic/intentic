import type { SandboxIdentity } from "../../schemas/s2s-identity.js";
import {
    type AddressIo,
    type FetchedIdentity,
    formatTxtRecord,
    normalizeAddress,
    normalizeDomain,
    parseTxtRecord,
    resolveAddress,
    type TxtAnswer,
    txtLookupOf,
    txtRecordName,
} from "./address.js";
import { signIdentity } from "./identity-doc.js";
import { keySetFor } from "./s2s.testing.js";

const NOW = 1_800_000_000_000;
const HOST = `0123456789ab.sandbox.example`;
const DOMAIN = `ops.acme.example`;
const keys = keySetFor(`ops`);
const other = keySetFor(`other`);
const FP = keys.fingerprint;
const document = signIdentity({ sandbox: `0123456789ab`, name: `ops`, host: HOST, domains: [DOMAIN], issuedAt: NOW }, keys);

// One fake per seam: the DNS answers and the identities served, by name and host; anything else is missing or down.
const io = (txt: Readonly<Record<string, TxtAnswer>>, served: Readonly<Record<string, FetchedIdentity>>): AddressIo & { readonly asked: string[] } => {
    const asked: string[] = [];
    return {
        asked,
        resolveTxt: async (name) => {
            asked.push(`txt ${name}`);
            return txt[name] ?? { kind: `missing` };
        },
        fetchIdentity: async (host) => {
            asked.push(`get ${host}`);
            return served[host] ?? { ok: false, error: `connection refused` };
        },
    };
};
const serving = (doc: SandboxIdentity): FetchedIdentity => ({ ok: true, body: JSON.parse(JSON.stringify(doc)) });
const record = (value: string): TxtAnswer => ({ kind: `records`, records: [[value]] });

describe("an address", () => {
    it("is normalized to lowercase punycode with no scheme, path, trailing dot or default port", () => {
        expect(normalizeAddress(`  HTTPS://Ops.Acme.Example./s2s/identity `)).toBe(`ops.acme.example`);
        expect(normalizeAddress(`bücher.example`)).toBe(`xn--bcher-kva.example`);
        expect(normalizeAddress(`ops.acme.example:443`)).toBe(`ops.acme.example`);
        expect(normalizeAddress(`localhost:8443`)).toBe(`localhost:8443`);
    });

    it("is refused when it is no host", () => {
        for (const raw of [``, `ops`, `ada@ops.example`, `-bad.example`, `under_score.example`, `ops..example`, `http://`]) {
            expect(normalizeAddress(raw)).toBeUndefined();
        }
    });

    it("is a domain only without a port and not localhost", () => {
        expect(normalizeDomain(`Ops.Acme.Example`)).toBe(`ops.acme.example`);
        expect(normalizeDomain(`ops.acme.example:8443`)).toBeUndefined();
        expect(normalizeDomain(`localhost`)).toBeUndefined();
    });
});

describe("a TXT record", () => {
    it("is published under _intentic and reads back as it was written", () => {
        expect(txtRecordName(DOMAIN)).toBe(`_intentic.ops.acme.example`);
        const value = formatTxtRecord({ fingerprint: FP, host: HOST });
        expect(value).toBe(`v=isk1 fp=${FP} host=${HOST}`);
        expect(parseTxtRecord(value)).toEqual({ fingerprint: FP, host: HOST });
    });

    it("reads in any order, with any whitespace and case in keys and the fingerprint, skipping words it does not know", () => {
        expect(parseTxtRecord(`  HOST=${HOST.toUpperCase()}\tnote=hi  FP=${FP.toUpperCase()} V=isk1 `)).toEqual({ fingerprint: FP, host: HOST });
    });

    it("does not read without its version, fingerprint or host, with one twice, or with a word that is no pair", () => {
        for (const value of [
            `fp=${FP} host=${HOST}`,
            `v=isk2 fp=${FP} host=${HOST}`,
            `v=isk1 host=${HOST}`,
            `v=isk1 fp=${FP}`,
            `v=isk1 fp=isk1:short host=${HOST}`,
            `v=isk1 fp=${FP} host=not_a_host`,
            `v=isk1 fp=${FP} fp=${other.fingerprint} host=${HOST}`,
            `v=isk1 fp=${FP} host=${HOST} stray`,
            `v=isk1 =x fp=${FP} host=${HOST}`,
        ]) {
            expect(parseTxtRecord(value)).toBeUndefined();
        }
    });

    it("is looked up from DNS chunks: joined, others' records ignored, agreeing copies one, disagreeing ones a conflict", () => {
        const value = formatTxtRecord({ fingerprint: FP, host: HOST });
        expect(txtLookupOf([[`v=spf1 -all`], [value.slice(0, 20), value.slice(20)]])).toEqual({ kind: `record`, record: { fingerprint: FP, host: HOST } });
        expect(txtLookupOf([[`v=spf1 -all`]])).toEqual({ kind: `none` });
        expect(txtLookupOf([[value], [value]])).toEqual({ kind: `record`, record: { fingerprint: FP, host: HOST } });
        expect(txtLookupOf([[value], [formatTxtRecord({ fingerprint: other.fingerprint, host: HOST })]])).toEqual({ kind: `conflict` });
        expect(txtLookupOf([[value], [`v=isk1 fp=broken`]])).toEqual({ kind: `invalid` });
    });
});

describe("resolving an address", () => {
    it("takes a host with no record as itself, and checks the document it serves", async () => {
        const fake = io({}, { [HOST]: serving(document) });
        expect(await resolveAddress(HOST, fake)).toEqual({ ok: true, address: HOST, host: HOST, document, txt: undefined });
        expect(fake.asked).toEqual([`txt _intentic.${HOST}`, `get ${HOST}`]);
    });

    it("follows a domain's record to its host, and checks the key and that the document lists the domain", async () => {
        const fake = io({ [`_intentic.${DOMAIN}`]: record(formatTxtRecord({ fingerprint: FP, host: HOST })) }, { [HOST]: serving(document) });
        expect(await resolveAddress(`https://${DOMAIN.toUpperCase()}`, fake)).toEqual({ ok: true, address: DOMAIN, host: HOST, document, txt: { fingerprint: FP, host: HOST } });
        expect(fake.asked).toEqual([`txt _intentic.${DOMAIN}`, `get ${HOST}`]);
    });

    it("looks up no record for a host with a port", async () => {
        const fake = io({}, { "localhost:8443": serving(signIdentity({ sandbox: `l`, name: `l`, host: `localhost:8443`, domains: [], issuedAt: NOW }, keys)) });
        expect((await resolveAddress(`localhost:8443`, fake)).ok).toBe(true);
        expect(fake.asked).toEqual([`get localhost:8443`]);
    });

    it("refuses a record naming another key than the one served", async () => {
        const fake = io({ [`_intentic.${DOMAIN}`]: record(formatTxtRecord({ fingerprint: other.fingerprint, host: HOST })) }, { [HOST]: serving(document) });
        expect(await resolveAddress(DOMAIN, fake)).toMatchObject({ ok: false, code: `fingerprint` });
    });

    it("refuses a domain the document does not list, and a document of another host", async () => {
        const unlisted = signIdentity({ sandbox: `0123456789ab`, name: `ops`, host: HOST, domains: [], issuedAt: NOW }, keys);
        const fake = io({ [`_intentic.${DOMAIN}`]: record(formatTxtRecord({ fingerprint: FP, host: HOST })) }, { [HOST]: serving(unlisted) });
        expect(await resolveAddress(DOMAIN, fake)).toMatchObject({ ok: false, code: `domain` });
        expect(await resolveAddress(`elsewhere.example`, io({}, { "elsewhere.example": serving(document) }))).toMatchObject({ ok: false, code: `host` });
    });

    it("refuses a document that does not verify, or is none at all", async () => {
        expect(await resolveAddress(HOST, io({}, { [HOST]: serving({ ...document, name: `forged` }) }))).toMatchObject({ ok: false, code: `signature` });
        expect(await resolveAddress(HOST, io({}, { [HOST]: { ok: true, body: { hello: `world` } } }))).toMatchObject({ ok: false, code: `malformed` });
    });

    it("tells a daemon from before (401) from one that does not answer", async () => {
        expect(await resolveAddress(HOST, io({}, { [HOST]: { ok: false, status: 401, error: `unauthorized` } }))).toMatchObject({ ok: false, code: `too_old` });
        expect(await resolveAddress(HOST, io({}, {}))).toEqual({ ok: false, code: `unreachable`, message: `${HOST} did not answer: connection refused` });
    });

    it("refuses when the lookup fails, or the record is broken or contradicts itself", async () => {
        expect(await resolveAddress(DOMAIN, io({ [`_intentic.${DOMAIN}`]: { kind: `failed`, error: `SERVFAIL` } }, {}))).toEqual({
            ok: false,
            code: `dns`,
            message: `looking up _intentic.${DOMAIN} failed: SERVFAIL`,
        });
        expect(await resolveAddress(DOMAIN, io({ [`_intentic.${DOMAIN}`]: record(`v=isk1 fp=nope`) }, {}))).toMatchObject({ ok: false, code: `txt` });
    });

    it("refuses what is no address before asking anything", async () => {
        const fake = io({}, {});
        expect(await resolveAddress(`not an address`, fake)).toMatchObject({ ok: false, code: `invalid_address` });
        expect(fake.asked).toEqual([]);
    });
});
