import { describe, it, expect } from "bun:test";
import { mintConnectToken, mintSetupCode } from "./mint-sandbox.js";

// Both of these travel as argv: `ic sandbox connect <code>`, and the shell one-liner the setup page hands out.
// base64url minted them before, and its `-` put one setup code in 64 in front of an argument parser as a flag —
// `error: unexpected argument '-T' found`, mid-install, on a machine that had already got Docker ready.
//
// The bug was live for as long as it was because the only test that could see it drew ONE code per nightly run
// (_tools/onboarding/src/provisioners/ic.ts) and so found it 1.6% of the time. Sampled downstream, it is a
// flake; asserted here on the generator, it is a fact.

const SAMPLE = 4_000;

const MINTERS = [
    { name: `mintSetupCode`, mint: mintSetupCode, length: 11 },
    { name: `mintConnectToken`, mint: mintConnectToken, length: 22 },
];

describe.each(MINTERS)(`$name`, ({ mint, length }) => {
    const minted = Array.from({ length: SAMPLE }, () => mint());

    it(`mints a secret no argument parser can read as a flag`, () => {
        expect(minted.every((secret) => /^[0-9A-Za-z]+$/.test(secret))).toBe(true);
    });

    it(`mints one length, so the shape of the one-liner never moves`, () => {
        expect(new Set(minted.map((secret) => secret.length))).toEqual(new Set([length]));
    });

    it(`draws on the whole alphabet without repeating itself`, () => {
        // Every character the alphabet holds shows up across the sample, and no two secrets collide: the first
        // would catch a truncated alphabet, the second a generator that lost its entropy.
        expect(new Set(minted.join(``)).size).toBe(62);
        expect(new Set(minted).size).toBe(SAMPLE);
    });
});
