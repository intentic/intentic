import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionApiVersion } from "@intentic/extension-api";
import { declaredReachOf } from "@intentic/extension-manifest";
import type { Automation, AutomationRun } from "@intentic/sandbox-contract/schemas/automations";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { refuseForeignExtensionTarget } from "../../automations/watch/extension-target.js";
import type { AutomationRecord } from "../../automations/automations-store.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { createBackendHostApp } from "./backend-host.js";
import { fireExtension, owedFires, owedFiresInFlight } from "./extension-fires.js";

// An automation that wakes an extension's code (extension-fires.ts): handed through the real backend host's door to the
// handler a real server bundle registered, kept while the backend is down and handed over once it is back, across a
// daemon restart too; and saved only by the extension it names (automations/watch/extension-target.ts, which every save of an
// automation runs: automation-save.ts).

const HOST_TOKEN = "host-token";
const BUNDLE = `export const activateServer = (api) => {
    api.automations.onFire("sweep", (fire) => {
        if (fire.payload === "boom") throw new Error("the probe lane is wedged");
        globalThis.firedInTest.push(fire);
    });
    return { deactivate: () => {} };
};
`;

declare global {
    // The fires the test bundle's handler took, where the test reads them.
    var firedInTest: unknown[];
}

const setup = () => {
    globalThis.firedInTest = [];
    const root = mkdtempSync(join(tmpdir(), "extension-fires-"));
    const extensionsDir = join(root, "extensions");
    const write = (name: string, permissions: object): void => {
        mkdirSync(join(extensionsDir, name, "dist"), { recursive: true });
        const manifest = { publisher: "acme", name, version: "1.0.0", engines: { intentic: "^2.50.0" }, server: "dist/server.js", permissions };
        writeFileSync(join(extensionsDir, name, "intentic-extension.json"), JSON.stringify(manifest));
        writeFileSync(join(extensionsDir, name, "dist/server.js"), BUNDLE);
    };
    write("maintenance", { fires: ["sweep"] });
    write("plain", {});
    const runs: { readonly id: string; readonly run: AutomationRun }[] = [];
    let host: { readonly port: number; readonly hostToken: string } | undefined;
    const stored = new Map<string, AutomationRecord>();
    // A daemon: a fresh one after a "restart" shares the history and the extensions, nothing in memory.
    const daemon = () =>
        unstubbed<Services>("services", {
            config: { ...testConfig, extensionsDir, historyRoot: join(root, "history") },
            workspace: unstubbed<Services["workspace"]>("workspace", { root }),
            files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
            capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
            logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, info: () => {} }),
            extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", {
                proxyTarget: () => host,
                status: () => ({ state: "starting", extensions: [] }),
            }),
            automations: unstubbed<Services["automations"]>("automations", {
                recordRun: async (id, run) => void runs.push({ id, run }),
                get: async (id) => stored.get(id),
            }),
        });
    // The backend host, as the supervisor runs it, serving the two extensions' bundles.
    const startHost = async (): Promise<() => Promise<void>> => {
        const app = await createBackendHostApp({
            port: 0,
            hostToken: HOST_TOKEN,
            daemonUrl: "http://127.0.0.1:1",
            workspaceRoot: root,
            apiVersion: extensionApiVersion,
            extensions: ["maintenance", "plain"].map((name) => ({
                id: `acme.${name}`,
                dir: join(extensionsDir, name),
                server: "dist/server.js",
                bundle: name,
                stateDir: join(root, "state", name),
                cacheDir: join(root, "cache", name),
                daemonToken: "t",
                daemonPermissions: [],
                declared: declaredReachOf(name === "maintenance" ? { fires: ["sweep"] } : {}),
                watchKinds: [],
            })),
        });
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        host = { port: server.port ?? 0, hostToken: HOST_TOKEN };
        return async () => {
            host = undefined;
            await app.drain();
            await server.stop(true);
        };
    };
    return { daemon, startHost, runs, stored };
};

const sweep = { extension: "acme.maintenance", handler: "sweep", automationId: "maintenance-sweep", prompt: "Sweep the probes." };

test("a fire is handed to the handler the backend registered", async () => {
    const { daemon, startHost } = setup();
    const stop = await startHost();
    try {
        expect(await fireExtension(daemon(), { ...sweep, id: "f1", payload: "{}" }, 1_000)).toEqual({ outcome: "completed", detail: `Handed to acme.maintenance's "sweep" handler.` });
        expect(globalThis.firedInTest).toEqual([{ id: "f1", automationId: "maintenance-sweep", handler: "sweep", firedAt: 1_000, coalesced: 0, payload: "{}", prompt: "Sweep the probes." }]);
    } finally {
        await stop();
    }
});

test("a fire made while the backend is down is kept, and handed over once it is back after a daemon restart", async () => {
    const { daemon, startHost, runs } = setup();
    const before = daemon();
    const [firstAt, secondAt] = [Date.now() - 60_000, Date.now() - 30_000];
    const first = await fireExtension(before, { ...sweep, id: "f1" }, firstAt);
    expect(first).toEqual({
        outcome: "carried",
        detail: `acme.maintenance's backend could not take it now (extension backends are starting); it is kept and handed over once it can.`,
    });
    // The clock ticks again while the backend is still down: one fire stands for both.
    expect(await fireExtension(before, { ...sweep, id: "f2" }, secondAt)).toMatchObject({ outcome: "carried" });
    expect((await owedFires(before)).map(({ id, coalesced }) => ({ id, coalesced }))).toEqual([{ id: "f2", coalesced: 1 }]);

    // The daemon restarts and its backend host comes up: the boot pass reads what was owed and hands it over.
    const stop = await startHost();
    try {
        const after = daemon();
        const left = await owedFiresInFlight.read(after);
        expect(left.count).toBe(1);
        await left.recover({ resume: true, asked: false });
        await waitFor(() => expect(globalThis.firedInTest).toHaveLength(1));
        expect(globalThis.firedInTest).toEqual([{ id: "f2", automationId: "maintenance-sweep", handler: "sweep", firedAt: secondAt, coalesced: 1, prompt: "Sweep the probes." }]);
        expect(await owedFires(after)).toEqual([]);
        expect(runs).toEqual([
            {
                id: "maintenance-sweep",
                run: expect.objectContaining({
                    outcome: "completed",
                    detail: `Handed to acme.maintenance's "sweep" handler once its backend was back (fired ${new Date(secondAt).toISOString()}). It stood for 1 earlier fire(s) made while the backend was down.`,
                }),
            },
        ]);
    } finally {
        await stop();
    }
});

test("a handler that throws is recorded as a failure and not tried again", async () => {
    const { daemon, startHost } = setup();
    const stop = await startHost();
    try {
        const services = daemon();
        expect(await fireExtension(services, { ...sweep, id: "f1", payload: "boom" })).toEqual({
            outcome: "error",
            detail: `acme.maintenance's "sweep" handler failed: {"error":"the probe lane is wedged"}`,
        });
        expect(await owedFires(services)).toEqual([]);
    } finally {
        await stop();
    }
});

test("a handler the extension does not declare is never woken, nor kept for later", async () => {
    const { daemon, startHost } = setup();
    const stop = await startHost();
    try {
        const services = daemon();
        expect(await fireExtension(services, { ...sweep, extension: "acme.plain", id: "f1" })).toEqual({
            outcome: "error",
            detail: `Nothing to wake: extension "acme.plain" does not declare a "sweep" handler in permissions.fires.`,
        });
        expect(globalThis.firedInTest).toEqual([]);
        expect(await owedFires(services)).toEqual([]);
    } finally {
        await stop();
    }
});

describe("who may point an automation at an extension's code", () => {
    const automation: Automation = {
        id: "maintenance-sweep",
        trigger: { kind: "once", at: Date.now() + 3_600_000 },
        target: { kind: "extension", extension: "acme.maintenance", handler: "sweep" },
        prompt: "Sweep the probes.",
        enabled: true,
    };

    test("the extension itself may", async () => {
        const { daemon } = setup();
        await expect(refuseForeignExtensionTarget(daemon(), automation, { extension: "acme.maintenance" })).resolves.toBeUndefined();
    });

    test("another extension may not, nor a person or a proposal pointing a new one there", async () => {
        const { daemon } = setup();
        const refusal = "only the extension acme.maintenance itself can point an automation at its own code; save it from that extension, or pick another target";
        await expect(refuseForeignExtensionTarget(daemon(), automation, { extension: "acme.plain" })).rejects.toThrow(refusal);
        await expect(refuseForeignExtensionTarget(daemon(), automation, {})).rejects.toThrow(refusal);
        await expect(refuseForeignExtensionTarget(daemon(), automation, undefined)).rejects.toThrow(refusal);
    });

    test("a person may edit one the extension saved, keeping its target", async () => {
        const { daemon, stored } = setup();
        stored.set(automation.id, { ...automation, runs: [] });
        await expect(refuseForeignExtensionTarget(daemon(), { ...automation, trigger: { kind: "once", at: Date.now() + 7_200_000 } }, {})).resolves.toBeUndefined();
        await expect(refuseForeignExtensionTarget(daemon(), { ...automation, target: { ...sweep, kind: "extension", handler: "nightly" } }, {})).rejects.toThrow(
            "only the extension acme.maintenance itself",
        );
    });

    test("a handler the extension does not declare is refused even to itself", async () => {
        const { daemon } = setup();
        await expect(
            refuseForeignExtensionTarget(daemon(), { ...automation, target: { kind: "extension", extension: "acme.maintenance", handler: "nightly" } }, { extension: "acme.maintenance" }),
        ).rejects.toThrow(`extension acme.maintenance is not enabled with a "nightly" handler in its permissions.fires`);
    });
});
