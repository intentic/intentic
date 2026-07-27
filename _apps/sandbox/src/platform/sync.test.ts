import { existsSync, mkdtempSync } from "node:fs";
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
    restoreAuthorizedKeys,
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
// each enrollment's sync token is independently valid + self-revocable. The store goes to a temp historyRoot
// (standing in for the /history volume) and HOME → a temp dir so the derived authorized_keys lands there rather
// than in the real home.
describe("enrollment store", () => {
    let history: string;
    beforeEach(() => {
        history = mkdtempSync(join(tmpdir(), "sync-history-"));
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
        const a = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        const c = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "mirror", takeover: false }));
        expect(await verifySyncToken(history, a)).toBe(true);
        expect(await verifySyncToken(history, b)).toBe(true);
        expect(await verifySyncToken(history, c)).toBe(true);
        expect((await mirrorMachines(history)).toSorted()).toEqual(["laptop-a", "laptop-b", "laptop-c"]);
        // authorized_keys carries every machine's key — sshd authorizes all three forwarders.
        const authKeys = await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8");
        expect(authKeys.trim().split("\n")).toHaveLength(3);
        // No file-sync holder — these are mirror-only.
        expect(await syncHolder(history)).toBeUndefined();
    });

    it("file sync is single-holder — a second sync enroll is refused, a takeover replaces it", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        // A DIFFERENT machine can't grab sync without takeover.
        expect(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: false })).toEqual({ locked: "laptop-a" });
        expect(await syncHolder(history)).toBe("laptop-a");
        // Takeover moves it — and kills the old holder's token.
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: true }));
        expect(await syncHolder(history)).toBe("laptop-b");
        expect(await verifySyncToken(history, first)).toBe(false);
        expect(await verifySyncToken(history, second)).toBe(true);
    });

    it("mirror enrollments survive a sync takeover — collaborators keep their previews", async () => {
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false });
        // A sync takeover only displaces the sync holder; the mirror-only machine is untouched.
        await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "sync", takeover: true });
        expect(await verifySyncToken(history, mirror)).toBe(true);
        expect(await mirrorMachines(history)).toEqual(["laptop-b"]);
        expect(await syncHolder(history)).toBe("laptop-c");
    });

    it("re-enrolling the same machine rotates its token", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        expect(first).not.toBe(second);
        expect(await verifySyncToken(history, first)).toBe(false);
        expect(await verifySyncToken(history, second)).toBe(true);
        expect(await mirrorMachines(history)).toEqual(["laptop-a"]); // still one machine, not duplicated
    });

    // The rebuild case, which is what a "sync stopped working after I rebuilt" report actually is. A recreate
    // keeps only the volumes: the store on /history survives, the container filesystem (and with it the
    // authorized_keys sshd reads) does not. Both halves matter — the tokens must still verify AND sshd must
    // authorize the same keys again — so simulate it by pointing HOME at a fresh dir and re-deriving.
    it("survives a container recreate — the store persists and authorized_keys is re-derived from it", async () => {
        const laptop = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const collaborator = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));

        process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-recreated-"));
        expect(existsSync(join(process.env["HOME"]!, ".ssh", "authorized_keys"))).toBe(false);

        await restoreAuthorizedKeys(history);

        expect((await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).trim().split("\n").toSorted()).toEqual([
            key("laptop-a"),
            key("laptop-b"),
        ]);
        expect(await verifySyncToken(history, laptop)).toBe(true);
        expect(await verifySyncToken(history, collaborator)).toBe(true);
        expect(await syncHolder(history)).toBe("laptop-a");
    });

    // A sandbox nobody has ever enrolled on must still land an empty file, so sshd reads "no one is authorized"
    // rather than falling back to whatever a previous life left behind.
    it("restores an empty authorized_keys when no one is enrolled", async () => {
        await restoreAuthorizedKeys(history);
        expect(await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).toBe("");
    });

    it("self-revoke drops just that enrollment; clear-all drops everyone", async () => {
        const a = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        expect(await revokeEnrollmentByToken(history, a)).toBe(true);
        expect(await verifySyncToken(history, a)).toBe(false);
        expect(await verifySyncToken(history, b)).toBe(true); // b unaffected
        expect(await revokeEnrollmentByToken(history, "ist_never-enrolled")).toBe(false);
        await clearAllEnrollments(history);
        expect(await verifySyncToken(history, b)).toBe(false);
        expect(await isKeyEnrolled(history)).toBe(false);
    });
});
