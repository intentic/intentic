import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSyncToken, consumePairing, isValidPairing, mintPairing, mintSyncToken, verifySyncToken } from "./sync.js";

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

// The sync token is the mirror command's whole credential (scoped daemon-side to GET /ports), so lock down its
// lifecycle: digest-at-rest verification, rotation on re-mint (a takeover kills the ousted machine's token),
// and revocation with the key.
describe("sync token", () => {
    it("mints, verifies, rotates on re-mint, and clears", async () => {
        process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-token-"));
        const token = await mintSyncToken();
        expect(token).toMatch(/^ist_/);
        await expect(verifySyncToken(token)).resolves.toBe(true);
        await expect(verifySyncToken("ist_bogus")).resolves.toBe(false);
        const rotated = await mintSyncToken();
        await expect(verifySyncToken(token)).resolves.toBe(false);
        await expect(verifySyncToken(rotated)).resolves.toBe(true);
        await clearSyncToken();
        await expect(verifySyncToken(rotated)).resolves.toBe(false);
    });
});
