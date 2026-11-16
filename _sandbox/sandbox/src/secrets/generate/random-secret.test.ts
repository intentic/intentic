import { randomSecret } from "./random-secret.js";

// The spelling a reader asked for, at the strength asked for, and never the same twice.

test("hex is two characters per byte, from 0-9 and a-f", () => {
    expect(randomSecret(32, "hex")).toMatch(/^[0-9a-f]{64}$/u);
});

test("base64url carries no padding and no character a URL or a header would need escaped", () => {
    expect(randomSecret(32, "base64url")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
});

test("alnum is letters and digits only, long enough to carry the same randomness", () => {
    // 32 bytes is 256 bits; at log2(62) ≈ 5.95 bits a character that takes 43 of them.
    expect(randomSecret(32, "alnum")).toMatch(/^[A-Za-z0-9]{43}$/u);
    expect(randomSecret(16, "alnum")).toMatch(/^[A-Za-z0-9]{22}$/u);
});

test("two values are never the same", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomSecret(16, "alnum")));
    expect(seen.size).toBe(50);
});
