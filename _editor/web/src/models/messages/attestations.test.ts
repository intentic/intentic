import { S2S_ATTESTATION_VALID_MAX_MS, type S2sAttestationRow, S2sAttestationSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { carriedFrom, claimsFrom, defaultUntilDate, earliestUntilDate, fieldsFrom, latestUntilDate, validUntilOf, vouchFacts } from "./attestations";

// Built from the reader's calendar, as a date input gives it, so the suite reads the same in any time zone.
const NOW = new Date(2026, 10, 28, 15, 30).getTime();
const endOf = (year: number, month: number, day: number): number => new Date(year, month - 1, day + 1).getTime() - 1;

const FINGERPRINT = `isk1:${`a`.repeat(52)}`;
const ISSUER = { sandbox: `notary`, address: `notary.example`, fingerprint: FINGERPRINT, keys: { ed25519: `e`, mldsa65: `m`, x25519: `x`, mlkem768: `k` } };
const signed = {
    v: 1,
    type: `sandbox-vouch`,
    issuer: { ...ISSUER, name: `Notary` },
    subject: { sandbox: `ops`, address: `ops.example`, fingerprint: `isk1:${`b`.repeat(52)}` },
    claims: { kind: `organisation`, over18: true },
    issuedAt: NOW,
    validUntil: NOW + 1000,
    sig: { ed25519: `s`, mldsa65: `s` },
};
const vouch = S2sAttestationSchema.parse(signed);

describe(`a vouch's facts`, () => {
    it(`name the issuer by its name, else its address, with its claims and when it lapses`, () => {
        expect(vouchFacts(vouch)).toEqual({ issuer: `Notary`, address: `notary.example`, fingerprint: FINGERPRINT, claims: { kind: `organisation`, over18: true }, validUntil: NOW + 1000 });
        expect(vouchFacts(S2sAttestationSchema.parse({ ...signed, issuer: ISSUER }))?.issuer).toBe(`notary.example`);
    });

    it(`are none for a type this editor does not read`, () => {
        expect(vouchFacts(S2sAttestationSchema.parse({ type: `zk-uniqueness`, v: 3 }))).toBe(undefined);
    });
});

describe(`the claims form`, () => {
    it(`has every well-known field, empty where unclaimed, then a request's own claims by their key`, () => {
        expect(fieldsFrom({ kind: `person`, over18: true, staff: 12 })).toEqual([
            { key: `kind`, kind: `text`, text: `person` },
            { key: `verifiedBy`, kind: `text`, text: `` },
            { key: `country`, kind: `text`, text: `` },
            { key: `over18`, kind: `yesNo`, checked: true },
            { key: `displayName`, kind: `text`, text: `` },
            { key: `organisation`, kind: `text`, text: `` },
            { key: `staff`, kind: `text`, text: `12` },
        ]);
    });

    it(`claims what was filled in or switched on, trimmed, and nothing else`, () => {
        const fields = fieldsFrom();
        expect(claimsFrom(fields)).toEqual({});
        expect(
            claimsFrom([
                { key: `kind`, kind: `text`, text: ` organisation ` },
                { key: `country`, kind: `text`, text: `  ` },
                { key: `over18`, kind: `yesNo`, checked: false },
                { key: `staff`, kind: `text`, text: `12` },
            ]),
        ).toEqual({ kind: `organisation`, staff: `12` });
        expect(claimsFrom([{ key: `over18`, kind: `yesNo`, checked: true }])).toEqual({ over18: true });
    });
});

describe(`the valid-until date`, () => {
    it(`opens a year out, and may be picked up to the last day the year reaches`, () => {
        expect(earliestUntilDate(NOW)).toBe(`2026-11-28`);
        expect(defaultUntilDate(NOW)).toBe(`2027-11-27`);
        expect(latestUntilDate(NOW)).toBe(`2027-11-28`);
    });

    it(`stands for the end of the day picked, held inside the year`, () => {
        expect(validUntilOf(`2027-02-01`, NOW)).toBe(endOf(2027, 2, 1));
        expect(validUntilOf(`2027-11-28`, NOW)).toBe(NOW + S2S_ATTESTATION_VALID_MAX_MS - 60_000);
        expect(validUntilOf(`2030-01-01`, NOW)).toBe(NOW + S2S_ATTESTATION_VALID_MAX_MS - 60_000);
    });

    it(`is none for today's date already gone by, a day past, or no date`, () => {
        expect(validUntilOf(`2026-11-28`, NOW)).toBe(endOf(2026, 11, 28));
        expect(validUntilOf(`2026-11-27`, NOW)).toBe(undefined);
        expect(validUntilOf(``, NOW)).toBe(undefined);
        expect(validUntilOf(`28.11.2027`, NOW)).toBe(undefined);
    });
});

describe(`the row an issued message became`, () => {
    it(`is found by the message it came from`, () => {
        const row: S2sAttestationRow = { id: `x`, attestation: vouch, message: `m-1`, acceptedAt: NOW, verified: true, published: true };
        expect(carriedFrom([row], `m-1`)).toBe(row);
        expect(carriedFrom([row], `m-2`)).toBe(undefined);
    });
});
