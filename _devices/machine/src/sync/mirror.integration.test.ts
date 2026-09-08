import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pidFileBody } from "@intentic/local-agent";
import type { PortSummary } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MirroredPort } from "./config.js";
import type { ForwardExecutor } from "./mirror.js";

// config.ts reads homedir() at import time; HOME must point at a throwaway dir before the dynamic import below,
// or machine.pid lands in the real ~/.intentic/machine.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "machine-mirror-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { runPidPath } = await import("../config.js");
const { fetchWorkspacePorts, reconcileForwards, retirePairingMirror, shouldAutoPauseFileSync, signalExitCode, SyncAuthError } =
    await import("./mirror.js");
const { readResidentPid, runForeground, stopResident } = await import("../resident.js");
const { forwardSessionName, mutagenForwardArgs } = await import("./mutagen.js");
// setup() creates ~/.intentic/machine on write; the pidfile test writes there directly, so make it first.
await mkdir(dirname(runPidPath), { recursive: true });

it("auto-pauses only after an hour of uninterrupted failed polls", () => {
    expect(shouldAutoPauseFileSync(719)).toBe(false);
    expect(shouldAutoPauseFileSync(720)).toBe(true);
});

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

// The wire schema also carries title/purpose/origin, unused by the mirror but required to parse.
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
        // A 5xx (tunnel blip) must not read as revocation; the watcher retries those forever.
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

    // Two sandboxes can serve the same dev-server port; only one owns localhost:6480. Decided here, not by the OS
    // probe, so the loser is told which sandbox holds it and the winner's forward is never torn down.
    it("yields a port another pairing already mirrors, without disturbing it", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const claimed = new Map([[6480, "sandbox-first.example.dev"]]);
        const next = await reconcileForwards(executor, [], [ws(6480), ws(7000)], claimed, log);
        expect(next).toEqual([{ port: 7000, host: "127.0.0.1", command: "vite" }]);
        expect(created).toEqual([7000]);
        // 6480 is neither created nor terminated: the other pairing's session keeps serving it.
        expect(terminated).toEqual([7000]);
    });

    // A port this pairing already mirrors is its own; a claim map naming it must not make it release a port it's
    // already serving.
    it("keeps its own established forward even if the port is claimed", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const claimed = new Map([[3000, "sandbox-other.example.dev"]]);
        const next = await reconcileForwards(executor, [{ port: 3000, host: "127.0.0.1" }], [ws(3000)], claimed, log);
        expect(next).toEqual([{ port: 3000, host: "127.0.0.1" }]);
        expect(created).toEqual([]);
        expect(terminated).toEqual([]);
    });
});

describe("readResidentPid", () => {
    it("returns our own pid as alive and rejects a non-numeric pidfile", async () => {
        await writeFile(runPidPath, await pidFileBody());
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

// Two resident loops fight: each reconciles the same forwards from its own baseline, tearing down and recreating
// each other's sessions. Every path that runs the loop directly (systemd unit, LaunchAgent, hand-run) must hit this
// guard.
describe("runForeground single-holder guard", () => {
    it("refuses when a live loop already holds the pidfile, before touching config or Mutagen", async () => {
        const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        const pid = other.pid;
        if (pid === undefined) {
            throw new Error("the stand-in loop didn't start");
        }
        const held = await pidFileBody(pid);
        try {
            await writeFile(runPidPath, held);
            const said: string[] = [];

            // Proves the guard runs first: everything past it reads config, dials sandboxes, and calls ensureMutagen(),
            // which
            // would try to download a release here.
            await runForeground((message) => said.push(message));

            expect(said.join("\n")).toContain(`already running (pid ${pid})`);
            // The incumbent keeps the pidfile: a refusing loop must not stamp its own pid over it.
            expect((await readFile(runPidPath, "utf8")).trim()).toBe(held);
        } finally {
            other.kill("SIGKILL");
        }
    });

    // A pidfile outlives the boot that wrote it, and pids restart low, so yesterday's watcher pid can be an unrelated
    // process this morning; only the boot stamp says whether a live pid is really this loop's.
    it("starts when the pidfile is from an earlier boot, however alive that pid happens to be now", async () => {
        const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        const pid = other.pid;
        if (pid === undefined) {
            throw new Error("the stand-in loop didn't start");
        }
        try {
            await writeFile(runPidPath, `${pid} id:0f9a1c3e-0000-4000-8000-000000000000`);

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
    });
});

describe("stopResident", () => {
    it("returns only once the loop is GONE, not merely signalled", async () => {
        // Shaped like the real loop: handles SIGTERM and takes a moment to wind down. An instant-dying stand-in
        // couldn't
        // distinguish "waited for it" from "signalled and moved on".
        const resident = spawn(
            process.execPath,
            ["-e", 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000); console.log("ready")'],
            { detached: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        const pid = resident.pid;
        if (pid === undefined || resident.stdout === null) {
            throw new Error("the stand-in loop didn't start");
        }
        // Waits for the handler to be installed: signalling a still-booting process kills it outright, silently turning
        // this into a test that passes either way.
        await new Promise((ready) => resident.stdout?.once("data", ready));
        await writeFile(runPidPath, await pidFileBody(pid));

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
