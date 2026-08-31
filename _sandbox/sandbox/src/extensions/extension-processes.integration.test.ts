import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { listenerContribution, testConfig } from "../testing.js";
import { readWorkspaceFile } from "../workspace/workspace-files.js";
import { extensionProcessIndex, extensionProcessKey, reconcileListenerProcesses, startAllExtensionProcesses } from "./extension-processes.js";

const GATEWAY_KEY = extensionProcessKey("intentic.discord", "gateway");

const discordManifest = {
    publisher: "intentic",
    name: "discord",
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
    contributes: {
        listener: listenerContribution("discord", ["message"]),
        processes: [{ name: "gateway", command: "node dist/gateway.js", autoStart: true }],
    },
};

const plainManifest = {
    publisher: "acme",
    name: "tool",
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
    contributes: { processes: [{ name: "watcher", command: "node watch.js", autoStart: true }] },
};

const writeManifest = async (dir: string, body: object): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(body));
};

// A recording service-supervisor fake + the narrow Services slice the extension-process functions touch.
const fakeServices = (extensionsDir: string, automations: AutomationRecord[], capabilities: Capability[]) => {
    const started: string[] = [];
    const stopped: string[] = [];
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "ext-proc-work-")) }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        automations: unstubbed<Services["automations"]>("automations", { list: async () => automations }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        config: { ...testConfig, extensionsDir },
        panelToken: "panel-token",
        serviceProcesses: unstubbed<Services["serviceProcesses"]>("serviceProcesses", {
            start: async (key) => {
                started.push(key);
            },
            stop: (key) => {
                stopped.push(key);
            },
            portOf: () => undefined,
        }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, error: () => {} }),
    });
    return { services, started, stopped };
};

const listenerAutomation = (id: string): AutomationRecord => ({
    id,
    trigger: { kind: "listener", provider: "discord" },
    prompt: "p",
    enabled: true,
    runs: [],
});

const discordConnector: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } };

test("boot skips a listener extension's autoStart processes while its provider is unwanted", async () => {
    const baked = mkdtempSync(join(tmpdir(), "ext-proc-baked-"));
    await writeManifest(join(baked, "intentic.discord"), discordManifest);
    const { services, started } = fakeServices(baked, [], []);
    await startAllExtensionProcesses(services);
    expect(started).toEqual([]);
});

test("boot starts a listener extension's autoStart processes once a connector (or automation) exists", async () => {
    const baked = mkdtempSync(join(tmpdir(), "ext-proc-baked-"));
    await writeManifest(join(baked, "intentic.discord"), discordManifest);
    const withConnector = fakeServices(baked, [], [discordConnector]);
    await startAllExtensionProcesses(withConnector.services);
    expect(withConnector.started).toEqual([GATEWAY_KEY]);

    const withAutomation = fakeServices(baked, [listenerAutomation("a")], []);
    await startAllExtensionProcesses(withAutomation.services);
    expect(withAutomation.started).toEqual([GATEWAY_KEY]);
});

test("a non-listener extension's autoStart processes start unconditionally", async () => {
    const baked = mkdtempSync(join(tmpdir(), "ext-proc-baked-"));
    await writeManifest(join(baked, "acme.tool"), plainManifest);
    const { services, started } = fakeServices(baked, [], []);
    await startAllExtensionProcesses(services);
    expect(started).toEqual([extensionProcessKey("acme.tool", "watcher")]);
});

test("reconcile starts a wanted gateway and stops an unwanted one", async () => {
    const baked = mkdtempSync(join(tmpdir(), "ext-proc-baked-"));
    await writeManifest(join(baked, "intentic.discord"), discordManifest);
    const wanted = fakeServices(baked, [], [discordConnector]);
    await reconcileListenerProcesses(wanted.services);
    expect(wanted.started).toEqual([GATEWAY_KEY]);

    // Stop is unconditional on the unwanted side: the supervisor's stop is a no-op for an untracked key, so
    // there is no "is it running" question to get wrong here (the old tmux path had one, and lost to it).
    const unwanted = fakeServices(baked, [], []);
    await reconcileListenerProcesses(unwanted.services);
    expect(unwanted.started).toEqual([]);
    expect(unwanted.stopped).toEqual([GATEWAY_KEY]);
});

test("extensionProcessIndex maps each declared process's panel key to its extension id + process name", async () => {
    const baked = mkdtempSync(join(tmpdir(), "ext-proc-baked-"));
    await writeManifest(join(baked, "intentic.discord"), discordManifest);
    await writeManifest(join(baked, "acme.tool"), plainManifest);
    const { services } = fakeServices(baked, [], []);
    const index = await extensionProcessIndex(services);
    expect(index.get(GATEWAY_KEY)).toEqual({ extensionId: "intentic.discord", processName: "gateway" });
    expect(index.get(extensionProcessKey("acme.tool", "watcher"))).toEqual({ extensionId: "acme.tool", processName: "watcher" });
});
