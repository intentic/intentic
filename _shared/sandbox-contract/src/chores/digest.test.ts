import { describe, expect, test } from "vitest";
import { bucketOf, digestOf } from "./digest.js";

describe(`digestOf`, () => {
    test(`is stable for the same parts and different for different ones`, () => {
        expect(digestOf(`a`, `b`)).toBe(digestOf(`a`, `b`));
        expect(digestOf(`a`, `b`)).not.toBe(digestOf(`b`, `a`));
        expect(digestOf(`a`)).not.toBe(digestOf(`aa`));
    });

    test(`is short enough to sit in a JSON ledger without anyone minding`, () => {
        expect(digestOf(`x`.repeat(10_000)).length).toBeLessThanOrEqual(8);
    });
});

/* The anti-drift mechanism. A chore that counts things must not mint a new digest, and therefore a new badge:
 * every time an ordinary day's work moves the number by one. Buckets widen with the count, because the difference
 * between one and two matters and the difference between four hundred and five hundred does not. */
describe(`bucketOf`, () => {
    test(`absorbs drift and keeps the moves that mean something`, () => {
        expect(bucketOf(12)).toBe(bucketOf(13));
        expect(bucketOf(12)).not.toBe(bucketOf(40));
        expect(bucketOf(1)).not.toBe(bucketOf(2));
        expect(bucketOf(400)).toBe(bucketOf(500));
    });

    test(`nothing is its own bucket, so a chore's first finding of a kind is always news`, () => {
        expect(bucketOf(0)).not.toBe(bucketOf(1));
    });
});
