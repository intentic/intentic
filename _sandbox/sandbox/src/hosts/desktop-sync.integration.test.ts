import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairings } from "../peers/enrollment.js";
import {
    enrolledFleet,
    enrollSyncKey,
    isFileSyncEnrolled,
    isKeyEnrolled,
    recordDeviceReport,
    restoreAuthorizedKeys,
    revokeEnrollmentByMachine,
    revokeEnrollmentByToken,
    syncPairBurns,
    type SyncMode,
    verifySyncToken,
} from "./desktop-sync.js";

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
    afterEach(() => jest.useRealTimers());

    const table = (): { pending: ReturnType<typeof pairings<SyncMode>>; historyRoot: string } => {
        const historyRoot = mkdtempSync(join(tmpdir(), "sync-"));
        return { pending: pairings<SyncMode>(syncPairBurns(historyRoot)), historyRoot };
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
        jest.useFakeTimers();
        const { pending } = table();
        const { token, expiresIn } = pending.mint("sync");
        jest.advanceTimersByTime((expiresIn + 1) * 1000);
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
        const rebooted = pairings<SyncMode>(syncPairBurns(historyRoot));
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
        expect(await verifySyncToken(history, a, true)).toEqual({ kind: "enrolled", id: "laptop-a", card: "laptop-a" });
        expect(await verifySyncToken(history, b, true)).toEqual({ kind: "enrolled", id: "laptop-b", card: "laptop-b" });
        expect(await verifySyncToken(history, c, true)).toEqual({ kind: "enrolled", id: "laptop-c", card: "laptop-c" });
        expect((await mirrorsOf(history)).toSorted()).toEqual(["laptop-a", "laptop-b", "laptop-c"]);
        const authKeys = await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8");
        expect(authKeys.trim().split("\n")).toHaveLength(3);
        expect(await holderOf(history)).toBeUndefined();
    });

    it("tells a fleet that mirrors ports from one that holds the files", async () => {
        // The backup nudge turns on this difference: mirroring machines are enrolled and hold none of the work.
        expect(await isKeyEnrolled(history)).toBe(false);
        expect(await isFileSyncEnrolled(history)).toBe(false);
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false });
        await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false });
        expect(await isKeyEnrolled(history)).toBe(true);
        expect(await isFileSyncEnrolled(history)).toBe(false);
        await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "sync", takeover: false });
        expect(await isFileSyncEnrolled(history)).toBe(true);
        // Revoking the holder leaves the mirrors enrolled, and the files unheld again.
        expect(await revokeEnrollmentByMachine(history, "laptop-c")).toBe(true);
        expect(await isKeyEnrolled(history)).toBe(true);
        expect(await isFileSyncEnrolled(history)).toBe(false);
    });

    it("file sync is single-holder: a second sync enroll is refused, a takeover replaces it", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        expect(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: false })).toEqual({ locked: "laptop-a" });
        expect((await holderOf(history))?.machine).toBe("laptop-a");
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: true }));
        expect((await holderOf(history))?.machine).toBe("laptop-b");
        expect(await verifySyncToken(history, first, true)).toEqual({ kind: "unknown" });
        expect(await verifySyncToken(history, second, true)).toEqual({ kind: "enrolled", id: "laptop-b", card: "laptop-b" });
    });

    it("mirror enrollments survive a sync takeover: collaborators keep their previews", async () => {
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false });
        await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "sync", takeover: true });
        expect(await verifySyncToken(history, mirror, true)).toEqual({ kind: "enrolled", id: "laptop-b", card: "laptop-b" });
        expect(await mirrorsOf(history)).toEqual(["laptop-b"]);
        expect((await holderOf(history))?.machine).toBe("laptop-c");
    });

    it("re-enrolling the same machine rotates its token", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        expect(first).not.toBe(second);
        expect(await verifySyncToken(history, first, true)).toEqual({ kind: "unknown" });
        expect(await verifySyncToken(history, second, true)).toEqual({ kind: "enrolled", id: "laptop-a", card: "laptop-a" });
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
        expect(await verifySyncToken(history, laptop, true)).toEqual({ kind: "enrolled", id: "laptop-a", card: "laptop-a" });
        expect(await verifySyncToken(history, collaborator, true)).toEqual({ kind: "enrolled", id: "laptop-b", card: "laptop-b" });
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
        expect(await verifySyncToken(history, holderToken, true)).toEqual({ kind: "enrolled", id: "laptop-a", card: "laptop-a" });

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
        expect(await verifySyncToken(history, holderToken, false)).toEqual({ kind: "enrolled", id: "laptop-a", card: "laptop-a" });
        expect(await holderOf(history)).toEqual({ machine: "laptop-a" });
    });

    it("leaves seenAt alone for a rejected token: a stranger's poll must not look like the holder's", async () => {
        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        await verifySyncToken(history, holderToken, true);
        const stamped = (await holderOf(history))?.seenAt;

        expect(await verifySyncToken(history, "ist_not-enrolled", true)).toEqual({ kind: "unknown" });

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
        expect(await verifySyncToken(history, mirror, true)).toEqual({ kind: "enrolled", id: "laptop-b", card: "laptop-b" });
        expect(await holderOf(history)).toBeUndefined();
        expect(await mirrorsOf(history)).toEqual(["laptop-b"]);
    });

    // A store this daemon cannot read is its own problem: answered as a stranger's token, the laptop would drop its pairing.
    it("answers an unreadable store as unreadable, never as a token nobody holds", async () => {
        const laptop = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        await writeFile(join(history, "sync-enrollments.json"), "{ not json");
        expect(await verifySyncToken(history, laptop, true)).toEqual({ kind: "unreadable", detail: "the file is not valid JSON" });
    });

    it("self-revoke drops just that enrollment", async () => {
        const a = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        expect(await revokeEnrollmentByToken(history, a)).toBe(true);
        expect(await verifySyncToken(history, a, true)).toEqual({ kind: "unknown" });
        expect(await verifySyncToken(history, b, true)).toEqual({ kind: "enrolled", id: "laptop-b", card: "laptop-b" });
        expect(await revokeEnrollmentByToken(history, "ist_never-enrolled")).toBe(false);
    });

    it("the owner's revoke takes one machine and leaves the rest syncing", async () => {
        const holder = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));

        expect(await revokeEnrollmentByMachine(history, "laptop-b")).toBe(true);
        expect(await verifySyncToken(history, mirror, true)).toEqual({ kind: "unknown" });
        expect(await verifySyncToken(history, holder, true)).toEqual({ kind: "enrolled", id: "laptop-a", card: "laptop-a" });
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

    // WHICH COMPUTER HOLDS AN ENROLLMENT: said by the agent when it enrolls, or stamped once from the first report of an
    // agent that enrolled before it could say, never from a report filed under another machine's token.
    it("records the machine an agent says it is on, at enrollment or from its first report", async () => {
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false, machineId: "m-laptop-a-0001", environment: "native" });
        const older = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: false }));
        const report = {
            machineId: "m-laptop-b-0001",
            hostname: "laptop-b",
            os: "linux",
            wsl: { distro: "Arch" },
            pairings: [],
            ports: [],
            agent: { running: true },
            capturedAt: 1,
        };
        expect(await recordDeviceReport(history, older, report)).toBe(true);
        expect((await enrolledFleet(history)).machines).toEqual([
            { machine: "laptop-a", mode: "mirror", machineId: "m-laptop-a-0001", environment: "native" },
            { machine: "laptop-b", mode: "sync", machineId: "m-laptop-b-0001", environment: "wsl:Arch" },
        ]);
        // A token nobody holds files nothing and stamps nothing.
        expect(await recordDeviceReport(history, "ist_nobody", { ...report, machineId: "m-intruder-00001" })).toBe(false);
        expect((await enrolledFleet(history)).machines.map((row) => row.machineId)).toEqual(["m-laptop-a-0001", "m-laptop-b-0001"]);
    });
});
