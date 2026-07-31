import { webcrypto } from "node:crypto";
import { beforeAll, expect, test } from "vitest";
import { solveProofOfWork } from "./challenge.js";

// jsdom ships no SubtleCrypto; node's is the same WebCrypto the browser exposes, so the solver is exercised
// against the real digest rather than a stub.
beforeAll(() => {
    Object.defineProperty(globalThis, `crypto`, { value: webcrypto, configurable: true });
});

// The daemon verifies exactly this: hash the whole answer string and count the leading zero bits.
const leadingZeroBits = async (answer: string): Promise<number> => {
    const digest = new Uint8Array(await webcrypto.subtle.digest(`SHA-256`, new TextEncoder().encode(answer)));
    let bits = 0;
    for (const byte of digest) {
        if (byte !== 0) {
            return bits + Math.clz32(byte) - 24;
        }
        bits += 8;
    }
    return bits;
};

test(`the answer really clears the difficulty, and carries the salt back for the daemon to re-derive`, async () => {
    const answer = await solveProofOfWork({ salt: `abc123`, difficulty: 12 });
    expect(answer.startsWith(`abc123:`)).toBe(true);
    expect(await leadingZeroBits(answer)).toBeGreaterThanOrEqual(12);
});

test(`a different salt yields a different answer — a solution can't be replayed across conversations`, async () => {
    const [one, two] = await Promise.all([
        solveProofOfWork({ salt: `salt-one`, difficulty: 10 }),
        solveProofOfWork({ salt: `salt-two`, difficulty: 10 }),
    ]);
    expect(one).not.toBe(two);
});

test(`an http:// page is told the truth instead of hanging on a missing SubtleCrypto`, async () => {
    Object.defineProperty(globalThis, `crypto`, { value: { randomUUID: webcrypto.randomUUID }, configurable: true });
    await expect(solveProofOfWork({ salt: `abc`, difficulty: 8 })).rejects.toThrow(/HTTPS/);
    Object.defineProperty(globalThis, `crypto`, { value: webcrypto, configurable: true });
});
