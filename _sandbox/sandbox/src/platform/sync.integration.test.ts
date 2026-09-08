import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairings } from "../store/enrollment.js";
import {
    enrolledFleet,
    enrollSyncKey,
    isKeyEnrolled,
    restoreAuthorizedKeys,
    revokeEnrollmentByMachine,
    revokeEnrollmentByToken,
    syncPairBurnPath,
    type SyncMode,
    verifySyncToken,
} from "./sync.js";

// Local projections over the one list the store publishes: who holds file sync, and who else is enrolled.
const holderOf = async (historyRoot: string): Promise<{ machine: string; seenAt?: number } | undefined> => {
    const held = (await enrolledFleet(historyRoot)).machines.find((entry) => entry.mode === "sync");
    // Narrowed to the two fields the assertions use; `mode` was already selected on.
    return held === undefined ? undefined : { machine: held.machine, ...(held.seenAt === undefined ? {} : { seenAt: held.seenAt }) };
};
const mirrorsOf = async (historyRoot: string): Promise<string[]> =>
    (await enrolledFleet(historyRoot)).machines.filter((entry) => entry.mode === "mirror").map((entry) => entry.machine);

// Pins this door's use of pairings: single-use, time-limited, and mode-carrying — the enroll trusts the pairing's mode,
// not the agent.
describe("pairing tokens", () => {
    afterEach(() => vi.useRealTimers());

    const table = (): { pending: ReturnType<typeof pairings<SyncMode>>; historyRoot: string } => {
        const historyRoot = mkdtempSync(join(tmpdir(), "sync-"));
        return { pending: pairings<SyncMode>(syncPairBurnPath(historyRoot)), historyRoot };
    };

    it("is valid once, carries its mode, then is consumed", async () => {
        const { pending } = table();
        const { token } = pending.mint("mirror");
        expect(pending.peek(token)).toBe("mirror");
        await pending.consume(token);
        expect(pending.peek(token)).toBeUndefined();
    });

    it("rejects an unknown token", () => {
        expect(table().pending.peek("never-minted")).toBeUndefined();
    });

    it("expires after its TTL", () => {
        vi.useFakeTimers();
        const { pending } = table();
        const { token, expiresIn } = pending.mint("sync");
        vi.advanceTimersByTime((expiresIn + 1) * 1000);
        expect(pending.peek(token)).toBeUndefined();
    });

    // The setup-time token lives in the container's env, which survives every restart; once redeemed it must stay dead
    // or a leaked env becomes permanent access.
    it("arms the setup-time token once and never re-arms it after redemption", async () => {
        const { pending, historyRoot } = table();
        const token = "setup-time-token";

        expect(await pending.arm(token, "sync")).toBe(true);
        expect(pending.peek(token)).toBe("sync"); // The owner's own token grants full sync, not mirror.

        await pending.consume(token);
        expect(pending.peek(token)).toBeUndefined();

        // New table, same env and token: the burn lives on /history, which survives the restart.
        const rebooted = pairings<SyncMode>(syncPairBurnPath(historyRoot));
        expect(await rebooted.arm(token, "sync")).toBe(false);
        expect(rebooted.peek(token)).toBeUndefined();
    });

    // /setup/claim mints a new token per claim; only replay of an already-spent token is refused.
    it("still arms a freshly minted setup token after an earlier one was spent", async () => {
        const { pending } = table();
        await pending.arm("first-claim", "sync");
        await pending.consume("first-claim");

        expect(await pending.arm("second-claim", "sync")).toBe(true);
        expect(pending.peek("second-claim")).toBe("sync");
    });
});

// File sync is single-holder, port mirroring is unlimited, each token self-revocable. HOME is a temp dir, so
// authorized_keys lands there, not in the real home.
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

    it("port mirroring is unlimited: many machines enroll and each token is valid", async () => {
        const a = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        const c = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "mirror", takeover: false }));
        expect(await verifySyncToken(history, a, true)).toBe(true);
        expect(await verifySyncToken(history, b, true)).toBe(true);
        expect(await verifySyncToken(history, c, true)).toBe(true);
        expect((await mirrorsOf(history)).toSorted()).toEqual(["laptop-a", "laptop-b", "laptop-c"]);
        const authKeys = await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8");
        expect(authKeys.trim().split("\n")).toHaveLength(3);
        expect(await holderOf(history)).toBeUndefined();
    });

    it("file sync is single-holder: a second sync enroll is refused, a takeover replaces it", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        expect(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: false })).toEqual({ locked: "laptop-a" });
        expect((await holderOf(history))?.machine).toBe("laptop-a");
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: true }));
        expect((await holderOf(history))?.machine).toBe("laptop-b");
        expect(await verifySyncToken(history, first, true)).toBe(false);
        expect(await verifySyncToken(history, second, true)).toBe(true);
    });

    it("mirror enrollments survive a sync takeover: collaborators keep their previews", async () => {
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false });
        await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "sync", takeover: true });
        expect(await verifySyncToken(history, mirror, true)).toBe(true);
        expect(await mirrorsOf(history)).toEqual(["laptop-b"]);
        expect((await holderOf(history))?.machine).toBe("laptop-c");
    });

    it("re-enrolling the same machine rotates its token", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        expect(first).not.toBe(second);
        expect(await verifySyncToken(history, first, true)).toBe(false);
        expect(await verifySyncToken(history, second, true)).toBe(true);
        expect(await mirrorsOf(history)).toEqual(["laptop-a"]);
    });

    // Simulates a recreate: the store's volume persists, the container fs does not, so HOME points at a fresh dir.
    it("survives a container recreate: the store persists and authorized_keys is re-derived from it", async () => {
        const laptop = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const collaborator = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));

        process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-recreated-"));
        expect(existsSync(join(process.env["HOME"]!, ".ssh", "authorized_keys"))).toBe(false);

        await restoreAuthorizedKeys(history);

        expect((await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).trim().split("\n").toSorted()).toEqual([
            key("laptop-a"),
            key("laptop-b"),
        ]);
        expect(await verifySyncToken(history, laptop, true)).toBe(true);
        expect(await verifySyncToken(history, collaborator, true)).toBe(true);
        expect((await holderOf(history))?.machine).toBe("laptop-a");
    });

    it("restores an empty authorized_keys when no one is enrolled", async () => {
        await restoreAuthorizedKeys(history);
        expect(await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).toBe("");
    });

    // Verification is the only signal a live sync gives; if it doesn't stamp, nothing marks the machine as here.
    it("stamps seenAt when a machine uses its enrollment, and never before", async () => {
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false });
        // No seenAt yet: the UI reads that as setup not finished, not as healthy.
        expect(await holderOf(history)).toEqual({ machine: "laptop-a" });

        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const before = Date.now();
        expect(await verifySyncToken(history, holderToken, true)).toBe(true);

        // Slack on both sides: the wall clock read here and the one inside verifySyncToken can slew a few ms apart
        // under load, and the bound only needs to rule out anything but this poll.
        const CLOCK_SKEW_MS = 50;
        const seen = (await holderOf(history))?.seenAt;
        expect(seen).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);
        expect(seen).toBeLessThanOrEqual(Date.now() + CLOCK_SKEW_MS);
    });

    // Transport traffic proves Mutagen is running, not that the watcher's poll loop is alive.
    it("does not stamp seenAt for bytes on the SSH transport, only for the watcher's own polls", async () => {
        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        expect(await verifySyncToken(history, holderToken, false)).toBe(true);
        expect(await holderOf(history)).toEqual({ machine: "laptop-a" });
    });

    it("leaves seenAt alone for a rejected token: a stranger's poll must not look like the holder's", async () => {
        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        await verifySyncToken(history, holderToken, true);
        const stamped = (await holderOf(history))?.seenAt;

        expect(await verifySyncToken(history, "ist_not-enrolled", true)).toBe(false);

        expect((await holderOf(history))?.seenAt).toBe(stamped);
    });

    it("throttles the stamp rather than writing on every poll", async () => {
        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        await verifySyncToken(history, holderToken, true);
        const first = (await holderOf(history))?.seenAt;

        await verifySyncToken(history, holderToken, true);
        await verifySyncToken(history, holderToken, true);

        expect((await holderOf(history))?.seenAt).toBe(first);
    });

    it("does not invent a sync holder out of a mirror-only machine's poll", async () => {
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        expect(await verifySyncToken(history, mirror, true)).toBe(true);
        expect(await holderOf(history)).toBeUndefined();
        expect(await mirrorsOf(history)).toEqual(["laptop-b"]);
    });

    it("self-revoke drops just that enrollment", async () => {
        const a = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        expect(await revokeEnrollmentByToken(history, a)).toBe(true);
        expect(await verifySyncToken(history, a, true)).toBe(false);
        expect(await verifySyncToken(history, b, true)).toBe(true);
        expect(await revokeEnrollmentByToken(history, "ist_never-enrolled")).toBe(false);
    });

    it("the owner's revoke takes one machine and leaves the rest syncing", async () => {
        const holder = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));

        expect(await revokeEnrollmentByMachine(history, "laptop-b")).toBe(true);
        expect(await verifySyncToken(history, mirror, true)).toBe(false);
        expect(await verifySyncToken(history, holder, true)).toBe(true);
        expect((await holderOf(history))?.machine).toBe("laptop-a");
        // sshd's view moves with the store: the revoked key drops out of authorized_keys too.
        expect((await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).trim().split("\n")).toEqual([key("laptop-a")]);

        // An unknown machine returns false, which the route turns into 404, not a silent success.
        expect(await revokeEnrollmentByMachine(history, "laptop-b")).toBe(false);
        expect(await revokeEnrollmentByMachine(history, "never-paired")).toBe(false);

        // Revoking the last one leaves the store readable as nobody enrolled.
        expect(await revokeEnrollmentByMachine(history, "laptop-a")).toBe(true);
        expect(await isKeyEnrolled(history)).toBe(false);
    });
});
