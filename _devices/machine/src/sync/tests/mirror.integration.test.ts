import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { pidFileBody } from "@intentic/local-agent";
import type { PortSummary } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { stubGlobal } from "@intentic/testing/bun";
import type { MirroredPort, Pairing, SkippedPort } from "../config.js";
import type { ForwardExecutor, LocalHolds } from "../mirror.js";

// config.ts reads homedir() at import time; HOME must point at a throwaway dir before the dynamic import below,
// or machine.pid lands in the real ~/.intentic/machine.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "machine-mirror-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { runPidPath } = await import("../../config.js");
const {
    BUSY_GRACE_MS,
    busyLastPass,
    fetchWorkspacePorts,
    handOver,
    markPrepared,
    othersHolding,
    pollBackoffMs,
    pollDue,
    reconcileForwards,
    recordedForwards,
    retireMirroredPort,
    retirePairingMirror,
    shouldAutoPauseFileSync,
    skippedPortsOf,
    strandedForwards,
    SyncAuthError,
    unpreparedSetups,
} = await import("../mirror.js");
const { readState, upsertPairing } = await import("../config.js");
const { readResidentPid, runForeground, signalExitCode } = await import("../../resident.js");
const { stopResident } = await import("../../supervision.js");
const { forwardSessionName, mutagenForwardArgs } = await import("../mutagen.js");
// setup() creates ~/.intentic/machine on write; the pidfile test writes there directly, so make it first.
await mkdir(dirname(runPidPath), { recursive: true });

it("auto-pauses only after an hour of uninterrupted failure", () => {
    expect(shouldAutoPauseFileSync(60 * 60_000 - 1)).toBe(false);
    expect(shouldAutoPauseFileSync(60 * 60_000)).toBe(true);
});

describe("failing-pairing backoff", () => {
    // Measured in time, not polls: the ladder below stretches the gaps, so a poll count would put the hour hours away.
    it("polls at full rate for the first minute, then slows, and caps at five", () => {
        expect(pollBackoffMs(0)).toBe(0);
        expect(pollBackoffMs(59_999)).toBe(0);
        expect(pollBackoffMs(60_000)).toBe(30_000);
        expect(pollBackoffMs(10 * 60_000)).toBe(5 * 60_000);
        expect(pollBackoffMs(59 * 60 * 60_000)).toBe(5 * 60_000);
    });

    it("owes a healthy pairing a poll every tick, and a long-dead one one every five minutes", () => {
        const now = 10_000_000;
        expect(pollDue(undefined, now)).toBe(true);
        // Failing for two minutes: on the 30s rung, and a tick 5s after the last try is not due.
        expect(pollDue({ since: now - 120_000, lastTried: now - 5_000 }, now)).toBe(false);
        expect(pollDue({ since: now - 120_000, lastTried: now - 31_000 }, now)).toBe(true);
        // Failing for a day: still probed, but not 240 times an hour.
        expect(pollDue({ since: now - 86_400_000, lastTried: now - 60_000 }, now)).toBe(false);
        expect(pollDue({ since: now - 86_400_000, lastTried: now - 5 * 60_001 }, now)).toBe(true);
    });
});

// THE WATCHER IS THE ONLY THING THAT CREATES SESSIONS, so it has to notice every setup, including one made while it
// runs. `setup` used to create the session itself while the agent it had just started prepared the same pairing, and
// a user's PC ended up with two identical sessions for every folder.
describe("unpreparedSetups", () => {
    const pairing = { sandboxUrl: "https://s.example.dev", sandboxId: "sandbox-a", mode: "sync", localDir: "/home/u/a", syncToken: "t1" } as const;

    it("prepares a pairing the watcher has not seen, and never the same setup twice", () => {
        const prepared = new Set<string>();
        expect(unpreparedSetups([pairing], prepared)).toEqual([pairing]);
        markPrepared(prepared, pairing);
        expect(unpreparedSetups([pairing], prepared)).toEqual([]);
        // Re-read every tick with its ports and switches rewritten: still the same setup.
        expect(unpreparedSetups([{ ...pairing, mirrorOff: true, mirroredPorts: [{ port: 5173, host: "127.0.0.1" }] }], prepared)).toEqual([]);
    });

    // Every `setup` mints a new token, so running it again (a takeover, a re-pair after an unpair) or pointing it at
    // another folder is prepared again, and a session left on the old folder gets replaced.
    it("prepares a pairing again once setup ran again or moved its folder", () => {
        const prepared = new Set<string>();
        markPrepared(prepared, pairing);
        const again = { ...pairing, syncToken: "t2" };
        const moved = { ...pairing, localDir: "/home/u/elsewhere" };
        expect(unpreparedSetups([again], prepared)).toEqual([again]);
        expect(unpreparedSetups([moved], prepared)).toEqual([moved]);
    });

    // `sync direction` rewrites only the pairing's direction, and the mode it decides is what the session is recreated for.
    it("prepares a project again once its direction switched, and never a workspace for one", () => {
        const project = { ...pairing, remoteDir: `${WORKSPACE_ROOT}/a`, project: true } as const;
        const prepared = new Set<string>();
        markPrepared(prepared, project);
        expect(unpreparedSetups([{ ...project, direction: "to-sandbox" }], prepared)).toEqual([]);
        const both = { ...project, direction: "both" } as const;
        expect(unpreparedSetups([both], prepared)).toEqual([both]);
        markPrepared(prepared, pairing);
        expect(unpreparedSetups([{ ...pairing, direction: "both" }], prepared)).toEqual([]);
    });

    it("prepares a second pairing added while the first is already served", () => {
        const prepared = new Set<string>();
        markPrepared(prepared, pairing);
        const second = { ...pairing, sandboxId: "sandbox-b", localDir: "/home/u/b", syncToken: "t3" };
        expect(unpreparedSetups([pairing, second], prepared)).toEqual([second]);
    });
});

describe("strandedForwards", () => {
    // The gap that cost a dogfooding machine 30 live forward sessions against one mirrored port: the reconcile works
    // from the persisted baseline, which cannot see a session that baseline lost.
    it("names every forward Mutagen holds that this pass did not mirror", () => {
        expect(strandedForwards([5173, 35_373, 38_043], [{ port: 38_043, host: "127.0.0.1" }])).toEqual([5173, 35_373]);
    });

    it("leaves a mirrored port alone whichever address it dials", () => {
        expect(strandedForwards([5173], [{ port: 5173, host: "::1" }])).toEqual([]);
    });

    it("has nothing to sweep when the device holds no forwards at all", () => {
        expect(strandedForwards([], [{ port: 5173, host: "127.0.0.1" }])).toEqual([]);
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ws = (port: number, host: "127.0.0.1" | "::1" = "127.0.0.1", command = "vite"): PortSummary => ({
    port,
    host,
    forwardable: true,
    kind: "workspace",
    title: "Vite dev server",
    purpose: "Started in one of your terminals.",
    origin: "terminal",
    command,
    forwarded: false,
});

// A recording executor so the reconcile logic tests without Mutagen: `free` decides the local-bind check, and `probed`
// is every port it was asked about.
const fakeExecutor = (
    free: (port: number) => boolean = () => true,
): { executor: ForwardExecutor; created: number[]; terminated: number[]; probed: number[] } => {
    const created: number[] = [];
    const terminated: number[] = [];
    const probed: number[] = [];
    return {
        created,
        terminated,
        probed,
        executor: {
            terminate: (port) => void terminated.push(port),
            create: async (summary) => await Promise.resolve(void created.push(summary.port)),
            isLocalPortFree: async (port) => {
                probed.push(port);
                return await Promise.resolve(free(port));
            },
        },
    };
};

const log = (): void => {};

// Nothing else on this machine is mirroring: the single-pairing case, and the default for these tests.
const unclaimed = new Map<number, string>();
// Nothing set aside on this device: the resting state every case below but the ignore ones runs under.
const nothingIgnored = new Set<number>();
// Nothing on this machine the bind probe cannot see: Docker answered and publishes nothing, and no port was busy last
// pass. Fresh each time, since reconcile keeps its grace clock in it.
const nothingHeld = (): LocalHolds => ({ docker: new Map(), wasBusy: new Set(), freeSince: new Map(), now: 0 });

// The wire schema also carries title/purpose/origin, unused by the mirror but required to parse.
const named = { title: "Vite dev server", purpose: "Started in one of your terminals.", origin: "terminal" as const };

describe("fetchWorkspacePorts", () => {
    it("sends the sync token and returns only forwardable workspace-kind ports", async () => {
        const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
            jsonResponse(200, {
                ports: [
                    { port: 47145, host: "::1", forwardable: true, kind: "workspace", command: "vite", forwarded: false, ...named },
                    { port: 4096, host: "127.0.0.1", forwardable: true, kind: "system", command: "opencode serve", forwarded: false, ...named },
                    // A workspace bind on a loopback alias: Mutagen would dial 127.0.0.1 and never reach it, so it's dropped.
                    { port: 9500, host: "127.0.0.1", forwardable: false, kind: "workspace", command: "alias-bound", forwarded: false, ...named },
                ],
            }),
        );
        stubGlobal("fetch", fetchMock);

        const ports = await fetchWorkspacePorts("https://sandbox-abc.example.dev/", "ist_tok");

        expect(ports).toEqual([{ port: 47145, host: "::1", forwardable: true, kind: "workspace", command: "vite", forwarded: false, ...named }]);
        expect(fetchMock).toHaveBeenCalledWith("https://sandbox-abc.example.dev/ports", {
            headers: { "x-intentic-sync": "ist_tok" },
            // Bounded, because the watcher agent is sequential: an unbounded read here stalls the git bridge too.
            signal: expect.any(AbortSignal),
        });
    });

    it("maps a rejected token to the re-pair message", async () => {
        stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toThrow(/re-run setup/);
    });

    it("types 401/403 as SyncAuthError: what the watcher counts toward revocation self-teardown", async () => {
        stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toBeInstanceOf(SyncAuthError);
        stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toBeInstanceOf(SyncAuthError);
        // A 5xx (tunnel blip) must not read as revocation; the watcher retries those forever.
        stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 })));
        const blip = await fetchWorkspacePorts("https://s.example.dev", "ist_old").catch((error: unknown) => error);
        expect(blip).toBeInstanceOf(Error);
        expect(blip).not.toBeInstanceOf(SyncAuthError);
    });
});

describe("reconcileForwards (minimal-touch)", () => {
    it("leaves unchanged forwards alone and creates only new ports", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const current: MirroredPort[] = [{ port: 3000, host: "127.0.0.1" }];
        const next = await reconcileForwards(executor, current, [ws(3000), ws(4321)], unclaimed, nothingIgnored, nothingHeld(), log);
        // A carried-over row keeps its own shape; only a freshly created one learns what is listening behind it.
        expect(next).toEqual([
            { port: 3000, host: "127.0.0.1" },
            { port: 4321, host: "127.0.0.1", command: "vite" },
        ]);
        expect(created).toEqual([4321]); // 3000 was untouched — no dropped connection
        expect(terminated).toEqual([4321]); // only the stale-clear before creating the new one
    });

    it("terminates a port that stopped listening", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const current: MirroredPort[] = [
            { port: 3000, host: "127.0.0.1" },
            { port: 4321, host: "127.0.0.1" },
        ];
        const next = await reconcileForwards(executor, current, [ws(3000)], unclaimed, nothingIgnored, nothingHeld(), log);
        expect(next).toEqual([{ port: 3000, host: "127.0.0.1" }]);
        expect(created).toEqual([]);
        expect(terminated).toEqual([4321]);
    });

    it("recreates a forward whose sandbox loopback family moved (127.0.0.1 → ::1)", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const next = await reconcileForwards(executor, [{ port: 3000, host: "127.0.0.1" }], [ws(3000, "::1")], unclaimed, nothingIgnored, nothingHeld(), log);
        expect(next).toEqual([{ port: 3000, host: "::1", command: "vite" }]);
        expect(terminated).toEqual([3000]);
        expect(created).toEqual([3000]);
    });

    it("skips a port a foreign local process already holds", async () => {
        const { executor, created } = fakeExecutor((port) => port !== 5000);
        const next = await reconcileForwards(executor, [], [ws(5000)], unclaimed, nothingIgnored, nothingHeld(), log);
        expect(next).toEqual([]);
        expect(created).toEqual([]);
    });

    // Two sandboxes can serve the same dev-server port; only one owns localhost:6480. Decided here, not by the OS
    // probe, so the loser is told which sandbox holds it and the winner's forward is never torn down.
    it("yields a port another pairing already mirrors, without disturbing it", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const claimed = new Map([[6480, "sandbox-first.example.dev"]]);
        const next = await reconcileForwards(executor, [], [ws(6480), ws(7000)], claimed, nothingIgnored, nothingHeld(), log);
        expect(next).toEqual([{ port: 7000, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([7000]);
        // 6480 is neither created nor terminated: the other pairing's session keeps serving it.
        expect(terminated).toEqual([7000]);
    });

    // The whole point of the per-port switch: one number is left off localhost and every other port carries on.
    it("never creates a forward for a port this device was told to leave alone", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const next = await reconcileForwards(executor, [], [ws(5440), ws(5173)], unclaimed, new Set([5440]), nothingHeld(), log);
        expect(next).toEqual([{ port: 5173, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([5173]);
        // 5440 never reaches the free-check, so nothing is terminated for it either.
        expect(terminated).toEqual([5173]);
    });

    // Thrown while the port is up: the forward has to come down on this pass, and must not be carried into the
    // next one as still established.
    it("takes down a live forward the moment its port is set aside", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const next = await reconcileForwards(executor, [{ port: 5440, host: "127.0.0.1" }], [ws(5440)], unclaimed, new Set([5440]), nothingHeld(), log);
        expect(next).toEqual([]);
        expect(terminated).toEqual([5440]);
        expect(created).toEqual([]);
    });

    // A port this pairing already mirrors is its own; a claim map naming it must not make it release a port it's
    // already serving.
    it("keeps its own established forward even if the port is claimed", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const claimed = new Map([[3000, "sandbox-other.example.dev"]]);
        const next = await reconcileForwards(executor, [{ port: 3000, host: "127.0.0.1" }], [ws(3000)], claimed, nothingIgnored, nothingHeld(), log);
        expect(next).toEqual([{ port: 3000, host: "127.0.0.1" }]);
        expect(created).toEqual([]);
        expect(terminated).toEqual([]);
    });
});

// THE BIND PROBE SEES ONE INSTANT. On 2026-10-01 a WSL and Docker Desktop restart let it find the host's own Postgres
// port free (5440, a compose container that is `unless-stopped`) before Docker had published it again: the mirror took
// it, Docker's publish then failed for good, and the host's API read the sandbox's empty database.
describe("reconcileForwards (what the bind probe cannot see)", () => {
    const T0 = 1_700_000_000_000;
    const postgres = ws(5440, "127.0.0.1", "postgres");
    const composed = new Map([[5440, "intentic-postgres-1"]]);
    // Docker answered, and publishes nothing.
    const nothingPublished = new Map<number, string>();
    const busy5440: SkippedPort = { port: 5440, host: "127.0.0.1", reason: "busy", heldBy: undefined, command: "postgres" };

    // A log that keeps what it was told, for the cases whose line is the point.
    const heard = () => {
        const lines: string[] = [];
        return { lines, say: (line: string): void => void lines.push(line) };
    };

    // Passes as the watcher runs them (servePairing): each reads the busy rows the one before it recorded, starts from the
    // forwards it left, and one grace clock runs across them all.
    const passes = (executor: ForwardExecutor, desired: readonly PortSummary[], rows: readonly SkippedPort[]) => {
        const freeSince = new Map<number, number>();
        let current: readonly MirroredPort[] = [];
        let skipped = rows;
        return {
            freeSince,
            skipped: (): readonly SkippedPort[] => skipped,
            run: async (now: number, docker: LocalHolds["docker"]): Promise<MirroredPort[]> => {
                const holds = { docker, wasBusy: busyLastPass({ skippedPorts: skipped }), freeSince, now };
                const next = await reconcileForwards(executor, current, desired, unclaimed, nothingIgnored, holds, log);
                current = next;
                skipped = skippedPortsOf(desired, next, unclaimed, nothingIgnored);
                return next;
            },
        };
    };

    it("never mirrors a port a Docker container on this machine publishes, though the bind probe finds it free", async () => {
        const { executor, created, probed } = fakeExecutor();
        const { lines, say } = heard();
        const desired = [postgres, ws(5173)];
        const next = await reconcileForwards(executor, [], desired, unclaimed, nothingIgnored, { ...nothingHeld(), docker: composed }, say);
        expect(next).toEqual([{ port: 5173, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([5173]);
        // Docker's answer stands over the probe's, which is never asked about the port.
        expect(probed).toEqual([5173]);
        // The container is named in this agent's own log and nowhere else: its record is the plain busy a report carries.
        expect(lines).toEqual([
            "  localhost:5440 is published by a Docker container on this machine (intentic-postgres-1): skipped (postgres)",
            "  localhost:5173 ← vite",
        ]);
        expect(skippedPortsOf(desired, next, unclaimed, nothingIgnored)).toEqual([busy5440]);
    });

    // The forward the incident left behind: Docker never retries the publish it lost, so the forward is what gives way.
    it("takes down a live forward on a port Docker publishes, and creates nothing in its place", async () => {
        const terminated: number[] = [];
        // Nothing else may happen to the port: neither a probe nor a create is stubbed, so either would throw by name.
        const executor = unstubbed<ForwardExecutor>("executor", { terminate: (port) => void terminated.push(port) });
        const { lines, say } = heard();
        const live: MirroredPort[] = [{ port: 5440, host: "127.0.0.1", command: "postgres" }];
        const next = await reconcileForwards(executor, live, [postgres], unclaimed, nothingIgnored, { ...nothingHeld(), docker: composed }, say);
        expect(next).toEqual([]);
        expect(terminated).toEqual([5440]);
        expect(lines).toEqual([
            "  localhost:5440: stopped (a Docker container on this machine publishes that port: intentic-postgres-1)",
            "  localhost:5440 is published by a Docker container on this machine (intentic-postgres-1): skipped (postgres)",
        ]);
    });

    // What the README promises, and well past the minutes Docker Desktop takes to restart and publish its ports again.
    it("waits a quarter of an hour", () => {
        expect(BUSY_GRACE_MS).toBe(15 * 60_000);
    });

    it("keeps skipping a port the last pass found busy, still recorded busy, while it has been free for less than the grace", async () => {
        const { executor, created } = fakeExecutor();
        const watcher = passes(executor, [postgres], [busy5440]);
        expect(await watcher.run(T0, nothingPublished)).toEqual([]);
        expect(await watcher.run(T0 + BUSY_GRACE_MS - 1, nothingPublished)).toEqual([]);
        expect(created).toEqual([]);
        // Still the busy row, so the next pass, or an agent restarted now, still holds it off.
        expect(watcher.skipped()).toEqual([busy5440]);
    });

    it("mirrors that port once it has stayed free for the whole grace", async () => {
        const { executor, created } = fakeExecutor();
        const watcher = passes(executor, [postgres], [busy5440]);
        await watcher.run(T0, nothingPublished);
        expect(await watcher.run(T0 + BUSY_GRACE_MS, nothingPublished)).toEqual([{ port: 5440, host: "127.0.0.1", command: "postgres" }]);
        expect(created).toEqual([5440]);
        expect(watcher.skipped()).toEqual([]);
        // The clock goes with the grace it measured.
        expect(watcher.freeSince).toEqual(new Map());
    });

    // Continuously free, that is: a holder seen in between, by the probe or through Docker, starts the grace over.
    it("starts the grace over each time the port is seen held again", async () => {
        let free = true;
        const { executor, created } = fakeExecutor(() => free);
        const watcher = passes(executor, [postgres], [busy5440]);
        await watcher.run(T0, nothingPublished);
        free = false;
        await watcher.run(T0 + 60_000, nothingPublished);
        free = true;
        await watcher.run(T0 + 2 * 60_000, nothingPublished);
        // A quarter of an hour since it was first seen free, but not since it was last seen held.
        expect(await watcher.run(T0 + BUSY_GRACE_MS, nothingPublished)).toEqual([]);
        await watcher.run(T0 + BUSY_GRACE_MS + 60_000, composed);
        await watcher.run(T0 + BUSY_GRACE_MS + 2 * 60_000, nothingPublished);
        expect(await watcher.run(T0 + 2 * BUSY_GRACE_MS + 2 * 60_000 - 1, nothingPublished)).toEqual([]);
        expect(created).toEqual([]);
        expect(await watcher.run(T0 + 2 * BUSY_GRACE_MS + 2 * 60_000, nothingPublished)).toEqual([{ port: 5440, host: "127.0.0.1", command: "postgres" }]);
        expect(created).toEqual([5440]);
    });

    it("mirrors a free port nobody was seen holding at once, as before", async () => {
        const { executor, created } = fakeExecutor();
        // 5440 was busy last pass and 5173 was not, so only 5440 owes the grace.
        const watcher = passes(executor, [postgres, ws(5173)], [busy5440]);
        expect(await watcher.run(T0, nothingPublished)).toEqual([{ port: 5173, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([5173]);
    });

    // No docker on PATH, an engine down or restarting, a socket this user may not open: the busy memory still holds.
    it("falls back to the busy memory alone when Docker could not be asked", async () => {
        const { executor, created, probed } = fakeExecutor();
        const { lines, say } = heard();
        const desired = [postgres, ws(5173)];
        const holds = { docker: undefined, wasBusy: new Set([5440]), freeSince: new Map<number, number>(), now: T0 };
        expect(await reconcileForwards(executor, [], desired, unclaimed, nothingIgnored, holds, say)).toEqual([{ port: 5173, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([5173]);
        // Without Docker's answer every port goes to the probe, and the one seen busy waits out its grace.
        expect(probed).toEqual([5440, 5173]);
        expect(lines).toEqual([
            "  localhost:5440 was busy on this machine until recently: holding off until it has stayed free for 15 minutes (postgres)",
            "  localhost:5173 ← vite",
        ]);
    });

    it("mirrors the port once its grace is served, with Docker never answering", async () => {
        const { executor, created } = fakeExecutor();
        const watcher = passes(executor, [postgres], [busy5440]);
        expect(await watcher.run(T0, undefined)).toEqual([]);
        expect(await watcher.run(T0 + BUSY_GRACE_MS - 1, undefined)).toEqual([]);
        expect(await watcher.run(T0 + BUSY_GRACE_MS, undefined)).toEqual([{ port: 5440, host: "127.0.0.1", command: "postgres" }]);
        expect(created).toEqual([5440]);
    });

    // The memory is the persisted busy row and nothing else: a port is held off only for a holder it was seen with.
    it("remembers only the ports the last pass found busy", () => {
        const rows: SkippedPort[] = [
            { port: 5440, host: "127.0.0.1", reason: "ignored", command: "postgres" },
            { port: 6480, host: "127.0.0.1", reason: "held-by-sandbox", heldBy: "scratch" },
            { port: 8080, host: "::1", reason: "busy" },
        ];
        expect(busyLastPass({ skippedPorts: rows })).toEqual(new Set([8080]));
        expect(busyLastPass({})).toEqual(new Set());
    });

    // `unignore` hands the port back with its "ignored" row: nothing was seen holding it here, so nothing is waited out.
    it("mirrors a port somebody stopped ignoring as soon as it is free", async () => {
        const { executor, created } = fakeExecutor();
        const watcher = passes(executor, [postgres], [{ port: 5440, host: "127.0.0.1", reason: "ignored", command: "postgres" }]);
        expect(await watcher.run(T0, nothingPublished)).toEqual([{ port: 5440, host: "127.0.0.1", command: "postgres" }]);
        expect(created).toEqual([5440]);
    });
});

// A pairing's forwards bind their ports until its own pass, so a pairing listed before it finds them bound. Filed as
// busy, such a port would wait out the grace once its sibling let it go; filed as the sibling's, it is taken at once.
describe("whose forward a port is", () => {
    const first: Pairing = { sandboxUrl: "https://first.example.dev", sandboxId: "first", mode: "mirror" };
    const second: Pairing = {
        sandboxUrl: "https://second.example.dev",
        sandboxId: "second",
        mode: "mirror",
        mirroredPorts: [{ port: 5173, host: "127.0.0.1", command: "vite" }],
    };

    it("names a later pairing's forward as the holder before that pairing has passed, so nothing waits out the grace", () => {
        const holding = recordedForwards([first, second]);
        // `first` passes first and finds 5173 bound by `second`'s forward.
        const rows = skippedPortsOf([ws(5173)], [], othersHolding(holding, "first"), nothingIgnored);
        expect(rows).toEqual([{ port: 5173, host: "127.0.0.1", reason: "held-by-sandbox", heldBy: "second", command: "vite" }]);
        expect(busyLastPass({ skippedPorts: rows })).toEqual(new Set());
    });

    it("takes a finished pass's word over its record, and keeps the record of one that has not passed", () => {
        const holding = recordedForwards([first, second]);
        handOver(holding, "first", [{ port: 3000, host: "127.0.0.1" }]);
        expect(holding).toEqual(
            new Map([
                [5173, "second"],
                [3000, "first"],
            ]),
        );
        // `second` stopped serving 5173: its pass lets it go, and nobody holds it any more.
        handOver(holding, "second", []);
        expect(holding).toEqual(new Map([[3000, "first"]]));
    });

    it("never names a pairing as its own holder", () => {
        expect(othersHolding(recordedForwards([first, second]), "second")).toEqual(new Map());
    });
});

describe("readResidentPid", () => {
    it("returns our own pid as alive and rejects a non-numeric pidfile", async () => {
        await writeFile(runPidPath, await pidFileBody({ pid: process.pid }));
        await expect(readResidentPid()).resolves.toBe(process.pid);
        await writeFile(runPidPath, "not-a-pid");
        await expect(readResidentPid()).resolves.toBeUndefined();
    });

    // A record with no boot stamp is not one of ours, so it describes nothing this boot can reach.
    it("rejects a pidfile carrying a bare pid", async () => {
        await writeFile(runPidPath, String(process.pid));
        await expect(readResidentPid()).resolves.toBeUndefined();
    });
});

// Two resident agents fight: each reconciles the same forwards from its own baseline, tearing down and recreating
// each other's sessions. Every path that runs the agent directly (systemd unit, LaunchAgent, hand-run) must hit this
// guard.
describe("runForeground single-holder guard", () => {
    it("refuses when a live agent already holds the pidfile, before touching config or Mutagen", async () => {
        const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        const pid = other.pid;
        if (pid === undefined) {
            throw new Error("the stand-in agent didn't start");
        }
        const held = await pidFileBody({ pid });
        try {
            await writeFile(runPidPath, held);
            const said: string[] = [];

            // Proves the guard runs first: everything past it reads config, dials sandboxes, and calls ensureMutagen(),
            // which
            // would try to download a release here.
            await runForeground((message) => said.push(message));

            expect(said.join("\n")).toContain(`already running (pid ${pid})`);
            // The incumbent keeps the pidfile: a refusing agent must not stamp its own pid over it.
            expect((await readFile(runPidPath, "utf8")).trim()).toBe(held);
        } finally {
            other.kill("SIGKILL");
        }
    });

    // A pidfile outlives the boot that wrote it, and pids restart low, so yesterday's watcher pid can be an unrelated
    // process this morning; only the boot stamp says whether a live pid is really this agent's.
    it("starts when the pidfile is from an earlier boot, however alive that pid happens to be now", async () => {
        const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        const pid = other.pid;
        if (pid === undefined) {
            throw new Error("the stand-in agent didn't start");
        }
        try {
            await writeFile(runPidPath, JSON.stringify({ pid, boot: "id:0f9a1c3e-0000-4000-8000-000000000000" }));

            expect(await readResidentPid()).toBeUndefined();
        } finally {
            other.kill("SIGKILL");
        }
    });
});

// Restart=on-failure never restarts a clean exit. A signal means something else stopped the process, so it must
// exit non-zero, or a supervisor will never restart it.
describe("signalExitCode", () => {
    it("reports a signal as a failure, so a supervisor restarts what it did not stop", () => {
        expect(signalExitCode("SIGTERM")).toBe(143);
        expect(signalExitCode("SIGINT")).toBe(130);
    });

    // 128+signal is the shell's convention, so a supervisor's `$?` reads it correctly without consulting this file.
    it("uses 128 + the signal number", () => {
        expect(signalExitCode("SIGTERM")).toBe(128 + 15);
        expect(signalExitCode("SIGINT")).toBe(128 + 2);
        // The Windows side supervising a distro reads SIGHUP (its wsl.exe session ending) as a stop, not a crash.
        expect(signalExitCode("SIGHUP")).toBe(128 + 1);
    });
});

describe("stopResident", () => {
    it("returns only once the agent is GONE, not merely signalled", async () => {
        // Shaped like the real agent: handles SIGTERM and takes a moment to wind down. An instant-dying stand-in
        // couldn't
        // distinguish "waited for it" from "signalled and moved on".
        const resident = spawn(
            process.execPath,
            ["-e", 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000); console.log("ready")'],
            { detached: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        const pid = resident.pid;
        if (pid === undefined || resident.stdout === null) {
            throw new Error("the stand-in agent didn't start");
        }
        // Waits for the handler to be installed: signalling a still-booting process kills it outright, silently turning
        // this into a test that passes either way.
        await new Promise((ready) => resident.stdout?.once("data", ready));
        await writeFile(runPidPath, await pidFileBody({ pid }));

        await expect(stopResident()).resolves.toBe(pid);

        // setup replaces the agent binary this process is running, and on Windows a live one holds that file open.
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(readFile(runPidPath, "utf8")).rejects.toThrow();
    });

    it("is a no-op when nothing is running", async () => {
        await expect(stopResident()).resolves.toBeUndefined();
    });
});

// Unpairing one sandbox must leave every other pairing on the machine mirroring.
describe("retirePairingMirror", () => {
    it("terminates only the named sandbox's forwards, not a sibling pairing's, not a stranger's", async () => {
        const record = join(dirname(runPidPath), "terminated.txt");
        const fakeMutagen = join(dirname(runPidPath), "fake-mutagen.sh");
        await writeFile(
            fakeMutagen,
            `#!/bin/sh
if [ "$2" = "list" ]; then echo "intentic-fwd-sandbox-keep-5173 someone-elses-forward intentic-fwd-sandbox-drop-6480 intentic-fwd-sandbox-drop-7000"; exit 0; fi
if [ "$2" = "terminate" ]; then shift 2; echo "$@" > ${record}; exit 0; fi
exit 0
`,
            { mode: 0o755 },
        );

        await expect(retirePairingMirror(fakeMutagen, "sandbox-drop")).resolves.toBe(2);

        expect((await readFile(record, "utf8")).trim()).toBe("intentic-fwd-sandbox-drop-6480 intentic-fwd-sandbox-drop-7000");
    });

    it("has nothing to do for a sandbox holding no forwards", async () => {
        const quiet = join(dirname(runPidPath), "quiet-mutagen.sh");
        await writeFile(quiet, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await expect(retirePairingMirror(quiet, "sandbox-none")).resolves.toBe(0);
    });
});

// Setting one port aside has to take effect on this call, not on the watcher's next pass: that pass is seconds away
// while the agent runs and never arrives while it does not, and until then the report would still claim the number.
describe("retireMirroredPort", () => {
    it("terminates that one forward and re-files its record as ignored", async () => {
        const record = join(dirname(runPidPath), "port-terminated.txt");
        const fakeMutagen = join(dirname(runPidPath), "port-mutagen.sh");
        await writeFile(fakeMutagen, `#!/bin/sh\nif [ "$2" = "terminate" ]; then shift 2; echo "$@" > ${record}; fi\nexit 0\n`, { mode: 0o755 });
        await upsertPairing({
            sandboxUrl: "https://work.example.dev/",
            sandboxId: "work",
            mode: "mirror",
            mirroredPorts: [
                { port: 5440, host: "127.0.0.1", command: "postgres" },
                { port: 5173, host: "127.0.0.1", command: "vite" },
            ],
        });

        await expect(retireMirroredPort(fakeMutagen, "work", 5440)).resolves.toBe(true);

        expect((await readFile(record, "utf8")).trim()).toBe(forwardSessionName("work", 5440));
        const held = (await readState()).pairings.find((pairing) => pairing.sandboxId === "work");
        // Only that port leaves; the sibling forward keeps its own connections.
        expect(held?.mirroredPorts).toEqual([{ port: 5173, host: "127.0.0.1", command: "vite" }]);
        // And it is still REPORTED, under the reason nobody tried, since that row is the only way back.
        expect(held?.skippedPorts).toEqual([{ port: 5440, host: "127.0.0.1", reason: "ignored", command: "postgres" }]);
    });

    // Nothing came off localhost, which is a different sentence for the caller to print than "there you go".
    it("answers false for a port this device was not mirroring", async () => {
        const quiet = join(dirname(runPidPath), "quiet-port-mutagen.sh");
        await writeFile(quiet, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await upsertPairing({ sandboxUrl: "https://lab.example.dev/", sandboxId: "lab", mode: "mirror" });
        await expect(retireMirroredPort(quiet, "lab", 5440)).resolves.toBe(false);
    });
});

describe("mutagen forward args", () => {
    it("names sessions per sandbox + port and dials the recorded loopback host (::1 bracketed)", () => {
        expect(forwardSessionName("sandbox-abc.example.dev", 47145)).toBe("intentic-fwd-sandbox-abc-example-dev-47145");
        expect(mutagenForwardArgs({ name: "n", port: 6480, remote: { kind: "ssh", alias: "intentic-x" }, host: "127.0.0.1" })).toEqual([
            "forward",
            "create",
            "--name",
            "n",
            "tcp:127.0.0.1:6480",
            "intentic-x:tcp:127.0.0.1:6480",
        ]);
        expect(mutagenForwardArgs({ name: "n", port: 47145, remote: { kind: "ssh", alias: "intentic-x" }, host: "::1" }).at(-1)).toBe("intentic-x:tcp:[::1]:47145");
    });

    // A project on this machine's own engine has its ports forwarded straight into its container (endpoint.ts).
    it("dials a docker pairing's container through Docker, binding the same local port", () => {
        expect(mutagenForwardArgs({ name: "n", port: 5173, remote: { kind: "docker", container: "intentic-sandbox-sandbox-x" }, host: "::1" })).toEqual([
            "forward",
            "create",
            "--name",
            "n",
            "tcp:127.0.0.1:5173",
            "docker://intentic-sandbox-sandbox-x:tcp:[::1]:5173",
        ]);
    });
});
