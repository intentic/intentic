import { describe, expect, test } from "vitest";
import { lanesFor, type OfferRead } from "./setupLanes";

const yes: OfferRead<boolean> = { kind: `answered`, value: true };
const no: OfferRead<boolean> = { kind: `answered`, value: false };
const lost = { kind: `unreachable` } as const;
const hosting = (remaining: number): OfferRead<{ enabled: boolean; remaining: number }> => ({
    kind: `answered`,
    value: { enabled: true, remaining },
});
const notHosting: OfferRead<{ enabled: boolean; remaining: number }> = { kind: `answered`, value: { enabled: false, remaining: 0 } };

describe(`lanesFor`, () => {
    test(`an address to mint is a lane`, () => {
        expect(lanesFor({ address: yes, hosted: notHosting, hasMachine: false })).toEqual({ kind: `takeable` });
    });

    test(`a machine still on the allowance is a lane`, () => {
        expect(lanesFor({ address: no, hosted: hosting(1), hasMachine: false })).toEqual({ kind: `takeable` });
    });

    /* A resumed hosted sandbox: the hardware exists, so what the platform says about NEW machines is beside the
     * point. Reading the offers alone would tell somebody watching their own box boot that there is nothing to
     * take. */
    test(`hardware already on the row outranks every offer`, () => {
        expect(lanesFor({ address: no, hosted: hosting(0), hasMachine: true })).toEqual({ kind: `takeable` });
        expect(lanesFor({ address: lost, hosted: lost, hasMachine: true })).toEqual({ kind: `takeable` });
    });

    // The honest screen for a self-hosted platform running no fabric: attach is the product, not a fallback.
    test(`a platform that provisions nothing says so`, () => {
        expect(lanesFor({ address: no, hosted: notHosting, hasMachine: false })).toEqual({ kind: `none` });
    });

    test(`a spent allowance is its own answer, not "nothing here"`, () => {
        expect(lanesFor({ address: no, hosted: hosting(0), hasMachine: false })).toEqual({ kind: `spent` });
    });

    /* THE ONE THIS MODULE EXISTS FOR. A dropped request used to read as "this platform provisions nothing" and
     * moved the reader onto the domain form. Not knowing is a retry. */
    test(`a read that failed is not a platform that said no`, () => {
        expect(lanesFor({ address: lost, hosted: lost, hasMachine: false })).toEqual({ kind: `unreachable` });
    });

    test(`one lost read poisons a "no" from the other`, () => {
        expect(lanesFor({ address: no, hosted: lost, hasMachine: false })).toEqual({ kind: `unreachable` });
        expect(lanesFor({ address: lost, hosted: notHosting, hasMachine: false })).toEqual({ kind: `unreachable` });
    });

    // …but a read that ANSWERED YES needs no second opinion: there is a lane, whatever the other call did.
    test(`a lane in hand beats a lost read`, () => {
        expect(lanesFor({ address: yes, hosted: lost, hasMachine: false })).toEqual({ kind: `takeable` });
        expect(lanesFor({ address: lost, hosted: hosting(1), hasMachine: false })).toEqual({ kind: `takeable` });
    });
});
