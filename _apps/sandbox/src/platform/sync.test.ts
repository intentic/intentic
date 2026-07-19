import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearAllEnrollments,
    consumePairing,
    enrollSyncKey,
    isKeyEnrolled,
    isValidPairing,
    mintPairing,
    mirrorMachines,
    pairingMode,
    revokeEnrollmentByToken,
    syncHolder,
    verifySyncToken,
} from "./sync.js";

// The pairing token is the whole auth for desktop enrollment, so lock down its guarantees: single-use,
// time-limited, and mode-carrying (the enroll trusts the pairing's mode, not the agent).
describe("pairing tokens", () => {
    afterEach(() => vi.useRealTimers());

    it("is valid once, carries its mode, then is consumed", () => {
        const { token } = mintPairing("mirror");
        expect(isValidPairing(token)).toBe(true);
        expect(pairingMode(token)).toBe("mirror");
        consumePairing(token);
        expect(isValidPairing(token)).toBe(false);
        expect(pairingMode(token)).toBeUndefined();
    });

    it("rejects an unknown token", () => {
        expect(isValidPairing("never-minted")).toBe(false);
    });

    it("expires after its TTL", () => {
        vi.useFakeTimers();
        const { token, expiresIn } = mintPairing("sync");
        vi.advanceTimersByTime((expiresIn + 1) * 1000);
        expect(isValidPairing(token)).toBe(false);
    });
});

// The enrollment store is the multi-user heart: file sync is single-holder, port mirroring is unlimited, and
// each enrollment's sync token is independently valid + self-revocable. HOME → a temp dir so keys/store land
// there, not the real home.
describe("enrollment store", () => {
    beforeEach(() => {
        process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-enroll-"));
    });

    const key = (machine: string): string => `ssh-ed25519 AAAA${machine} ${machine}`;

    const token = async (result: Awaited<ReturnType<typeof enrollSyncKey>>): Promise<string> => {
        if ("locked" in result) {
            throw new Error(`expected a token, got locked by ${result.locked}`);
        }
        return result.syncToken;
    };

    it("port mirroring is unlimited — many machines enroll and each token is valid", async () => {
        const a = await token(await enrollSyncKey({ key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ key: key("laptop-b"), mode: "mirror", takeover: false }));
        const c = await token(await enrollSyncKey({ key: key("laptop-c"), mode: "mirror", takeover: false }));
        expect(await verifySyncToken(a)).toBe(true);
        expect(await verifySyncToken(b)).toBe(true);
        expect(await verifySyncToken(c)).toBe(true);
        expect((await mirrorMachines()).toSorted()).toEqual(["laptop-a", "laptop-b", "laptop-c"]);
        // authorized_keys carries every machine's key — sshd authorizes all three forwarders.
        const authKeys = await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8");
        expect(authKeys.trim().split("\n")).toHaveLength(3);
        // No file-sync holder — these are mirror-only.
        expect(await syncHolder()).toBeUndefined();
    });

    it("file sync is single-holder — a second sync enroll is refused, a takeover replaces it", async () => {
        const first = await token(await enrollSyncKey({ key: key("laptop-a"), mode: "sync", takeover: false }));
        // A DIFFERENT machine can't grab sync without takeover.
        expect(await enrollSyncKey({ key: key("laptop-b"), mode: "sync", takeover: false })).toEqual({ locked: "laptop-a" });
        expect(await syncHolder()).toBe("laptop-a");
        // Takeover moves it — and kills the old holder's token.
        const second = await token(await enrollSyncKey({ key: key("laptop-b"), mode: "sync", takeover: true }));
        expect(await syncHolder()).toBe("laptop-b");
        expect(await verifySyncToken(first)).toBe(false);
        expect(await verifySyncToken(second)).toBe(true);
    });

    it("mirror enrollments survive a sync takeover — collaborators keep their previews", async () => {
        const mirror = await token(await enrollSyncKey({ key: key("laptop-b"), mode: "mirror", takeover: false }));
        await enrollSyncKey({ key: key("laptop-a"), mode: "sync", takeover: false });
        // A sync takeover only displaces the sync holder; the mirror-only machine is untouched.
        await enrollSyncKey({ key: key("laptop-c"), mode: "sync", takeover: true });
        expect(await verifySyncToken(mirror)).toBe(true);
        expect(await mirrorMachines()).toEqual(["laptop-b"]);
        expect(await syncHolder()).toBe("laptop-c");
    });

    it("re-enrolling the same machine rotates its token", async () => {
        const first = await token(await enrollSyncKey({ key: key("laptop-a"), mode: "mirror", takeover: false }));
        const second = await token(await enrollSyncKey({ key: key("laptop-a"), mode: "mirror", takeover: false }));
        expect(first).not.toBe(second);
        expect(await verifySyncToken(first)).toBe(false);
        expect(await verifySyncToken(second)).toBe(true);
        expect(await mirrorMachines()).toEqual(["laptop-a"]); // still one machine, not duplicated
    });

    it("self-revoke drops just that enrollment; clear-all drops everyone", async () => {
        const a = await token(await enrollSyncKey({ key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ key: key("laptop-b"), mode: "mirror", takeover: false }));
        expect(await revokeEnrollmentByToken(a)).toBe(true);
        expect(await verifySyncToken(a)).toBe(false);
        expect(await verifySyncToken(b)).toBe(true); // b unaffected
        expect(await revokeEnrollmentByToken("ist_never-enrolled")).toBe(false);
        await clearAllEnrollments();
        expect(await verifySyncToken(b)).toBe(false);
        expect(await isKeyEnrolled()).toBe(false);
    });
});
