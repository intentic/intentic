import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairings } from "../../peers/enrollment.js";
import {
    deviceReports,
    ENROLLMENT_RETENTION_MS,
    enrolledFleet,
    enrollSyncKey,
    keyMaterialOf,
    revokeSyncEnrollmentsOf,
    withoutStale,
    isFileSyncEnrolled,
    isKeyEnrolled,
    recordDeviceReport,
    restoreAuthorizedKeys,
    revokeEnrollmentByMachine,
    revokeEnrollmentByToken,
    subscribeDeviceReports,
    syncPairBurns,
    type SyncMode,
    verifySyncToken,
} from "../desktop-sync.js";

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
        await enrollSyncKey({
            historyRoot: history,
            key: key("laptop-a"),
            mode: "mirror",
            takeover: false,
            machineId: "m-laptop-a-0001",
            environment: "native",
        });
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

    // What a projects host attaches folders from (bootstrap/projects-host.ts): only a report its enrollment's token vouched
    // for, and nothing once the listener is gone.
    it("tells its listeners of each report a token vouched for, and of no other", async () => {
        const holder = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const report = {
            hostname: "laptop-a",
            os: "linux",
            pairings: [{ sandboxId: "sandbox-abc", mode: "sync" as const, localDir: "/home/ada/blog", remoteDir: "/work/blog" }],
            ports: [],
            agent: { running: true },
            capturedAt: 1,
        };
        const heard: unknown[] = [];
        const stop = subscribeDeviceReports((received) => {
            heard.push(received);
        });

        expect(await recordDeviceReport(history, "ist_nobody", report)).toBe(false);
        expect(heard).toEqual([]);
        expect(await recordDeviceReport(history, holder, report)).toBe(true);
        expect(heard).toEqual([report]);

        stop();
        await recordDeviceReport(history, holder, report);
        expect(heard).toHaveLength(1);
    });

    // The machine agent starts copying a newly attached folder once a report naming it is answered, so the answer waits
    // for what the report set in motion: the folder's repo stands before its first file does.
    it("answers a report only once its listeners have settled", async () => {
        const holder = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: false }));
        const report = { hostname: "laptop-b", os: "linux", pairings: [], ports: [], agent: { running: true }, capturedAt: 1 };
        const order: string[] = [];
        const stop = subscribeDeviceReports(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push("attached");
        });
        await recordDeviceReport(history, holder, report);
        order.push("answered");
        stop();
        expect(order).toEqual(["attached", "answered"]);
    });
});

// (2026-10-05) THE TWO SIDES OF ONE PC, AND THE KEYS NOBODY USES ANY MORE. A Windows PC's Windows side and its WSL
// distro each enroll a key of their own, and WSL hands the distro the PC's hostname, so both arrived under one name: their
// reports overwrote each other and revoking one by name revoked both. And `seenAt` was never read, so every key a machine
// ever enrolled stayed authorized for good.
describe("enrollments of one PC's environments, and their retention", () => {
    let history: string;
    beforeEach(() => {
        history = mkdtempSync(join(tmpdir(), "sync-history-"));
        process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-enroll-"));
    });

    // Two keys of one computer, both named by its hostname, as every agent before `<hostname>-<environment>` named them.
    const windowsKey = "ssh-ed25519 AAAAwindowsside ROG";
    const wslKey = "ssh-ed25519 AAAAwslside ROG";
    const enrolled = async (result: Awaited<ReturnType<typeof enrollSyncKey>>): Promise<string> => {
        if ("locked" in result) {
            throw new Error(`expected a token, got locked by ${result.locked}`);
        }
        return result.syncToken;
    };
    const report = (machineId: string | undefined, distro: string | undefined, folder: string) => ({
        ...(machineId === undefined ? {} : { machineId }),
        hostname: "ROG",
        os: "linux",
        ...(distro === undefined ? {} : { wsl: { distro } }),
        pairings: [{ sandboxId: "sandbox-abc", mode: "sync" as const, localDir: folder }],
        ports: [],
        agent: { running: true },
        capturedAt: 1,
    });

    it("tells two environments of one PC apart by name once each says which it is, and keeps a report for each", async () => {
        const windows = await enrolled(
            await enrollSyncKey({
                historyRoot: history,
                key: windowsKey,
                mode: "sync",
                takeover: false,
                machineId: "m-rog-0001",
                environment: "native",
            }),
        );
        const wsl = await enrolled(
            await enrollSyncKey({
                historyRoot: history,
                key: wslKey,
                mode: "mirror",
                takeover: false,
                machineId: "m-rog-0001",
                environment: "wsl:Ubuntu",
            }),
        );
        // The native side keeps the hostname (setup's own card is placed by it); the distro takes its name after it.
        expect((await enrolledFleet(history)).machines.map((row) => row.machine)).toEqual(["ROG", "ROG-Ubuntu"]);

        await recordDeviceReport(history, windows, report("m-rog-0001", undefined, "C:\\code"));
        await recordDeviceReport(history, wsl, report("m-rog-0001", "Ubuntu", "/home/ada/code"));
        const filed = await deviceReports(history);
        expect(filed.map((entry) => [entry.machine, entry.report.pairings[0]?.localDir]).toSorted()).toEqual([
            ["ROG", "C:\\code"],
            ["ROG-Ubuntu", "/home/ada/code"],
        ]);

        // Revoking one by the name its row shows leaves the other enrolled and syncing.
        expect(await revokeEnrollmentByMachine(history, "ROG-Ubuntu")).toBe(true);
        expect(await verifySyncToken(history, windows, true)).toEqual({ kind: "enrolled", id: "ROG", card: "ROG" });
        expect(await verifySyncToken(history, wsl, true)).toEqual({ kind: "unknown" });
    });

    it("sorts out two enrollments made before either could say, once their reports say which environment each is", async () => {
        const windows = await enrolled(await enrollSyncKey({ historyRoot: history, key: windowsKey, mode: "sync", takeover: false }));
        const wsl = await enrolled(await enrollSyncKey({ historyRoot: history, key: wslKey, mode: "mirror", takeover: false }));
        expect((await enrolledFleet(history)).machines.map((row) => row.machine)).toEqual(["ROG", "ROG"]);
        // Each one's report is its own even while they share a name: filed under the key, not the name.
        await recordDeviceReport(history, windows, report(undefined, undefined, "C:\\code"));
        await recordDeviceReport(history, wsl, report(undefined, undefined, "/home/ada/code"));
        expect((await deviceReports(history)).map((entry) => entry.report.pairings[0]?.localDir).toSorted()).toEqual(["/home/ada/code", "C:\\code"]);

        await recordDeviceReport(history, wsl, report("m-rog-0001", "Ubuntu", "/home/ada/code"));
        await recordDeviceReport(history, windows, report("m-rog-0001", undefined, "C:\\code"));
        expect((await enrolledFleet(history)).machines.map((row) => row.machine)).toEqual(["ROG", "ROG-Ubuntu"]);
    });

    it("reads a key enrolled again under another comment, or the same install under a new key, as the same enrollment", async () => {
        await enrollSyncKey({ historyRoot: history, key: windowsKey, mode: "sync", takeover: false });
        // The same key named `<hostname>-<environment>`, as a new agent names it: not a second machine holding sync.
        await enrolled(await enrollSyncKey({ historyRoot: history, key: `${keyMaterialOf(windowsKey)} ROG-windows`, mode: "sync", takeover: false }));
        expect((await enrolledFleet(history)).machines.map((row) => row.machine)).toEqual(["ROG-windows"]);

        // A side that made itself a new key replaces its own record rather than being locked out by it.
        await enrollSyncKey({
            historyRoot: history,
            key: "ssh-ed25519 AAAAone laptop",
            mode: "mirror",
            takeover: false,
            machineId: "m-laptop-0001",
            environment: "native",
        });
        await enrolled(
            await enrollSyncKey({
                historyRoot: history,
                key: "ssh-ed25519 AAAAtwo laptop",
                mode: "mirror",
                takeover: false,
                machineId: "m-laptop-0001",
                environment: "native",
            }),
        );
        expect((await enrolledFleet(history)).machines.map((row) => row.machine)).toEqual(["ROG-windows", "laptop"]);
        const authorized = await readFile(join(process.env["HOME"] ?? "", ".ssh", "authorized_keys"), "utf8");
        expect(authorized).not.toContain("AAAAone");
        expect(authorized).toContain("AAAAtwo");
    });

    it("revokes the sync keys of exactly the installs a removed card held, and no enrollment that never said which it is", async () => {
        await enrollSyncKey({ historyRoot: history, key: windowsKey, mode: "sync", takeover: false, machineId: "m-rog-0001", environment: "native" });
        await enrollSyncKey({
            historyRoot: history,
            key: wslKey,
            mode: "mirror",
            takeover: false,
            machineId: "m-rog-0001",
            environment: "wsl:Ubuntu",
        });
        await enrollSyncKey({
            historyRoot: history,
            key: "ssh-ed25519 AAAAomen omen",
            mode: "mirror",
            takeover: false,
            machineId: "m-omen-0001",
            environment: "native",
        });
        await enrollSyncKey({ historyRoot: history, key: "ssh-ed25519 AAAAold ROG", mode: "mirror", takeover: false });

        expect(
            await revokeSyncEnrollmentsOf(history, [
                { machineId: "m-rog-0001", environment: "native" },
                { machineId: "m-rog-0001", environment: "wsl:Ubuntu" },
            ]),
        ).toBe(2);
        expect((await enrolledFleet(history)).machines.map((row) => row.machine).toSorted()).toEqual(["ROG", "omen"]);
        expect(await revokeSyncEnrollmentsOf(history, [])).toBe(0);
    });

    it("keeps an enrollment for ninety days since it was last seen, and rebuilds authorized_keys without the ones past it", async () => {
        const now = Date.now();
        const seen = await enrolled(await enrollSyncKey({ historyRoot: history, key: windowsKey, mode: "sync", takeover: false }));
        await enrollSyncKey({ historyRoot: history, key: "ssh-ed25519 AAAAgone gone", mode: "mirror", takeover: false });
        expect(await verifySyncToken(history, seen, true)).toEqual({ kind: "enrolled", id: "ROG", card: "ROG" });

        // A boot a day short of the window keeps both; the never-seen one counts from when it was made.
        await restoreAuthorizedKeys(history, now + ENROLLMENT_RETENTION_MS - 24 * 60 * 60_000);
        expect((await enrolledFleet(history)).machines.map((row) => row.machine)).toEqual(["ROG", "gone"]);

        // Past it, both go, and sshd's file with them.
        await restoreAuthorizedKeys(history, now + ENROLLMENT_RETENTION_MS + 60_000);
        expect((await enrolledFleet(history)).machines).toEqual([]);
        expect(await readFile(join(process.env["HOME"] ?? "", ".ssh", "authorized_keys"), "utf8")).toBe("");
    });

    it("counts retention from the last time an enrollment was seen, else from when it was made", () => {
        const base = { tokenDigest: "x", mode: "mirror" as const, machine: "m" };
        const enrollments = [
            { ...base, key: "a", enrolledAt: 0, seenAt: 50 * 24 * 60 * 60_000 },
            { ...base, key: "b", enrolledAt: 0 },
            { ...base, key: "c", enrolledAt: 10 * 24 * 60 * 60_000 },
        ];
        expect(withoutStale(enrollments, ENROLLMENT_RETENTION_MS + 1).map((entry) => entry.key)).toEqual(["a", "c"]);
        expect(withoutStale(enrollments, 140 * 24 * 60 * 60_000 + 1).map((entry) => entry.key)).toEqual([]);
    });
});
