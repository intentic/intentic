import { DEV_VERSION, type DevicePairing, type DeviceReport, AGENT_STALL_AFTER_MS, HostScopesSchema } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLine, buildSkewLine, conflictLines, linkLine, pairingLine, statusSummary } from "../status.js";
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

    // The sync token IS the enrollment: it authorizes the port read, the machine report and the SSH transport. A
    // daemon that enrolls the key and hands back nothing to use it with fails here rather than as a Mutagen session
    // that silently never comes up.
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

// Which sandbox a command acts on. With a fleet on one machine, a real id is `sandbox-<hex>-<zone>`-shaped, so
// a human names it by the fragment they recognize; an ambiguous or unknown fragment must refuse rather than guess.
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

// The status lines, pinned as sentences: this is the one output a user reads to find out whether their machine
// is doing what they think, and each assertion below is a way it has actually lied.
describe("pairingLine", () => {
    const synced = (overrides: Partial<DevicePairing> = {}): DevicePairing => ({
        sandboxId: "sandbox-0738cd6b5027-intentic-dev",
        mode: "sync",
        localDir: "/home/me/intentic/work",
        mutagenStatus: "watching",
        // A healthy pairing runs BOTH sessions, so the default fixture has both: otherwise every assertion below would
        // read a line already shouting about a missing backup.
        backupStatus: "watching",
        ...overrides,
    });

    // Mutagen omits an empty conflict list, so `conflicts` is absent on every healthy session; every well-behaved
    // sync used to interpolate it as "undefined conflict(s)".
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

    // The backup has its own word and its own shout: the workspace session going quiet is noticed within minutes,
    // the state backup going quiet costs nothing until the sandbox is gone and nothing was ever copied here.
    it("shouts when the state backup is not running, even though the folder syncs fine", () => {
        const line = pairingLine(synced({ backupStatus: undefined }));
        expect(line).toContain("watching");
        expect(line).toContain("backup");
        expect(line).not.toContain("backup watching");
    });

    it("names the backup's own status when it has one of its own", () => {
        expect(pairingLine(synced({ backupStatus: "halted-on-root-emptied" }))).toContain("backup halted-on-root-emptied");
    });

    // The failure this line exists for: a pairing whose session was never created has no status, and an empty
    // bracket put "not syncing at all" one space from "fine".
    it("shouts when a sync pairing has no session at all", () => {
        const withoutSession = pairingLine(synced({ mutagenStatus: undefined }));
        const withSession = pairingLine(synced());
        expect(withoutSession).not.toBe(withSession);
        expect(withoutSession).toContain("NO FILE-SYNC SESSION");
    });

    it("says paused when it is paused, over whatever Mutagen last reported", () => {
        expect(pairingLine(synced({ paused: true }))).toContain("[paused]");
    });

    // A mirror-only enrollment has no file sync to have an opinion about, so the absent status is a fact about the
    // mode, not a missing session.
    it("leaves a ports-only enrollment alone", () => {
        expect(pairingLine({ sandboxId: "friend", mode: "mirror" })).toBe("  friend  (ports only)");
    });

    // Mirroring off is said on the line, since the only other evidence is an empty port list, which is also what a
    // sandbox serving nothing looks like.
    it("says so when this device's port mirroring is switched off", () => {
        const line = pairingLine(synced({ mirroring: "off" }));
        expect(line).toContain("port mirroring OFF");
        expect(line).toContain("watching");
    });

    it("says it on a ports-only enrollment too, where it is the whole of what that pairing does", () => {
        expect(pairingLine({ sandboxId: "friend", mode: "mirror", mirroring: "off" })).toBe("  friend  (ports only)  [port mirroring OFF]");
    });

    // Absent means on: an agent reports the field only once it has the switch, and mirroring has always been on.
    it("stays silent when mirroring is on", () => {
        expect(pairingLine(synced({ mirroring: "on" }))).not.toContain("mirroring");
    });
});

// A pid is not a pulse. The agent keeps its own tunnel listeners on the event loop, so a rejection that escapes
// it leaves the process alive with mirroring, the git bridge and file sync all stopped.
describe("agentLine", () => {
    const NOW = 1_700_000_000_000;

    it("reports a stalled agent as stalled, even though the process is alive", () => {
        const pid = 4242;
        const stalledMs = AGENT_STALL_AFTER_MS + 60_000;
        const line = agentLine({ running: true, pid, lastTickAt: NOW - stalledMs }, NOW);
        expect(line).toContain(`pid ${pid}`);
        expect(line).toContain("STALLED");
        expect(line).toContain(String(Math.round(stalledMs / 60_000)));
        expect(line).toContain("intentic-machine run");
    });

    it("reports a ticking agent as running, with how fresh the last pass is", () => {
        const pid = 4242;
        const sinceMs = 7000;
        const line = agentLine({ running: true, pid, lastTickAt: NOW - sinceMs }, NOW);
        expect(line).toContain(`pid ${pid}`);
        expect(line).toContain(`${Math.round(sinceMs / 1000)}s ago`);
    });

    // Neither a stall nor a clean bill of health: an agent too old to stamp, or one whose first pass hasn't landed.
    // Saying which is the point, since picking either lets a silent stall read as green.
    it("says so when no pass has been reported yet, rather than assuming either way", () => {
        const pid = 4242;
        const withoutTick = agentLine({ running: true, pid }, NOW);
        const withTick = agentLine({ running: true, pid, lastTickAt: NOW - 7000 }, NOW);
        expect(withoutTick).toContain(`pid ${pid}`);
        expect(withoutTick).not.toBe(withTick);
        expect(withoutTick).toContain("no completed sync pass");
    });

    it("tells a stopped agent's reader that file sync stopped with it", () => {
        const stopped = agentLine({ running: false }, NOW);
        const running = agentLine({ running: true, pid: 4242, lastTickAt: NOW - 7000 }, NOW);
        expect(stopped).not.toBe(running);
        expect(stopped).toContain("NOT running");
    });
});

// The machine is updated and still serving the old agent, which this output had no way to say: the version on
// its first line is the FILE's, and the loop keeps whatever build it started with.
describe("buildSkewLine and the status summary", () => {
    const NOW = 1_700_000_000_000;
    const report = (agent: Omit<DeviceReport["agent"], "installed">, installed: string | undefined): DeviceReport => ({
        hostname: "radarsu-rog",
        os: "linux",
        sandboxes: [],
        pairings: [{ sandboxId: "work", mode: "sync", localDir: "/home/me/work", mirroring: "on" }],
        ports: [],
        agent: { ...agent, ...(installed === undefined ? {} : { installed }) },
        capturedAt: NOW,
    });
    const serving = { running: true, pid: 4242, build: "1.233.0", lastTickAt: NOW - 5000 };

    it("names both builds and the restart that closes the gap", () => {
        const line = buildSkewLine(report(serving, "1.240.0"));
        expect(line).toContain("1.233.0");
        expect(line).toContain("1.240.0");
        expect(line).toContain("intentic-machine run --stop");
    });

    it("says nothing when the loop is already on the installed build", () => {
        expect(buildSkewLine(report({ ...serving, build: "1.240.0" }, "1.240.0"))).toBeUndefined();
    });

    // An unstamped loop is the loudest case, not a missing one: the loop stamps its build into the pidfile it
    // claims, so one reporting none predates the stamp and is further behind than any build it could have named.
    it("names the machines too far behind to say which build they are on", () => {
        const unstamped = report({ running: true, pid: 4242 }, "1.240.0");
        const line = buildSkewLine(unstamped);
        expect(line).toContain("1.240.0");
        expect(line).toContain("intentic-machine run --stop");
        expect(statusSummary(4242, 0, unstamped, NOW)).toContain("OLD BUILD RUNNING");
    });

    // Silence is kept for the two kinds of genuinely not knowing: no installed agent to compare against, and a
    // working-tree build, which is not a version at all.
    it("says nothing when there is no release to be behind", () => {
        expect(buildSkewLine(report(serving, undefined))).toBeUndefined();
        expect(buildSkewLine(report({ running: true, pid: 4242 }, DEV_VERSION))).toBeUndefined();
    });

    // A stopped loop is not serving an old build, it is not serving anything, and the line above it says so louder.
    it("says nothing about a loop that is not running", () => {
        expect(buildSkewLine(report({ running: false, build: "1.233.0" }, "1.240.0"))).toBeUndefined();
    });

    // The tray reads the summary and nothing else, so the skew has to reach that one line too.
    it("ranks the skew above a healthy line and below the two failures", () => {
        const skewed = report(serving, "1.240.0");
        expect(statusSummary(4242, 0, skewed, NOW)).toContain("OLD BUILD RUNNING");
        expect(statusSummary(4242, 0, report({ ...serving, build: "1.240.0" }, "1.240.0"), NOW)).not.toContain("OLD BUILD");
        // A stalled loop outranks it: nothing is being served at all, whichever build is doing the not-serving.
        expect(statusSummary(4242, 0, report({ ...serving, lastTickAt: NOW - AGENT_STALL_AFTER_MS - 60_000 }, "1.240.0"), NOW)).toContain("STALLED");
        expect(statusSummary(undefined, 0, skewed, NOW)).toContain("NOT RUNNING");
    });
});

/* THE WORD THIS COMMAND USED TO GIVE AWAY. Its whole job is to answer "is my machine connected", and it
 * answered it from the link list on disk, which records what the machine is MEANT to reach. A sandbox whose host
 * had been returning 502 for four hours, with the agent retrying it every 30 seconds, printed the same line as a
 * healthy one. */
describe("linkLine", () => {
    // Scopes are beside the point for this line and are taken from the schema's own defaults rather than written
    // out here, so a scope added later can't break a test that never looks at one.
    const link = { sandboxUrl: "https://sandbox-0738cd6b5027.example.dev", id: "radarsu-omen", scopes: HostScopesSchema.parse({}) } as const;

    it("says connected only for a socket that is open", () => {
        expect(linkLine({ ...link, state: "open" })).toContain("connected as radarsu-omen");
        expect(linkLine({ ...link, state: "open" })).not.toContain("NOT connected");
    });

    it("says NOT connected for a link that is down, and whether anything is still trying", () => {
        expect(linkLine({ ...link, state: "connecting" })).toContain("NOT connected (retrying)");
        expect(linkLine({ ...link, state: "closed" })).toContain("NOT connected as radarsu-omen");
        expect(linkLine({ ...link, state: "closed" })).not.toContain("retrying");
    });

    // An agent too old to stamp its links is the case this line must not paper over: no answer is not a yes, and
    // the reader is told which they have rather than being handed the reassuring one.
    it("says it does not know when the running agent cannot say", () => {
        const unknown = linkLine(link);
        expect(unknown).toContain("radarsu-omen");
        expect(unknown).not.toContain("connected as");
        expect(unknown).toContain("doesn't report");
    });
});

// The tray reads the summary and nothing else, so a link that is down has to reach that one line too.
describe("the summary's link count", () => {
    const NOW = 1_700_000_000_000;
    const quiet: DeviceReport = {
        hostname: "radarsu-omen",
        os: "win32",
        sandboxes: [],
        pairings: [],
        ports: [],
        agent: { running: true, pid: 4242 },
        capturedAt: NOW,
    };

    it("counts the links that are connected, not the ones that are configured", () => {
        expect(statusSummary(4242, 2, quiet, NOW, 1)).toContain("1 of 2 sandboxes connected");
        expect(statusSummary(4242, 2, quiet, NOW, 0)).toContain("0 of 2 sandboxes connected");
        expect(statusSummary(4242, 2, quiet, NOW, 2)).toContain("2 sandboxes connected");
    });

    // An agent that cannot report its links keeps the sentence it always printed: the count is unknown, not zero.
    it("keeps the old wording when nothing knows", () => {
        expect(statusSummary(4242, 2, quiet, NOW)).toContain("2 sandboxes connected");
    });
});

// The paths under the count, on the one output that has ever printed the word "conflict": the count was the
// whole message, but the paths are the only part anybody can act on.
describe("conflictLines", () => {
    const stuck = (overrides: Partial<DevicePairing> = {}): DevicePairing => ({
        sandboxId: "sandbox-0738cd6b5027-intentic-dev",
        mode: "sync",
        localDir: "/home/me/intentic/work",
        mutagenStatus: "watching",
        backupStatus: "watching",
        ...overrides,
    });

    it("says nothing at all about a pairing that has none, so a healthy machine prints what it always did", () => {
        expect(conflictLines(stuck())).toEqual([]);
        expect(conflictLines(stuck({ conflicts: 0, conflictedPaths: [] }))).toEqual([]);
    });

    it("names each stuck path and what happened to it on each side", () => {
        const lines = conflictLines(
            stuck({
                conflicts: 2,
                conflictedPaths: [
                    { path: "src/app.ts", local: "modified", sandbox: "modified" },
                    { path: "docs/notes.md", local: "deleted", sandbox: "modified" },
                ],
            }),
        ).join("\n");
        expect(lines).toContain("src/app.ts");
        expect(lines).toContain("changed here, changed in the sandbox");
        expect(lines).toContain("deleted here, changed in the sandbox");
        // And what ends it, which is the sentence the count could never carry.
        expect(lines).toContain("making both copies the same");
    });

    // The remainder is counted against the pairing's OWN total, since two caps sit between Mutagen and this line:
    // what Mutagen reports and what the report carries.
    it("counts what it is not showing against the machine's own total", () => {
        const conflictedPaths = Array.from({ length: 12 }, (_, at) => ({ path: `f-${at}.ts` }));
        const lines = conflictLines(stuck({ conflicts: 40, conflictedPaths }));
        expect(lines.join("\n")).toContain("… and 32 more");
        // Eight paths, plus the sentence over them, the tail, and the remedy under them.
        expect(lines).toHaveLength(11);
    });

    it("says in words the one conflict that has no path: the folder itself", () => {
        expect(conflictLines(stuck({ conflicts: 1, conflictedPaths: [{ path: "" }] })).join("\n")).toContain("(the folder itself)");
    });
});
