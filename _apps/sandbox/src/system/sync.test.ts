import { afterEach, describe, expect, it, vi } from "vitest";
import { consumePairing, isValidPairing, mintPairing } from "./sync.js";

// The pairing token is the whole auth for desktop-sync key enrollment, so lock down its two guarantees:
// single-use and time-limited.
describe("pairing tokens", () => {
    afterEach(() => vi.useRealTimers());

    it("is valid once, then consumed", () => {
        const { token } = mintPairing();
        expect(isValidPairing(token)).toBe(true);
        consumePairing(token);
        expect(isValidPairing(token)).toBe(false);
    });

    it("rejects an unknown token", () => {
        expect(isValidPairing("never-minted")).toBe(false);
    });

    it("expires after its TTL", () => {
        vi.useFakeTimers();
        const { token, expiresIn } = mintPairing();
        vi.advanceTimersByTime((expiresIn + 1) * 1000);
        expect(isValidPairing(token)).toBe(false);
    });
});
