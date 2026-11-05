import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createServices, type Services, servicesTeardown } from "./composition.js";
import { NO_LOG_FILES } from "./logger.js";
import { leafTeardown } from "./bootstrap/slices/slice-registry.js";
import { statePath } from "./state-paths.js";
import { testConfig } from "./env.config.testing.js";
import { capabilitiesDocument, fileCapabilitiesStore } from "./capabilities/capabilities-store.js";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";

// The real composition over temp roots: every slice builder runs in its order, and the services that read the finished
// daemon per call (composition.ts, `whole`) answer once it has returned instead of reaching a binding never made.
const base = mkdtempSync(join(tmpdir(), "composition-"));
const workspaceRoot = join(base, "work");
const historyRoot = join(base, "history");
mkdirSync(workspaceRoot);
mkdirSync(historyRoot);
const services: Services = createServices({ ...testConfig, workspaceRoot, historyRoot }, pino({ level: "silent" }));

afterAll(async () => {
    // The same stops main() registers at shutdown for what composing starts on its own clock.
    for (const stop of servicesTeardown(services)) {
        await stop();
    }
    rmSync(base, { recursive: true, force: true });
});

test("the slices are built over the configured roots", () => {
    expect(services.workspace.root).toBe(workspaceRoot);
    expect(services.workspaceScope.main).toBe(workspaceRoot);
    expect(services.authRoot).toBe(statePath(workspaceRoot, ".intentic/secrets/auth/"));
});

test("composed secret host metadata uses connector manifests without reading hydrated capabilities", async () => {
    const workspace = join(base, "metadata-work");
    const history = join(base, "metadata-history");
    const extensions = join(base, "metadata-extensions");
    const extension = join(extensions, "service");
    mkdirSync(workspace);
    mkdirSync(history);
    mkdirSync(extension, { recursive: true });
    const manifest = ExtensionManifestSchema.parse({
        publisher: "example", name: "service", version: "1.0.0", engines: { intentic: "*" },
        contributes: { capabilities: [{
            kind: "cli", id: "service", catalog: { name: "Service", description: "Fixture service", category: "test" },
            fields: [{ key: "token", label: "Token", secret: true }], env: {}, skill: "SKILL.md", hosts: ["api.example.com"],
        }] },
    });
    writeFileSync(join(extension, "intentic-extension.json"), JSON.stringify(manifest));
    const raw = fileCapabilitiesStore(join(workspace, capabilitiesDocument.path));
    await raw.upsert({ id: "service", kind: "cli", config: { provider: "service" } });
    const composer = createServices({ ...testConfig, workspaceRoot: workspace, historyRoot: history, extensionsDir: extensions },
        pino({ level: "silent" }), NO_LOG_FILES);
    const hydrated = jest.spyOn(composer.capabilities, "list").mockRejectedValue(new Error("must not hydrate credentials"));
    try {
        expect(await composer.hostGuards.metadata?.()).toEqual([
            { kind: "capability", subject: "service", guard: true, hosts: ["api.example.com"], source: "connector" },
        ]);
        expect(hydrated).not.toHaveBeenCalled();
        await expect(composer.hostGuards()).rejects.toThrow("must not hydrate credentials");
    } finally {
        hydrated.mockRestore();
        for (const stop of servicesTeardown(composer)) { await stop(); }
    }
});

test("the late seams answer once composing has returned", async () => {
    expect(Object.keys(await services.providerReadiness()).sort()).toEqual(services.providerModules.map((module) => module.id).sort());
    expect(Object.keys(services.providerCatalogs).sort()).toEqual(services.providerModules.map((module) => module.id).sort());
    expect(await services.hostReach([])).toBeUndefined();
    expect(await services.webextReach([])).toBeUndefined();
    expect(await services.phoneReach([])).toBeUndefined();
    expect(services.outboxStreamFor(undefined)).toBeUndefined();
    expect(services.reach.status()).toEqual({ state: "off" });
});

test("the leaf slices are composed beside the core, with the stops of those that start something", () => {
    expect(Object.keys(services)).toEqual(
        expect.arrayContaining(["git", "hostHub", "linkedChildren", "loops", "workflows", "needs", "orgPolicy", "history", "shares", "walletLedger"]),
    );
    expect(leafTeardown(services)).toHaveLength(1);
});

// The target image's composer composes over read-only mounts of the running sandbox's volumes (compose-overlay.ts): a
// log file opened there fails after composing returns, as an 'error' event that ends the process (2026-10-21).
test("composed without log files, the services open none under the history root", async () => {
    const history = join(base, "history-read-only");
    mkdirSync(history);
    const composer = createServices({ ...testConfig, workspaceRoot, historyRoot: history }, pino({ level: "silent" }), NO_LOG_FILES);
    try {
        // A log file is opened only after its directory is made, at once, where the open itself comes a turn later.
        expect(existsSync(join(history, "logs"))).toBe(false);
        expect(composer.clientLogger).toBeUndefined();
    } finally {
        for (const stop of servicesTeardown(composer)) {
            await stop();
        }
    }
});
