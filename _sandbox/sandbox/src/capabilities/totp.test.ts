import { expect, test } from "vitest";
import { totpCode } from "./totp.js";

// RFC 6238 Appendix B vectors: ASCII seed "12345678901234567890" (base32 below), 8 digits, 30s, SHA-1 — plus
// the SHA-256 vector on its 32-byte seed. The 8-digit cases ride an otpauth URI because that is the only place
// digits/algorithm can be said; the bare-key case checks the universal 6-digit default (last six of 94287082).
const SEED_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SEED_SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====";

test("mints the RFC 6238 vectors", () => {
    const uri = (params: string): string => `otpauth://totp/npm:someone?secret=${SEED_SHA1}&${params}`;
    expect(totpCode(uri("digits=8"), 59_000).code).toBe("94287082");
    expect(totpCode(uri("digits=8"), 1_111_111_109_000).code).toBe("07081804");
    expect(totpCode(uri("digits=8"), 1_234_567_890_000).code).toBe("89005924");
    expect(totpCode(`otpauth://totp/x?secret=${SEED_SHA256}&digits=8&algorithm=SHA256`, 59_000).code).toBe("46119246");
    expect(totpCode(SEED_SHA1, 59_000)).toEqual({ code: "287082", secondsRemaining: 1 });
});

test("tolerates how seeds are actually pasted: lowercase, grouping, padding", () => {
    const canonical = totpCode(SEED_SHA1, 59_000).code;
    expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 59_000).code).toBe(canonical);
    expect(totpCode(`${SEED_SHA1}====`, 59_000).code).toBe(canonical);
    expect(totpCode(`  ${SEED_SHA1}\n`, 59_000).code).toBe(canonical);
});

test("secondsRemaining counts down the period", () => {
    expect(totpCode(SEED_SHA1, 30_000).secondsRemaining).toBe(30);
    expect(totpCode(SEED_SHA1, 59_999).secondsRemaining).toBe(1);
    // A 60s otpauth period is honoured — the code holds across what would be a default-period boundary.
    const uri = `otpauth://totp/x?secret=${SEED_SHA1}&period=60`;
    expect(totpCode(uri, 59_000).code).toBe(totpCode(uri, 1_000).code);
});

test("rejects what cannot be a seed, with the reason", () => {
    expect(() => totpCode("", 0)).toThrow("empty TOTP secret");
    expect(() => totpCode("notbase32!!", 0)).toThrow("not a base32 TOTP secret");
    expect(() => totpCode("otpauth://totp/x?issuer=y", 0)).toThrow("no secret parameter");
    expect(() => totpCode(`otpauth://totp/x?secret=${SEED_SHA1}&algorithm=MD5`, 0)).toThrow('unsupported otpauth algorithm "md5"');
    expect(() => totpCode(`otpauth://totp/x?secret=${SEED_SHA1}&digits=4`, 0)).toThrow("invalid digits/period");
});
