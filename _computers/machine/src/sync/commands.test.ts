import { type MachinePairing, WATCHER_STALL_AFTER_MS } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairingLine, watcherLine } from "../status.js";
import { enrollKey, selectPairings } from "./commands.js";
import type { Pairing, SyncState } from "./config.js";

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("enrollKey", () => {
    it("retries through transient tunnel-warmup 502s, then returns the sync token + granted mode", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
            .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
            .mockResolvedValueOnce(jsonResponse(200, { ok: true, syncToken: "ist_tok", mode: "mirror" }));
        vi.stubGlobal("fetch", fetchMock);

        const enrolled = await enrollKey("https://sandbox-abc.example.dev/", "pair-token", "ssh-ed25519 AAAA", { delayMs: 0 });

        expect(enrolled).toEqual({ syncToken: "ist_tok", mode: "mirror" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries when fetch throws, and defaults mode to sync for a daemon that omits it", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"))
            .mockResolvedValueOnce(jsonResponse(200, { syncToken: "ist_tok" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { delayMs: 0 })).resolves.toEqual({
            syncToken: "ist_tok",
            mode: "sync",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    /* The sync token IS the enrollment: it authorizes the port read, the machine report and the SSH transport
     * this agent listens for locally. A daemon that enrolls the key and hands back nothing to use it with has
     * produced a pairing that can never connect, so that fails at setup rather than as a Mutagen session which
     * silently never comes up. */
    it("refuses an enrollment that comes back without a credential", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { ok: true, mode: "sync" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { delayMs: 0 })).rejects.toThrow(/no sync credential/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails fast on 401 without retrying", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 401 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { delayMs: 0 })).rejects.toThrow(/pairing expired/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws the same 502 message when warmup never resolves", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(enrollKey("https://sandbox-abc.example.dev", "pair", "key", { attempts: 3, delayMs: 0 })).rejects.toThrow(
            /enrolling the sync key failed \(502\)/,
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});

/* Which sandbox a command acts on. With a fleet on one machine, `pause`/`resume`/`uninstall` need to name one:
 * and a real id is `sandbox-<hex>-<zone>`-shaped, so a human names it by the fragment they recognize. An ambiguous
 * or unknown fragment must refuse rather than guess: guessing here unpairs the wrong sandbox. */
describe("selectPairings", () => {
    const pairing = (sandboxId: string): Pairing => ({
        sandboxUrl: `https://${sandboxId}/`,
        sandboxId,
        mode: "sync",
    });
    const state: SyncState = {
        pairings: [pairing("sandbox-0738cd6b5027-intentic-dev"), pairing("sandbox-bce57bb9fe3b-intentic-dev")],
    };

    it("selects every pairing when no sandbox is named", () => {
        expect(selectPairings(state, undefined)).toEqual(state.pairings);
    });

    it("selects by full sandbox id", () => {
        expect(selectPairings(state, "sandbox-bce57bb9fe3b-intentic-dev")).toEqual([state.pairings[1]]);
    });

    it("selects by the fragment a human would type", () => {
        expect(selectPairings(state, "0738")).toEqual([state.pairings[0]]);
    });

    it("refuses an ambiguous fragment instead of picking one", () => {
        expect(() => selectPairings(state, "intentic-dev")).toThrow(/matches more than one/);
    });

    it("refuses an unknown fragment, listing what this machine does pair", () => {
        expect(() => selectPairings(state, "nope")).toThrow(/no paired sandbox matches "nope".*0738cd6b5027/s);
    });
});

/* THE STATUS LINES, pinned as sentences. This is the one output a user reads to find out whether their machine is
 * doing what they think it is, and each of these assertions is a way it has actually lied. */
describe("pairingLine", () => {
    const synced = (overrides: Partial<MachinePairing> = {}): MachinePairing => ({
        sandboxId: "sandbox-0738cd6b5027-intentic-dev",
        mode: "sync",
        localDir: "/home/me/intentic/work",
        mutagenStatus: "watching",
        // A healthy pairing runs BOTH sessions, so the default fixture has to have both: otherwise every
        // assertion below would be reading a line that is already shouting about a missing backup.
        backupStatus: "watching",
        ...overrides,
    });

    /* Mutagen omits an empty conflict list, so `conflicts` is absent on every healthy session, and the count was
     * interpolated whenever it wasn't zero. Every well-behaved sync on every machine printed
     * "[watching, undefined conflict(s)]", which reads as a fault on the line whose job is to say there is none. */
    it("says nothing about conflicts when Mutagen reported none", () => {
        const pairing = synced();
        const line = pairingLine(pairing);
        expect(line).toContain(pairing.sandboxId);
        expect(line).toContain(pairing.localDir!);
        expect(line).toContain(pairing.mutagenStatus!);
        expect(line).toContain(pairing.backupStatus!);
        expect(pairingLine(synced({ conflicts: 0 }))).not.toContain("conflict");
    });

    it("prints the count when there IS one, because nothing else in the product ever says so", () => {
        const conflicts = 3;
        expect(pairingLine(synced({ conflicts }))).toContain(String(conflicts));
        expect(pairingLine(synced({ conflicts }))).toContain("conflict");
    });

    /* THE BACKUP HAS ITS OWN WORD, and its own shout. The two sessions fail independently: the workspace one
     * going quiet stops the owner's edits moving and they notice within minutes, while the state backup going
     * quiet costs them nothing at all until the day the sandbox is gone and their personas, skills, automations
     * and transcripts turn out never to have been copied. That is the failure the line has to be loud about. */
    it("shouts when the state backup is not running, even though the folder syncs fine", () => {
        const line = pairingLine(synced({ backupStatus: undefined }));
        expect(line).toContain("watching");
        expect(line).toContain("backup");
        expect(line).not.toContain("backup watching");
    });

    it("names the backup's own status when it has one of its own", () => {
        expect(pairingLine(synced({ backupStatus: "halted-on-root-emptied" }))).toContain("backup halted-on-root-emptied");
    });

    /* The failure this whole line exists for: a pairing whose session was never created has no status, and an
     * empty bracket put "this folder is not syncing at all" one space away from "this folder is fine". */
    it("shouts when a sync pairing has no session at all", () => {
        const withoutSession = pairingLine(synced({ mutagenStatus: undefined }));
        const withSession = pairingLine(synced());
        expect(withoutSession).not.toBe(withSession);
        expect(withoutSession).toContain("NO FILE-SYNC SESSION");
    });

    it("says paused when it is paused, over whatever Mutagen last reported", () => {
        expect(pairingLine(synced({ paused: true }))).toContain("[paused]");
    });

    // A mirror-only enrollment has no file sync to have an opinion about, so the absent status is a fact about
    // the mode: it must not read as a missing session.
    it("leaves a ports-only enrollment alone", () => {
        expect(pairingLine({ sandboxId: "friend", mode: "mirror" })).toBe("  friend  (ports only)");
    });
});

/* A PID IS NOT A PULSE. The watcher keeps its own tunnel listeners on the event loop, so a rejection that escapes
 * the loop leaves the process alive with mirroring, the git bridge and any not-yet-created file sync stopped:
 * observed twice, reported as "running" both times, by this line. */
describe("watcherLine", () => {
    const NOW = 1_700_000_000_000;

    it("reports a stalled watcher as stalled, even though the process is alive", () => {
        const pid = 4242;
        const stalledMs = WATCHER_STALL_AFTER_MS + 60_000;
        const line = watcherLine({ running: true, pid, lastTickAt: NOW - stalledMs }, NOW);
        expect(line).toContain(`pid ${pid}`);
        expect(line).toContain("STALLED");
        expect(line).toContain(String(Math.round(stalledMs / 60_000)));
        expect(line).toContain("intentic-machine run");
    });

    it("reports a ticking watcher as running, with how fresh the last pass is", () => {
        const pid = 4242;
        const sinceMs = 7000;
        const line = watcherLine({ running: true, pid, lastTickAt: NOW - sinceMs }, NOW);
        expect(line).toContain(`pid ${pid}`);
        expect(line).toContain(`${Math.round(sinceMs / 1000)}s ago`);
    });

    // Neither a stall nor a clean bill of health: an agent too old to stamp, or one whose first pass hasn't
    // landed. Saying which is the point: picking either is how a silent stall reads as green.
    it("says so when no pass has been reported yet, rather than assuming either way", () => {
        const pid = 4242;
        const withoutTick = watcherLine({ running: true, pid }, NOW);
        const withTick = watcherLine({ running: true, pid, lastTickAt: NOW - 7000 }, NOW);
        expect(withoutTick).toContain(`pid ${pid}`);
        expect(withoutTick).not.toBe(withTick);
        expect(withoutTick).toContain("no completed sync pass");
    });

    it("tells a stopped watcher's reader that file sync stopped with it", () => {
        const stopped = watcherLine({ running: false }, NOW);
        const running = watcherLine({ running: true, pid: 4242, lastTickAt: NOW - 7000 }, NOW);
        expect(stopped).not.toBe(running);
        expect(stopped).toContain("NOT running");
    });
});
