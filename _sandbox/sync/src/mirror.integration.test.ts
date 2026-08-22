import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PortSummary } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MirroredPort } from "./config.js";
import type { ForwardExecutor } from "./mirror.js";

// config.ts derives its paths from homedir() at import time, so point HOME at a throwaway dir BEFORE importing
// (dynamic import, after the env is set): then mirror.pid lands in temp, not the real ~/.intentic/sync.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-mirror-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { mirrorPidPath } = await import("./config.js");
const {
    fetchWorkspacePorts,
    reconcileForwards,
    readLiveWatcherPid,
    retirePairingMirror,
    runMirrorWatch,
    signalExitCode,
    stopWatcher,
    SyncAuthError,
} = await import("./mirror.js");
const { forwardSessionName, mutagenForwardArgs } = await import("./mutagen.js");
// setup() creates ~/.intentic/sync when it writes the state; the pidfile test writes there directly, so make it first.
await mkdir(dirname(mirrorPidPath), { recursive: true });

afterEach(() => {
    vi.restoreAllMocks();
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

// A recording executor so the reconcile logic tests without Mutagen: `free` decides the local-bind check.
const fakeExecutor = (free: (port: number) => boolean = () => true): { executor: ForwardExecutor; created: number[]; terminated: number[] } => {
    const created: number[] = [];
    const terminated: number[] = [];
    return {
        created,
        terminated,
        executor: {
            terminate: (port) => void terminated.push(port),
            create: async (summary) => await Promise.resolve(void created.push(summary.port)),
            isLocalPortFree: (port) => Promise.resolve(free(port)),
        },
    };
};

const log = (): void => {};

// Nothing else on this machine is mirroring: the single-pairing case, and the default for these tests.
const unclaimed = new Map<number, string>();

// Every row on the wire now carries what it IS as well as where it runs; the mirror ignores all three, but
// the schema is strict so a fixture without them never parses.
const named = { title: "Vite dev server", purpose: "Started in one of your terminals.", origin: "terminal" as const };

describe("fetchWorkspacePorts", () => {
    it("sends the sync token and returns only forwardable workspace-kind ports", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            jsonResponse(200, {
                ports: [
                    { port: 47145, host: "::1", forwardable: true, kind: "workspace", command: "vite", forwarded: false, ...named },
                    { port: 4096, host: "127.0.0.1", forwardable: true, kind: "system", command: "opencode serve", forwarded: false, ...named },
                    // A workspace bind on a loopback alias: Mutagen would dial 127.0.0.1 and never reach it, so it's dropped.
                    { port: 9500, host: "127.0.0.1", forwardable: false, kind: "workspace", command: "alias-bound", forwarded: false, ...named },
                ],
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const ports = await fetchWorkspacePorts("https://sandbox-abc.example.dev/", "ist_tok");

        expect(ports).toEqual([{ port: 47145, host: "::1", forwardable: true, kind: "workspace", command: "vite", forwarded: false, ...named }]);
        expect(fetchMock).toHaveBeenCalledWith("https://sandbox-abc.example.dev/ports", {
            headers: { "x-intentic-sync": "ist_tok" },
            // Bounded, because the watcher loop is sequential: an unbounded read here stalls the git bridge too.
            signal: expect.any(AbortSignal),
        });
    });

    it("maps a rejected token to the re-pair message", async () => {
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toThrow(/re-run setup/);
    });

    it("types 401/403 as SyncAuthError: what the watcher counts toward revocation self-teardown", async () => {
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toBeInstanceOf(SyncAuthError);
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toBeInstanceOf(SyncAuthError);
        // A 5xx (tunnel blip) must NOT read as revocation: the watcher retries those forever.
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 })));
        const blip = await fetchWorkspacePorts("https://s.example.dev", "ist_old").catch((error: unknown) => error);
        expect(blip).toBeInstanceOf(Error);
        expect(blip).not.toBeInstanceOf(SyncAuthError);
    });
});

describe("reconcileForwards (minimal-touch)", () => {
    it("leaves unchanged forwards alone and creates only new ports", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const current: MirroredPort[] = [{ port: 3000, host: "127.0.0.1" }];
        const next = await reconcileForwards(executor, current, [ws(3000), ws(4321)], unclaimed, log);
        // A row carried over keeps the baseline's own shape; only a freshly created one learns what is listening
        // behind it, which is what labels the port in the machine report.
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
        const next = await reconcileForwards(executor, current, [ws(3000)], unclaimed, log);
        expect(next).toEqual([{ port: 3000, host: "127.0.0.1" }]);
        expect(created).toEqual([]);
        expect(terminated).toEqual([4321]);
    });

    it("recreates a forward whose sandbox loopback family moved (127.0.0.1 → ::1)", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const next = await reconcileForwards(executor, [{ port: 3000, host: "127.0.0.1" }], [ws(3000, "::1")], unclaimed, log);
        expect(next).toEqual([{ port: 3000, host: "::1", command: "vite" }]);
        expect(terminated).toEqual([3000]);
        expect(created).toEqual([3000]);
    });

    it("skips a port a foreign local process already holds", async () => {
        const { executor, created } = fakeExecutor((port) => port !== 5000);
        const next = await reconcileForwards(executor, [], [ws(5000)], unclaimed, log);
        expect(next).toEqual([]);
        expect(created).toEqual([]);
    });

    /* Two sandboxes on one machine routinely serve the same dev-server port, and only one can own localhost:6480.
     * The contest is decided here rather than by the OS probe, so the loser is told WHICH sandbox holds it, and
     * critically, the winner's live forward is never terminated by the loser's pass. */
    it("yields a port another pairing already mirrors, without disturbing it", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const claimed = new Map([[6480, "sandbox-first.example.dev"]]);
        const next = await reconcileForwards(executor, [], [ws(6480), ws(7000)], claimed, log);
        expect(next).toEqual([{ port: 7000, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([7000]);
        // 6480 is neither created nor terminated: the other pairing's session keeps serving it.
        expect(terminated).toEqual([7000]);
    });

    // A port THIS pairing already mirrors is its own: a claim map naming it would otherwise make a pairing
    // release the port it is already serving on the very next tick.
    it("keeps its own established forward even if the port is claimed", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const claimed = new Map([[3000, "sandbox-other.example.dev"]]);
        const next = await reconcileForwards(executor, [{ port: 3000, host: "127.0.0.1" }], [ws(3000)], claimed, log);
        expect(next).toEqual([{ port: 3000, host: "127.0.0.1" }]);
        expect(created).toEqual([]);
        expect(terminated).toEqual([]);
    });
});

describe("readLiveWatcherPid", () => {
    it("returns our own pid as alive and rejects a non-numeric pidfile", async () => {
        await writeFile(mirrorPidPath, String(process.pid));
        await expect(readLiveWatcherPid()).resolves.toBe(process.pid);
        await writeFile(mirrorPidPath, "not-a-pid");
        await expect(readLiveWatcherPid()).resolves.toBeUndefined();
    });
});

/* Two watchers do real damage, not merely waste a process: each reconciles the same forwards from its own
 * baseline, so they take turns tearing down and recreating each other's sessions and drop live connections on a
 * loop. Only `startMirrorWatcher` used to check the pidfile, so every path that runs the loop DIRECTLY: a systemd
 * unit, a LaunchAgent, a hand-run `mirror --watch`: could stack one on top of a resident copy. */
describe("runMirrorWatch single-holder guard", () => {
    it("refuses when a live watcher already holds the pidfile, before touching Mutagen", async () => {
        const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        const pid = other.pid;
        if (pid === undefined) {
            throw new Error("the stand-in watcher didn't start");
        }
        try {
            await writeFile(mirrorPidPath, String(pid));
            const said: string[] = [];

            // Returning here is what proves the guard runs FIRST: everything past it calls ensureMutagen(), which
            // would try to download a release in a unit test.
            await runMirrorWatch((message) => said.push(message));

            expect(said.join("\n")).toContain(`already running (pid ${pid})`);
            // The incumbent keeps the pidfile: a refusing watcher must not stamp its own pid over it.
            expect((await readFile(mirrorPidPath, "utf8")).trim()).toBe(String(pid));
        } finally {
            other.kill("SIGKILL");
        }
    });
});

/* THE NUMBER THAT DECIDES WHETHER SYNC COMES BACK. The watcher is supervised by `Restart=on-failure` (a systemd
 * user unit, so a deliberate `systemctl --user stop` stays stopped), which means a clean exit is never restarted.
 * A signal is not a clean exit: it is something ELSE stopping this process, and the only kinds that should stay
 * stopped are the ones systemd itself initiates, which it already refuses to restart whatever the code says.
 *
 * Field failure: the watcher took a SIGTERM it never asked for, exited 0, and desktop sync was off for five
 * hours with both endpoints reading `Connected: No` and nothing restarting it. Exiting 0 here is what said
 * "someone meant this". */
describe("signalExitCode", () => {
    it("reports a signal as a failure, so a supervisor restarts what it did not stop", () => {
        expect(signalExitCode("SIGTERM")).toBe(143);
        expect(signalExitCode("SIGINT")).toBe(130);
    });

    // 128+signal, the shell's own convention, rather than a number of ours: a supervisor's logs and `$?` both
    // read it as "terminated by SIGTERM" without anyone consulting this file.
    it("uses 128 + the signal number", () => {
        expect(signalExitCode("SIGTERM")).toBe(128 + 15);
        expect(signalExitCode("SIGINT")).toBe(128 + 2);
    });
});

describe("stopWatcher", () => {
    it("returns only once the watcher is GONE, not merely signalled", async () => {
        // A watcher shaped like the real one: it handles SIGTERM and takes a moment to wind down (the real one
        // removes its pidfile first). An instantly-dying stand-in cannot tell "waited for it" from "signalled
        // it and moved on", which is the whole property under test.
        const watcher = spawn(
            process.execPath,
            ["-e", 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000); console.log("ready")'],
            { detached: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        const pid = watcher.pid;
        if (pid === undefined || watcher.stdout === null) {
            throw new Error("the stand-in watcher didn't start");
        }
        // Wait for its handler to be INSTALLED. Signalling a node process still booting kills it outright, which
        // silently turns this into a test of an instantly-dying watcher: one that passes either way.
        await new Promise((ready) => watcher.stdout?.once("data", ready));
        await writeFile(mirrorPidPath, String(pid));

        await expect(stopWatcher()).resolves.toBe(pid);

        // setup replaces the agent binary this process is running, and on Windows a live one holds that file open.
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(readFile(mirrorPidPath, "utf8")).rejects.toThrow();
    });

    it("is a no-op when nothing is running", async () => {
        await expect(stopWatcher()).resolves.toBeUndefined();
    });
});

/* Unpairing ONE sandbox must leave every other pairing on the machine mirroring. Tearing down all of this agent's
 * forwards on every setup is half of what broke a live pairing: the forwards were named for the other sandbox, the
 * config that replaced it named none of them, and Mutagen holds a released port's listener for good. */
describe("retirePairingMirror", () => {
    it("terminates only the named sandbox's forwards, not a sibling pairing's, not a stranger's", async () => {
        const record = join(dirname(mirrorPidPath), "terminated.txt");
        const fakeMutagen = join(dirname(mirrorPidPath), "fake-mutagen.sh");
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
        const quiet = join(dirname(mirrorPidPath), "quiet-mutagen.sh");
        await writeFile(quiet, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await expect(retirePairingMirror(quiet, "sandbox-none")).resolves.toBe(0);
    });
});

describe("mutagen forward args", () => {
    it("names sessions per sandbox + port and dials the recorded loopback host (::1 bracketed)", () => {
        expect(forwardSessionName("sandbox-abc.example.dev", 47145)).toBe("intentic-fwd-sandbox-abc-example-dev-47145");
        expect(mutagenForwardArgs({ name: "n", port: 6480, alias: "intentic-x", host: "127.0.0.1" })).toEqual([
            "forward",
            "create",
            "--name",
            "n",
            "tcp:127.0.0.1:6480",
            "intentic-x:tcp:127.0.0.1:6480",
        ]);
        expect(mutagenForwardArgs({ name: "n", port: 47145, alias: "intentic-x", host: "::1" }).at(-1)).toBe("intentic-x:tcp:[::1]:47145");
    });
});
