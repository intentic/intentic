import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* THE ORDER THE BOOT RUNS IN IS A CONTRACT BETWEEN ITS STEPS, and two of them have already disagreed.
 *
 * `staleSessions` kills every panel-*, agent-* and job-* tmux session as a previous daemon's leftover.
 * `starterSite` seeds a fresh workspace and STARTS the starter's dev server in a panel-* session. For as long as
 * the sweep ran after the seed, every brand-new sandbox opened on "site isn't running": the daemon had started
 * the one thing the user was meant to see and then, eight steps later, killed it as litter. The integration test
 * for the seed mocks the process manager, so nothing caught it.
 *
 * Read by SHAPE off main.ts, the way main-shutdown.test.ts reads its invariant: the declaration table names the
 * steps in order, the awaited `boot.step("…")` calls run them, and both have to agree with each other and with
 * the one ordering rule that has already cost a launch. */

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
        // Every step that can start a managed process: the sweep must come first, or it kills what they start.
        for (const starter of ["starterSite", "autostart"]) {
            const index = order.indexOf(starter);
            if (index !== -1) {
                expect(sweep, `${starter} starts a panel session, so staleSessions must run before it`).toBeLessThan(index);
            }
        }
    });
});
