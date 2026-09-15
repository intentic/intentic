import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins boot step order, read by shape off main.ts like main-shutdown.test.ts: staleSessions (kills stale
// panel/agent/job sessions) must run before any step that starts one.

const main = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

const declared = (): string[] => {
    const table = main.slice(main.indexOf("const BOOT_STEPS = ["), main.indexOf("] as const;"));
    return [...table.matchAll(/\{ key: "([a-zA-Z]+)"/g)].map((match) => match[1] as string);
};

const executed = (): string[] => [...main.matchAll(/boot\.step\("([a-zA-Z]+)"/g)].map((match) => match[1] as string);

describe(`daemon boot order`, () => {
    it(`runs the steps in the order it declares them`, () => {
        expect(executed()).toEqual(declared());
    });

    // A declared step is something every held data route waits on. Starting dev servers and waiting for one to answer
    // are both work the editor has no reason to be held for, so both belong past the gate.
    it(`opens the gate before starting the apps and watching the starter, never behind them`, () => {
        const gate = main.indexOf("boot.finish();");
        expect(gate, "boot.finish() is what opens the gate").toBeGreaterThan(-1);
        expect(main.indexOf("await startWorkspaceApps();"), "the apps start past the gate").toBeGreaterThan(gate);
        expect(main.indexOf("noteStarterReadiness(logger"), "the starter's readiness is observed, not waited on").toBeGreaterThan(gate);
        expect(declared()).not.toContain("starterReady");
        expect(declared()).not.toContain("autostart");
    });

    it(`sweeps stale sessions before anything that starts a process of its own`, () => {
        const order = declared();
        const sweep = order.indexOf("staleSessions");
        expect(sweep, "the sweep must still be a declared step").toBeGreaterThan(-1);
        // A step that can start a managed process; the sweep must run before it or it kills what the step just started.
        expect(sweep, "starterSite starts a panel session").toBeLessThan(order.indexOf("starterSite"));
        // Same rule for the apps, which are no longer a step: the sweep runs inside the chain, they run past it.
        expect(main.indexOf(`boot.step("staleSessions"`)).toBeLessThan(main.indexOf("await startWorkspaceApps();"));
    });
});
