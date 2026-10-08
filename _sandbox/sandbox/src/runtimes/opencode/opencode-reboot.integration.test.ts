import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import { SPAWN_STAMP_ENV } from "../../workload/workload-class.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { createOpenCodeService, type OpenCodeGeminiConfig, type OpenCodeService } from "./opencode.js";
import type { OpenCodeConfig } from "./opencode-config.js";
import { processAlive, type ServedServer, type ServeRequest } from "./opencode-serve.js";
import { opt } from "../../opt.js";

// The service's lifecycle against real processes: a child stands in for `opencode serve`, stamped as the real spawn
// stamps it, so the service's exit wait, its grace kill and its exit listener all meet a real pid. The client is a fake
// whose one event stream connects at once and stays open; the fake-only lifecycle is opencode.test.ts.

// The service's data root: never created, since the spawn is a fake and the catalog file boot looks for is absent.
const XDG = "/nonexistent/opencode-env/xdg";

const linuxPid = requires(process.platform === "linux", "Linux /proc for the service-owned server PID");

// Bun's spawn can return a moment before the child runs its program, while /proc still shows the environment and the
// signal dispositions of the process it was forked from. Holding the stand-in's spawn until `sleep` runs means its
// stamp is in its environ and a shell's `trap` is installed before the service can signal it; synchronously, since
// nothing may run between the spawn and the hand-back.
const runningSleep = (pid: number): void => {
    const deadline = Date.now() + 5_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
        try {
            if (readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0")[0] === "sleep") {
                return;
            }
        } catch {
            // allow(silent-catch): not listed yet, so asked again after the pause
        }
        Atomics.wait(pause, 0, 0, 1);
    }
};

const ended = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

const killOwned = async (child: ChildProcess): Promise<void> => {
    if (ended(child)) {
        return;
    }
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    child.kill("SIGKILL");
    await exited.promise;
};

const CONNECTED: OpenCodeEvent = { id: "evt_connected", type: "server.connected", data: {} };

// A client whose server-wide stream says it is connected and then stays open until the service closes it: the service
// needs nothing else from a client to boot.
const connectedClient = (): OpenCodeClient =>
    unstubbed<OpenCodeClient>("opencode client", {
        event: unstubbed<OpenCodeClient["event"]>("opencode client.event", {
            subscribe: (options) =>
                (async function* () {
                    yield CONNECTED;
                    const signal = options?.signal;
                    if (signal !== undefined && !signal.aborted) {
                        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                    }
                })(),
        }),
    });

interface StandIn {
    readonly child: ChildProcess;
    readonly request: ServeRequest;
    readonly config: OpenCodeConfig;
}

// What `opencode serve` would be for the service: a real child carrying a fresh spawn stamp, its pid and stamp handed
// back as the served process, its exit reported to `onExit` listeners as the real spawn reports it. `close` is the
// test's: what the server does on SIGTERM is what each scenario is about.
const standInServer = (
    request: ServeRequest,
    script: readonly string[],
    close: (child: ChildProcess) => void,
) => {
    const stamp = randomUUID();
    const [program = "sleep", ...args] = script;
    const child = spawnChild(program, args, { stdio: "ignore", env: { ...process.env, [SPAWN_STAMP_ENV]: stamp } });
    runningSleep(child.pid ?? 0);
    const summary = (): string => `OpenCode's server exited (${child.signalCode ?? `code ${String(child.exitCode)}`}).`;
    // SAFETY: the service writes OPENCODE_CONFIG_CONTENT as the JSON of the OpenCodeConfig it built (serverConfig).
    const config = JSON.parse(request.env["OPENCODE_CONFIG_CONTENT"] ?? "") as OpenCodeConfig;
    const standIn: StandIn = { child, request, config };
    return {
        standIn,
        served: {
            url: `http://127.0.0.1:${String(child.pid ?? 0)}`,
            headers: { authorization: "Basic stand-in" },
            process: child.pid === undefined ? undefined : { pid: child.pid, stamp },
            close: () => close(child),
            onExit: (listener) => {
                if (ended(child)) {
                    listener(summary());
                } else {
                    child.once("exit", () => listener(summary()));
                }
            },
        } satisfies ServedServer,
    };
};

const services: OpenCodeService[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
    await Promise.all(children.splice(0).map(killOwned));
    await Promise.all(services.splice(0).map((service) => service.stop()));
});

// The service with stand-in servers: `sleep 60` by default, closed by SIGTERM unless the scenario says otherwise.
const standInRuntime = (
    options: {
        readonly gemini?: OpenCodeGeminiConfig;
        readonly script?: readonly string[];
        readonly close?: (child: ChildProcess, index: number) => void;
        readonly beforeSpawn?: (index: number) => void;
    } = {},
) => {
    const standIns: StandIn[] = [];
    const service = createOpenCodeService(XDG, {
        ...opt("gemini", options.gemini),
        spawnServer: async (request) => {
            const index = standIns.length;
            options.beforeSpawn?.(index);
            const { served, standIn } = standInServer(request, options.script ?? ["sleep", "60"], (child) =>
                options.close === undefined ? child.kill("SIGTERM") : options.close(child, index),
            );
            standIns.push(standIn);
            children.push(standIn.child);
            return served;
        },
        makeClient: connectedClient,
    });
    services.push(service);
    const child = (index: number): ChildProcess => {
        const standIn = standIns[index];
        if (standIn === undefined) {
            throw new Error(`the service spawned ${String(standIns.length)} servers, not ${String(index + 1)}`);
        }
        return standIn.child;
    };
    return { service, standIns, child };
};

const OLD_MODEL = { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] } as const;
const NEW_MODEL = { id: "claude-opus-5-5-high", inputModalities: ["text", "image"] } as const;
const NEW_SELECTION = { providerID: OPENCODE_GEMINI_PROVIDER, modelID: NEW_MODEL.id };
const geminiModel = (id: string) => ({ name: id, capabilities: { tools: true, input: ["text", "image"], output: ["text"] } });

// The OOM killer took `opencode serve` and the daemon kept handing out its client, so every Gemini turn after failed on
// a bare "fetch failed" until a restart. The real spawn reports the exit; the service must forget the server on it.
test.skipIf(!linuxPid.runs)(linuxPid.title("a server that died under a booted client is booted afresh by the next call"), async () => {
    const fake = standInRuntime();
    const first = await fake.service.client();
    expect(await fake.service.client()).toBe(first);
    expect(fake.standIns).toHaveLength(1);

    await killOwned(fake.child(0));
    expect(processAlive(fake.child(0).pid ?? 0)).toBe(false);

    const next = await fake.service.client();
    expect(next).not.toBe(first);
    expect(fake.standIns).toHaveLength(2);
    expect(processAlive(fake.child(1).pid ?? 0)).toBe(true);
});

// A stopped server's close signals but does not wait for the exit. The first child stays alive until the test ends it, so
// a replacement must neither spawn while it runs nor let a raw client probe boot a different catalog in the meantime.
test.skipIf(!linuxPid.runs)(
    linuxPid.title("catalog replacement waits for its owned process to exit and raw probes share its exact snapshot"),
    async () => {
        const closing = Promise.withResolvers<void>();
        const probe = Promise.withResolvers<OpenCodeClient>();
        const models = jest.fn<OpenCodeGeminiConfig["models"]>().mockResolvedValue([OLD_MODEL]);
        const alive: boolean[] = [];
        const fake = standInRuntime({
            gemini: { baseUrl: "http://127.0.0.1:8789", token: "test", models },
            close: (child, index) => {
                // Only the refresh closes the first server: a raw client call made right then must wait for the
                // replacement rather than boot a catalog of its own.
                if (index === 0) {
                    probe.resolve(fake.service.client());
                    closing.resolve();
                } else {
                    child.kill("SIGTERM");
                }
            },
            beforeSpawn: (index) => {
                if (index > 0) {
                    alive.push(processAlive(fake.child(0).pid ?? 0));
                }
            },
        });
        const previous = await fake.service.client();
        models.mockClear();
        // Another discovery would still list the old rows: every caller must share this replacement's exact read.
        models.mockResolvedValueOnce([OLD_MODEL, NEW_MODEL]);

        const acquiring = fake.service.acquire(NEW_SELECTION);
        await closing.promise;
        expect(processAlive(fake.child(0).pid ?? 0)).toBe(true);
        expect(fake.standIns).toHaveLength(1);

        await killOwned(fake.child(0));
        const lease = await acquiring;

        expect(await probe.promise).toBe(lease.client);
        expect(lease.client).not.toBe(previous);
        expect(fake.standIns).toHaveLength(2);
        // The replacement spawned only once the first was gone.
        expect(alive).toEqual([false]);
        expect(models).toHaveBeenCalledTimes(1);
        expect(fake.standIns[1]?.config.providers?.[OPENCODE_GEMINI_PROVIDER]?.models).toEqual({
            [OLD_MODEL.id]: geminiModel(OLD_MODEL.id),
            [NEW_MODEL.id]: geminiModel(NEW_MODEL.id),
        });
        lease.release();
    },
);

test.skipIf(!linuxPid.runs)(linuxPid.title("a timed-out shutdown stays retryable without spawning onto the still-running process"), async () => {
    const models = jest.fn<OpenCodeGeminiConfig["models"]>().mockResolvedValue([OLD_MODEL]);
    // The first server ignores its close, as one stuck in its own shutdown would.
    const fake = standInRuntime({
        gemini: { baseUrl: "http://127.0.0.1:8789", token: "test", models },
        close: (child, index) => {
            if (index > 0) {
                child.kill("SIGTERM");
            }
        },
    });
    let restoreClock: (() => void) | undefined;
    try {
        await fake.service.client();
        models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        // Move the deadline clock, not the child or a timer: the stop's ten-second bound passes at its first look, before
        // its grace kill, so the bound is tested without ten seconds of waiting.
        let now = Date.now();
        const clock = jest.spyOn(Date, "now").mockImplementation(() => {
            now += 10_001;
            return now;
        });
        restoreClock = () => clock.mockRestore();
        const failure = new Error("OpenCode's previous runtime has not finished stopping. Retry once it exits.");

        await expect(fake.service.acquire(NEW_SELECTION)).rejects.toThrow(failure);
        await expect(fake.service.client()).rejects.toThrow(failure);
        expect(processAlive(fake.child(0).pid ?? 0)).toBe(true);
        expect(fake.standIns).toHaveLength(1);

        restoreClock();
        restoreClock = undefined;
        await killOwned(fake.child(0));
        const retry = await fake.service.acquire(NEW_SELECTION);

        expect(fake.standIns).toHaveLength(2);
        expect(Object.keys(fake.standIns[1]?.config.providers?.[OPENCODE_GEMINI_PROVIDER]?.models ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id]);
        retry.release();
    } finally {
        restoreClock?.();
    }
});

// On CI the real server ran the signal handlers it had installed on SIGTERM and stayed up, so every stop timed out and
// nothing could boot again. A stand-in that ignores SIGTERM outright is the same server to the service; it carries the
// boot's stamp, which is what lets the grace kill reach it.
test.skipIf(!linuxPid.runs)(
    linuxPid.title("a server that outlives SIGTERM is killed after the grace, and the next call boots afresh"),
    async () => {
        // An ignored signal stays ignored across exec, so `sleep` keeps the shell's pid and its deafness to SIGTERM.
        const fake = standInRuntime({ script: ["sh", "-c", "trap '' TERM; exec sleep 60"] });
        await fake.service.client();
        const first = fake.child(0);
        const exited = new Promise<NodeJS.Signals | null>((resolve) => first.once("exit", (_code, signal) => resolve(signal)));

        await fake.service.stop();

        expect(await exited).toBe("SIGKILL");
        await fake.service.client();
        expect(fake.standIns).toHaveLength(2);
    },
    // A hang bound, far above the three-second grace the stop waits out before its kill.
    30_000,
);
