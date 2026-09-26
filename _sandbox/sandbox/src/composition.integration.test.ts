import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createServices, type Services } from "./composition.js";
import { statePath } from "./state-paths.js";
import { testConfig } from "./testing.js";

// The real composition over temp roots: every slice builder runs in its order, and the services that read the finished
// daemon per call (composition.ts, `whole`) answer once it has returned instead of reaching a binding never made.
const base = mkdtempSync(join(tmpdir(), "composition-"));
const workspaceRoot = join(base, "work");
const historyRoot = join(base, "history");
mkdirSync(workspaceRoot);
mkdirSync(historyRoot);
const services: Services = createServices({ ...testConfig, workspaceRoot, historyRoot }, pino({ level: "silent" }));

afterAll(() => {
    // What main() stops at shutdown of what composing starts on its own clock.
    services.resources.stop();
    services.perf.stop();
    services.ciHooks.stop();
    services.reach.stop();
    services.history.stop();
    rmSync(base, { recursive: true, force: true });
});

test("the slices are built over the configured roots", () => {
    expect(services.workspace.root).toBe(workspaceRoot);
    expect(services.workspaceScope.main).toBe(workspaceRoot);
    expect(services.authRoot).toBe(statePath(workspaceRoot, ".intentic/secrets/auth/"));
});

test("the late seams answer once composing has returned", async () => {
    expect(Object.keys(await services.providerReadiness()).sort()).toEqual(services.providerModules.map((module) => module.id).sort());
    expect(Object.keys(services.providerCatalogs).sort()).toEqual(services.providerModules.map((module) => module.id).sort());
    expect(services.landCheck.current()).toBeUndefined();
    expect(await services.hostReach([])).toBeUndefined();
    expect(await services.webextReach([])).toBeUndefined();
    expect(services.outboxStreamFor(undefined)).toBeUndefined();
    expect(services.reach.status()).toEqual({ state: "off" });
});
