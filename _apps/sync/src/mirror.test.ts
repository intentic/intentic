import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PortSummary } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MirroredPort } from "./config.js";
import type { ForwardExecutor } from "./mirror.js";

// config.ts derives its paths from homedir() at import time, so point HOME at a throwaway dir BEFORE importing
// (dynamic import, after the env is set) — then mirror.pid lands in temp, not the real ~/.intentic/sync.
process.env.HOME = mkdtempSync(join(tmpdir(), "sync-mirror-"));
process.env.USERPROFILE = process.env.HOME;
const { mirrorPidPath } = await import("./config.js");
const { fetchWorkspacePorts, reconcileForwards, readLiveWatcherPid, SyncAuthError } = await import("./mirror.js");
const { forwardSessionName, mutagenForwardArgs } = await import("./mutagen.js");
// setup() creates ~/.intentic/sync via writeConfig; the pidfile test writes there directly, so make it first.
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
    command,
    forwarded: false,
});

// A recording executor so the reconcile logic tests without Mutagen — `free` decides the local-bind check.
const fakeExecutor = (free: (port: number) => boolean = () => true): { executor: ForwardExecutor; created: number[]; terminated: number[] } => {
    const created: number[] = [];
    const terminated: number[] = [];
    return {
        created,
        terminated,
        executor: {
            terminate: (port) => void terminated.push(port),
            create: (summary) => void created.push(summary.port),
            isLocalPortFree: (port) => Promise.resolve(free(port)),
        },
    };
};

const log = (): void => {};

describe("fetchWorkspacePorts", () => {
    it("sends the sync token and returns only forwardable workspace-kind ports", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            jsonResponse(200, {
                ports: [
                    { port: 47145, host: "::1", forwardable: true, kind: "workspace", command: "vite", forwarded: false },
                    { port: 4096, host: "127.0.0.1", forwardable: true, kind: "system", command: "opencode serve", forwarded: false },
                    // A workspace bind on a loopback alias — Mutagen would dial 127.0.0.1 and never reach it, so it's dropped.
                    { port: 9500, host: "127.0.0.1", forwardable: false, kind: "workspace", command: "alias-bound", forwarded: false },
                ],
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const ports = await fetchWorkspacePorts("https://sandbox-abc.example.dev/", "ist_tok");

        expect(ports).toEqual([{ port: 47145, host: "::1", forwardable: true, kind: "workspace", command: "vite", forwarded: false }]);
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

    it("types 401/403 as SyncAuthError — what the watcher counts toward revocation self-teardown", async () => {
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toBeInstanceOf(SyncAuthError);
        vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 })));
        await expect(fetchWorkspacePorts("https://s.example.dev", "ist_old")).rejects.toBeInstanceOf(SyncAuthError);
        // A 5xx (tunnel blip) must NOT read as revocation — the watcher retries those forever.
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
        const next = await reconcileForwards(executor, current, [ws(3000), ws(4321)], log);
        expect(next).toEqual([
            { port: 3000, host: "127.0.0.1" },
            { port: 4321, host: "127.0.0.1" },
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
        const next = await reconcileForwards(executor, current, [ws(3000)], log);
        expect(next).toEqual([{ port: 3000, host: "127.0.0.1" }]);
        expect(created).toEqual([]);
        expect(terminated).toEqual([4321]);
    });

    it("recreates a forward whose sandbox loopback family moved (127.0.0.1 → ::1)", async () => {
        const { executor, created, terminated } = fakeExecutor();
        const next = await reconcileForwards(executor, [{ port: 3000, host: "127.0.0.1" }], [ws(3000, "::1")], log);
        expect(next).toEqual([{ port: 3000, host: "::1" }]);
        expect(terminated).toEqual([3000]);
        expect(created).toEqual([3000]);
    });

    it("skips a port a foreign local process already holds", async () => {
        const { executor, created } = fakeExecutor((port) => port !== 5000);
        const next = await reconcileForwards(executor, [], [ws(5000)], log);
        expect(next).toEqual([]);
        expect(created).toEqual([]);
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
