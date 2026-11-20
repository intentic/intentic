import { createHmac } from "node:crypto";
import { mintMediaToken } from "./media-token.js";

// The token is checked by castd, in Rust: the only proof the two halves agree is castd's own test vector
// (_sandbox/castd/src/token.rs), computed there independently with Node's crypto. Both vectors are copied here as castd
// states them, since castd's source is another crate and this suite cannot read it at run time.
const KEY = Buffer.from("castd-test-key", "ascii");
const TOKEN = "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjpmYWxzZX0.YKTUvxiTZMF1qntsiKCawvxUDDzjYqLIgo9u7ovM2yU";
const READ_ONLY = "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjp0cnVlfQ.pjevX1BbOWyWEvjGnL0pHTHEPQGANDz1M_C9oDrj9L8";

describe("mintMediaToken", () => {
    test("signs castd's test vector byte for byte", () => {
        expect(mintMediaToken(KEY, { session: "browser-own", expiresAt: 1_893_456_000_000, readOnly: false })).toBe(TOKEN);
        expect(mintMediaToken(KEY, { session: "browser-own", expiresAt: 1_893_456_000_000, readOnly: true })).toBe(READ_ONLY);
    });

    test("writes the claims in castd's key order, unpadded, the MAC over exactly those bytes", () => {
        const token = mintMediaToken(KEY, { session: "cast-_own", expiresAt: 1_700_000_000_123.9, readOnly: false });
        const [payload, mac] = token.split(".");
        const bytes = Buffer.from(payload ?? "", "base64url");
        // Whole milliseconds: castd reads `exp` as an unsigned integer and refuses a fraction.
        expect(bytes.toString("utf8")).toBe(`{"s":"cast-_own","exp":1700000000123,"ro":false}`);
        expect(token).not.toContain("=");
        expect(mac).toBe(createHmac("sha256", KEY).update(bytes).digest("base64url"));
    });

    test("says when it was minted, after the other claims, so castd can refuse one from before a drop", () => {
        const token = mintMediaToken(KEY, { session: "cast-_own", expiresAt: 1_700_000_060_000, readOnly: true, issuedAt: 1_700_000_000_000.7 });
        const bytes = Buffer.from(token.split(".")[0] ?? "", "base64url");
        expect(bytes.toString("utf8")).toBe(`{"s":"cast-_own","exp":1700000060000,"ro":true,"iat":1700000000000}`);
    });
});
