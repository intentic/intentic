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

/* THE TWO QUESTIONS THIS SUITE ASKS OF THE STORE, as local projections over the one list it publishes.
 *
 * They used to be exported functions (`syncHolder`, `mirrorMachines`) because a card downstream needed exactly
 * those two shapes: one machine holding file sync, and the names of everybody else. That card is gone — desktop
 * sync is per DEVICE now, so the daemon publishes the enrollment list itself and each row picks its own facts
 * out of it. What the two shapes assert about the STORE is unchanged and worth keeping, so they live here, where
 * the last thing that wanted them is. */
const holderOf = async (historyRoot: string): Promise<{ machine: string; seenAt?: number } | undefined> => {
    const held = (await enrolledFleet(historyRoot)).machines.find((entry) => entry.mode === "sync");
    // Narrowed to the two fields these assertions are about; `mode` is the thing that was just selected on.
    return held === undefined ? undefined : { machine: held.machine, ...(held.seenAt === undefined ? {} : { seenAt: held.seenAt }) };
};
const mirrorsOf = async (historyRoot: string): Promise<string[]> =>
    (await enrolledFleet(historyRoot)).machines.filter((entry) => entry.mode === "mirror").map((entry) => entry.machine);

/* The pairing token is the whole auth for desktop enrollment, so lock down its guarantees: single-use,
 * time-limited, and mode-carrying (the enroll trusts the pairing's mode, not the agent).
 *
 * The mechanic is store/enrollment.ts's now, and its own suite covers it in general. What is pinned here is
 * THIS door's use of it: that the payload a sync pairing carries is the mode, and that the setup-time token
 * from the container's env is the replayable one. */
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

    /* The SETUP-TIME token is the one that needed a burn list. It arrives in the container's environment, which
     * survives every restart and is replayed into every rebuild, so re-arming it on boot made a leaked env a
     * permanent key to /system/authorized-key, a route with no bearer check in front of it. Once redeemed it
     * must stay dead no matter how many times the daemon comes back up. */
    it("arms the setup-time token once and never re-arms it after redemption", async () => {
        const { pending, historyRoot } = table();
        const token = "setup-time-token";

        expect(await pending.arm(token, "sync")).toBe(true);
        expect(pending.peek(token)).toBe("sync"); // the owner's own token, full file sync, not mirror-only

        await pending.consume(token);
        expect(pending.peek(token)).toBeUndefined();

        // The restart, for real: same env, same token, a brand-new table with an empty map. The burn is on
        // /history, which outlives the container, so it holds.
        const rebooted = pairings<SyncMode>(syncPairBurnPath(historyRoot));
        expect(await rebooted.arm(token, "sync")).toBe(false);
        expect(rebooted.peek(token)).toBeUndefined();
    });

    // Re-running setup is the supported way back in: /setup/claim mints a NEW token per claim, and a digest
    // nobody has burned still arms. Only replay of a spent token is refused.
    it("still arms a freshly minted setup token after an earlier one was spent", async () => {
        const { pending } = table();
        await pending.arm("first-claim", "sync");
        await pending.consume("first-claim");

        expect(await pending.arm("second-claim", "sync")).toBe(true);
        expect(pending.peek("second-claim")).toBe("sync");
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

    it("port mirroring is unlimited: many machines enroll and each token is valid", async () => {
        const a = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "mirror", takeover: false }));
        const b = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        const c = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-c"), mode: "mirror", takeover: false }));
        expect(await verifySyncToken(history, a, true)).toBe(true);
        expect(await verifySyncToken(history, b, true)).toBe(true);
        expect(await verifySyncToken(history, c, true)).toBe(true);
        expect((await mirrorsOf(history)).toSorted()).toEqual(["laptop-a", "laptop-b", "laptop-c"]);
        // authorized_keys carries every machine's key: sshd authorizes all three forwarders.
        const authKeys = await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8");
        expect(authKeys.trim().split("\n")).toHaveLength(3);
        // No file-sync holder: these are mirror-only.
        expect(await holderOf(history)).toBeUndefined();
    });

    it("file sync is single-holder: a second sync enroll is refused, a takeover replaces it", async () => {
        const first = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        // A DIFFERENT machine can't grab sync without takeover.
        expect(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: false })).toEqual({ locked: "laptop-a" });
        expect((await holderOf(history))?.machine).toBe("laptop-a");
        // Takeover moves it, and kills the old holder's token.
        const second = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "sync", takeover: true }));
        expect((await holderOf(history))?.machine).toBe("laptop-b");
        expect(await verifySyncToken(history, first, true)).toBe(false);
        expect(await verifySyncToken(history, second, true)).toBe(true);
    });

    it("mirror enrollments survive a sync takeover: collaborators keep their previews", async () => {
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false });
        // A sync takeover only displaces the sync holder; the mirror-only machine is untouched.
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
        expect(await mirrorsOf(history)).toEqual(["laptop-a"]); // still one machine, not duplicated
    });

    // The rebuild case, which is what a "sync stopped working after I rebuilt" report actually is. A recreate
    // keeps only the volumes: the store on /history survives, the container filesystem (and with it the
    // authorized_keys sshd reads) does not. Both halves matter: the tokens must still verify AND sshd must
    // authorize the same keys again, so simulate it by pointing HOME at a fresh dir and re-deriving.
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

    // A sandbox nobody has ever enrolled on must still land an empty file, so sshd reads "no one is authorized"
    // rather than falling back to whatever a previous life left behind.
    it("restores an empty authorized_keys when no one is enrolled", async () => {
        await restoreAuthorizedKeys(history);
        expect(await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).toBe("");
    });

    /* The heartbeat. A verification is the agent's ports poll arriving, and it is the ONLY thing a live desktop
     * sync does on its own, so if it doesn't record "this machine is still here", nothing does, and an enrollment
     * reads as active sync from the moment it is made until someone revokes it. That is what let the card claim
     * "Syncing from <machine>" for a folder that had silently stopped syncing days earlier. */
    it("stamps seenAt when a machine uses its enrollment, and never before", async () => {
        await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false });
        // Enrolled but never polled: no seenAt at all, which the UI reads as "setup didn't finish", not as healthy.
        expect(await holderOf(history)).toEqual({ machine: "laptop-a" });

        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const before = Date.now();
        expect(await verifySyncToken(history, holderToken, true)).toBe(true);

        /* Bounded on BOTH sides, because "there is a number here" would pass for a stamp left over from
         * enrolment; what is being asserted is that the stamp came from THIS poll.
         *
         * SLACK ON EACH SIDE, because `Date.now()` is the WALL clock and the wall clock is not monotonic. The
         * value under test is one `Date.now()` read inside verifySyncToken (sync.ts) and the bound is another
         * read here a moment later, so a host that slews its clock backwards between the two — which is what
         * ntp does under load, and this suite runs 60-odd files at once — makes the later read the SMALLER
         * number and fails a stamp that is perfectly correct. It did: `1787657817269` against a ceiling of
         * `1787657817267`, two milliseconds of skew. The window is still far tighter than anything this test
         * could confuse the stamp with: enrolment is the only other candidate and it is the same millisecond,
         * so what a bug would have to do to slip through is stamp within 50ms of now, which is stamping now. */
        const CLOCK_SKEW_MS = 50;
        const seen = (await holderOf(history))?.seenAt;
        expect(seen).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);
        expect(seen).toBeLessThanOrEqual(Date.now() + CLOCK_SKEW_MS);
    });

    /* THE TRANSPORT IS NOT A CHECK-IN, and this is the assertion that keeps the card honest. Mutagen's daemon
     * opens and reopens the SSH stream on its own schedule, so its traffic proves only that Mutagen is running:
     * not that the watcher polling on top of it is. Stamping on it produced the exact failure the heartbeat was
     * built to prevent, one layer down: a watcher whose loop had died, port mirroring and the git bridge stopped,
     * and a card reading "Syncing from <machine>, just now" the whole time. */
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

    // The agent polls every 5s per pairing; persisting each one would be a disk write every 5s per machine forever.
    // Throttled, so a burst of polls costs one write, and the stamp stays within a minute of the last poll.
    it("throttles the stamp rather than writing on every poll", async () => {
        const holderToken = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        await verifySyncToken(history, holderToken, true);
        const first = (await holderOf(history))?.seenAt;

        await verifySyncToken(history, holderToken, true);
        await verifySyncToken(history, holderToken, true);

        expect((await holderOf(history))?.seenAt).toBe(first);
    });

    // A mirror-only machine's poll verifies too. It must not turn into a file-sync holder on the way through.
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
        expect(await verifySyncToken(history, b, true)).toBe(true); // b unaffected
        expect(await revokeEnrollmentByToken(history, "ist_never-enrolled")).toBe(false);
    });

    /* THE OWNER'S REVOKE, AND THE WHOLE POINT OF IT BEING PER MACHINE. What this replaced cleared the entire
     * store, because it sat under a card that treated desktop sync as one property of the sandbox: "I don't use
     * that laptop any more" cost every other device its access, mirror-only collaborators included. */
    it("the owner's revoke takes one machine and leaves the rest syncing", async () => {
        const holder = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-a"), mode: "sync", takeover: false }));
        const mirror = await token(await enrollSyncKey({ historyRoot: history, key: key("laptop-b"), mode: "mirror", takeover: false }));

        expect(await revokeEnrollmentByMachine(history, "laptop-b")).toBe(true);
        expect(await verifySyncToken(history, mirror, true)).toBe(false);
        // The file-sync holder is untouched, and still the holder.
        expect(await verifySyncToken(history, holder, true)).toBe(true);
        expect((await holderOf(history))?.machine).toBe("laptop-a");
        // sshd's view moves with the store: the revoked machine's key is gone from authorized_keys.
        expect((await readFile(join(process.env["HOME"]!, ".ssh", "authorized_keys"), "utf8")).trim().split("\n")).toEqual([key("laptop-a")]);

        // A name nobody is enrolled under is a 404's worth of "no", not a silent success.
        expect(await revokeEnrollmentByMachine(history, "laptop-b")).toBe(false);
        expect(await revokeEnrollmentByMachine(history, "never-paired")).toBe(false);

        // And revoking the last one leaves the store readable as "nobody is enrolled".
        expect(await revokeEnrollmentByMachine(history, "laptop-a")).toBe(true);
        expect(await isKeyEnrolled(history)).toBe(false);
    });
});
