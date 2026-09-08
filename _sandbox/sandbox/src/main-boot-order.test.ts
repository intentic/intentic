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

    it(`sweeps stale sessions before any step that starts a process of its own`, () => {
        const order = declared();
        const sweep = order.indexOf("staleSessions");
        expect(sweep, "the sweep must still be a declared step").toBeGreaterThan(-1);
        // Steps that can start a managed process; the sweep must run before each or it kills what they just started.
        for (const starter of ["starterSite", "autostart"]) {
            const index = order.indexOf(starter);
            if (index !== -1) {
                expect(sweep, `${starter} starts a panel session, so staleSessions must run before it`).toBeLessThan(index);
            }
        }
    });
});
