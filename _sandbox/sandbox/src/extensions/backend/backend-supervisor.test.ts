import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { advanceTimersByTimeAsync, stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import * as fsOriginal from "@intentic/base/fs";
import type { Logger } from "pino";
import * as workloadOriginal from "../../workload/workload-class.js";
import * as processGroupOriginal from "../../workload/process-group.js";
import * as installedOriginal from "../installed-extensions.js";
import type { ExtensionHost, InstalledExtension } from "../installed-extensions.js";
import * as listenerOriginal from "../listener/listener-state.js";

// The supervisor's converges racing each other and stop(), with the host, its port and its /health faked: which host
// runs, and when a wait ends, is decided at the awaits between them, which a real spawn is too slow to hit on purpose.

const extension = {
    id: "acme.echo",
    dir: "/nowhere/acme.echo",
    manifest: ExtensionManifestSchema.parse({ publisher: "acme", name: "echo", version: "1.0.0", engines: { intentic: "^2.1.0" }, server: "server.js" }),
    source: "workspace",
    enabled: true,
} as unknown as InstalledExtension;

// A host process that runs until told it died: killGroup is faked too, so a kill alone ends nothing, as with a host
// wedged in an extension's code for the length of the kill's grace.
type FakeHost = ChildProcess & { exitCode: number | null };
const fakeHost = (): FakeHost =>
    Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdout: null, stderr: null, pid: undefined }) as unknown as FakeHost;
const die = (host: FakeHost): void => {
    host.exitCode = 1;
    host.emit("exit", 1, null);
};

const hosts: FakeHost[] = [];
const spawnAs = jest.fn((): FakeHost => {
    const host = fakeHost();
    hosts.push(host);
    return host;
});
const freePort = jest.fn(async (): Promise<number> => 41_000);
const killGroup = jest.fn();
const enabledExtensions = jest.fn(async (): Promise<InstalledExtension[]> => [extension]);

jest.mock("../../workload/workload-class.js", () => ({ ...workloadOriginal, spawnAs: () => spawnAs() }));
jest.mock("@intentic/base/fs", () => ({ ...fsOriginal, freePort: () => freePort() }));
jest.mock("../../workload/process-group.js", () => ({ ...processGroupOriginal, killGroup: (child: ChildProcess) => killGroup(child) }));
jest.mock("../installed-extensions.js", () => ({ ...installedOriginal, enabledExtensions: () => enabledExtensions() }));
jest.mock("../listener/listener-state.js", () => ({
    ...listenerOriginal,
    listenerOwnershipOf: async () => ({ owners: new Map(), refused: new Map() }),
}));

// Loaded after the mocks: jest.mock binds at this point, and a static import would have already evaluated the graph.
const { createExtensionBackend } = await import("./backend-supervisor.js");

const healthy = (): Promise<Response> => Promise.resolve(Response.json({ ok: true, extensions: [{ id: extension.id, state: "running" }] }));
const refused = (): Promise<Response> => Promise.reject(new Error("connect ECONNREFUSED"));

const backends: ReturnType<typeof createExtensionBackend>[] = [];
const backendOf = (healthTimeoutMs = 60_000): ReturnType<typeof createExtensionBackend> => {
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
    const backend = createExtensionBackend(() => ({ workspace: { root: "/nowhere" } }) as ExtensionHost, 0, logger, { healthTimeoutMs });
    backends.push(backend);
    return backend;
};

beforeEach(() => {
    hosts.length = 0;
    spawnAs.mockClear();
    freePort.mockReset();
    freePort.mockImplementation(async () => 41_000);
    killGroup.mockReset();
    enabledExtensions.mockReset();
    enabledExtensions.mockImplementation(async () => [extension]);
    stubGlobal("fetch", jest.fn(healthy));
});

afterEach(() => {
    for (const backend of backends.splice(0)) {
        backend.stop();
    }
    jest.useRealTimers();
    unstubAllGlobals();
});

test("a stop while a converge waits for its port spawns no host behind it", async () => {
    const port = Promise.withResolvers<number>();
    freePort.mockImplementationOnce(() => port.promise);
    const backend = backendOf();
    const starting = backend.start();
    await waitFor(() => expect(freePort).toHaveBeenCalledTimes(1));

    backend.stop();
    port.resolve(41_000);
    await starting;
    // Spawned after stop(), the host would have been nobody's: stop() had already killed what it knew of.
    expect(spawnAs).not.toHaveBeenCalled();
    expect(backend.status()).toEqual({ state: "stopped", extensions: [] });
});

test("a converge superseded while it waits for its port leaves the newer one's host as the only one", async () => {
    const firstPort = Promise.withResolvers<number>();
    freePort.mockImplementationOnce(() => firstPort.promise).mockImplementationOnce(async () => 42_000);
    const backend = backendOf();
    const first = backend.start();
    await waitFor(() => expect(freePort).toHaveBeenCalledTimes(1));

    await backend.start();
    expect(backend.proxyTarget()?.port).toBe(42_000);
    firstPort.resolve(41_000);
    await first;
    // The first converge's host would have replaced the second's in `host`, leaving that one running unowned.
    expect(spawnAs).toHaveBeenCalledTimes(1);
    expect(backend.proxyTarget()?.port).toBe(42_000);
    expect(backend.status().state).toBe("running");
});

test("a stop ends the wait on /health at once, cutting the probe in flight", async () => {
    jest.useFakeTimers();
    // A host that takes the connection and never answers, the way one hung in an extension's activation does.
    const probes: AbortSignal[] = [];
    stubGlobal(
        "fetch",
        jest.fn((_url: string, init: RequestInit) => {
            const signal = init.signal as AbortSignal;
            probes.push(signal);
            return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }),
    );
    const backend = backendOf();
    let settled = false;
    const starting = backend.start().then(() => {
        settled = true;
    });
    await waitFor(() => expect(probes).toHaveLength(1));

    backend.stop();
    // No timer moves: the stop alone ends the wait, where it used to poll on until the host's exit or the health timeout.
    await waitFor(() => expect(settled).toBe(true));
    await starting;
    expect(probes[0]?.aborted).toBe(true);
    expect(probes).toHaveLength(1);
    expect(backend.status()).toEqual({ state: "stopped", extensions: [] });
});

test("a converge stopped while it reads the extensions does not report that read failing", async () => {
    const reading = Promise.withResolvers<InstalledExtension[]>();
    enabledExtensions.mockImplementationOnce(() => reading.promise);
    const backend = backendOf();
    const starting = backend.start();
    expect(enabledExtensions).toHaveBeenCalledTimes(1);

    backend.stop();
    reading.reject(new Error("settings unreadable"));
    await starting;
    expect(backend.status()).toEqual({ state: "stopped", extensions: [] });
});

test("two retries scheduled before either fires leave one, and stop() leaves none", async () => {
    jest.useFakeTimers();
    const backend = backendOf(100);
    await backend.start();
    expect(hosts).toHaveLength(1);

    // The next converge's read is held until the running host has died under it, which schedules the first retry.
    const reading = Promise.withResolvers<InstalledExtension[]>();
    enabledExtensions.mockImplementationOnce(() => reading.promise);
    backend.restart();
    await advanceTimersByTimeAsync(300);
    expect(enabledExtensions).toHaveBeenCalledTimes(2);
    die(hosts[0]!);
    // The host it spawns in place never answers, so it is killed and the second retry scheduled.
    stubGlobal("fetch", jest.fn(refused));
    reading.resolve([extension]);
    await waitFor(() => expect(hosts).toHaveLength(2));
    await advanceTimersByTimeAsync(500);
    expect(backend.status()).toMatchObject({ state: "error", detail: expect.stringContaining("did not become healthy") });

    backend.stop();
    await advanceTimersByTimeAsync(60_000);
    // A converge starting reads the extensions first: the first retry, overwritten rather than cleared, used to fire
    // here, after stop(), and go on to spawn a host.
    expect(enabledExtensions).toHaveBeenCalledTimes(2);
});
