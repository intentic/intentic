import { describe, expect, it } from "vitest";
import { mintSetupCode } from "./mint-sandbox.js";

// A setup code travels as argv: `ic sandbox connect <code>`, and the shell one-liner the setup page hands out.
// base64url minted it before, and its `-` put one code in 64 in front of an argument parser as a flag —
// `error: unexpected argument '-T' found`, mid-install, on a machine that had already got Docker ready.

const SAMPLE = 4_000;
const codes = Array.from({ length: SAMPLE }, () => mintSetupCode());

describe(`mintSetupCode`, () => {
    it(`mints a code no argument parser can read as a flag`, () => {
        expect(codes.every((code) => /^[0-9A-Za-z]+$/.test(code))).toBe(true);
    });

    it(`mints one length, so the shape of the one-liner never moves`, () => {
        expect(new Set(codes.map((code) => code.length))).toEqual(new Set([11]));
    });

    it(`draws on the whole alphabet without repeating itself`, () => {
        // Every character the alphabet holds shows up across the sample, and no two codes collide: the first
        // would catch a truncated alphabet, the second a generator that lost its entropy.
        expect(new Set(codes.join(``)).size).toBe(62);
        expect(new Set(codes).size).toBe(SAMPLE);
    });
});
