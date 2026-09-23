import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pins boot order, read by shape off the files that hold it (like boot-shutdown.test.ts): the gate opens before any work
// a held data route has no reason to wait on, and staleSessions runs before anything that starts a session.

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const chain = read("./boot-chain.ts");
const main = read("../main.ts");
const workspaceApps = read("./workspace-apps.ts");

const declared = (): string[] => {
    const table = chain.slice(chain.indexOf("const BOOT_STEPS"), chain.indexOf("export const declareBootSteps"));
    return [...table.matchAll(/key: "([a-zA-Z]+)"/g)].map((match) => match[1] as string);
};

describe(`daemon boot order`, () => {
    // A declared step is something every held data route waits on. Starting dev servers is work the editor has no
    // reason to be held for, so it belongs past the gate.
    it(`opens the gate before starting the apps, never behind them`, () => {
        const gate = main.indexOf("services.boot.finish();");
        expect(gate, "boot.finish() is what opens the gate").toBeGreaterThan(-1);
        expect(main.indexOf("await startWorkspaceApps("), "the apps start past the gate").toBeGreaterThan(gate);
        expect(declared()).not.toContain("starterReady");
        expect(declared()).not.toContain("autostart");
    });

    // Waiting up to 30s for a framework to bind a port is not readiness either, so the starter's answer is observed on
    // its own promise and never awaited by the boot that started it.
    it(`observes the starter's readiness rather than waiting on it`, () => {
        expect(workspaceApps).toContain("noteStarterReadiness(");
        expect(workspaceApps).not.toMatch(/await\s+waitForStarter\(/);
    });

    it(`sweeps stale sessions before anything that starts a process of its own`, () => {
        const order = declared();
        const sweep = order.indexOf("staleSessions");
        expect(sweep, "the sweep must still be a declared step").toBeGreaterThan(-1);
        // A step that can start a managed process; the sweep must run before it or it kills what the step just started.
        expect(sweep, "starterSite starts a panel session").toBeLessThan(order.indexOf("starterSite"));
        // Same rule for the apps, which are no longer a step: the whole chain is awaited before they run.
        expect(main.indexOf("await runBootSteps(")).toBeLessThan(main.indexOf("await startWorkspaceApps("));
    });
});
