import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import * as fsOriginal from "@intentic/base/fs";
import type { Logger } from "pino";
import * as workloadOriginal from "../../workload/workload-class.js";
import * as processGroupOriginal from "../../workload/process-group.js";
import * as installedOriginal from "../installed-extensions.js";
import type { ExtensionHost, InstalledExtension } from "../installed-extensions.js";
import * as listenerOriginal from "../listener/listener-state.js";

// A converge superseded while its in-place reload is in flight: the host takes that reload whether or not anyone still
// wants it, so the newer converge must compare against what the host really runs, and move it back.

const root = mkdtempSync(join(tmpdir(), "supervisor-reload-"));
const manifest = ExtensionManifestSchema.parse({ publisher: "acme", name: "echo", version: "1.0.0", engines: { intentic: "^2.1.0" }, server: "server.js" });
const v1 = { id: "acme.echo", dir: `${root}/acme.echo-v1`, manifest, source: "workspace", enabled: true } as unknown as InstalledExtension;
const v2 = { id: "acme.echo", dir: `${root}/acme.echo-v2`, manifest, source: "workspace", enabled: true } as unknown as InstalledExtension;

type FakeHost = ChildProcess & { exitCode: number | null };
const hosts: FakeHost[] = [];
const spawnAs = jest.fn((): FakeHost => {
    const host = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdout: null, stderr: null, pid: undefined }) as unknown as FakeHost;
    hosts.push(host);
    return host;
});
let enabled: InstalledExtension[] = [v1];

jest.mock("../../workload/workload-class.js", () => ({ ...workloadOriginal, spawnAs: () => spawnAs() }));
jest.mock("@intentic/base/fs", () => ({ ...fsOriginal, freePort: async () => 41_000 }));
jest.mock("../../workload/process-group.js", () => ({ ...processGroupOriginal, killGroup: () => {} }));
jest.mock("../installed-extensions.js", () => ({ ...installedOriginal, enabledExtensions: async () => enabled }));
jest.mock("../listener/listener-state.js", () => ({
    ...listenerOriginal,
    listenerOwnershipOf: async () => ({ owners: new Map(), refused: new Map() }),
}));

const { createExtensionBackend } = await import("./backend-supervisor.js");

afterEach(() => {
    unstubAllGlobals();
});

test("a reload the host took for a superseded converge is recorded, so the newer converge moves the host back to what is wanted", async () => {
    // What the host process actually runs, as the fake host's /reload would leave it.
    let hostRuns = v1.dir;
    const reloads: { dir: string; answer: PromiseWithResolvers<void> }[] = [];
    stubGlobal(
        "fetch",
        jest.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/reload")) {
                const body = JSON.parse(String(init?.body)) as { extensions: { dir: string }[] };
                const dir = body.extensions[0]?.dir ?? "";
                const answer = Promise.withResolvers<void>();
                reloads.push({ dir, answer });
                // The host deactivates and activates in place; it answers once the backend's activate returns.
                await answer.promise;
                hostRuns = dir;
            }
            return Response.json({ ok: true, extensions: [{ id: "acme.echo", state: "running", reloadable: true }] });
        }),
    );
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
    const backend = createExtensionBackend(() => ({ workspace: { root } }) as ExtensionHost, 0, logger, { healthTimeoutMs: 60_000 });
    try {
        await backend.start();
        expect(hosts).toHaveLength(1);
        expect(backend.status().state).toBe("running");

        // The owner updates the extension: converge A reloads v2 in place, and v2's activate takes a while.
        enabled = [v2];
        backend.restart();
        await waitFor(() => expect(reloads).toHaveLength(1));

        // Meanwhile the owner rolls the update back: converge B supersedes A, and waits for A to end before reading the host.
        enabled = [v1];
        backend.restart();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(reloads).toHaveLength(1);
        // A's reload now lands on the host.
        reloads[0]?.answer.resolve();
        await waitFor(() => expect(hostRuns).toBe(v2.dir));
        // B finds the host on v2 and reloads it back to v1.
        await waitFor(() => expect(reloads).toHaveLength(2));
        expect(reloads[1]?.dir).toBe(v1.dir);
        reloads[1]?.answer.resolve();
        await waitFor(() => expect(hostRuns).toBe(v1.dir));
        await waitFor(() => expect(backend.status().state).toBe("running"));

        // A later converge on the same set reads it as running, rightly now, and sends nothing.
        backend.restart();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(reloads).toHaveLength(2);
        expect(hosts).toHaveLength(1);
    } finally {
        for (const pending of reloads) {
            pending.answer.resolve();
        }
        backend.stop();
    }
});
