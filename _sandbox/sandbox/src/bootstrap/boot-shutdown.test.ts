import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Pins that shutdown works by disposing a store of registered teardowns, never by naming subsystems, and that no phase
// of boot leaves a timer holding the event loop open. Checked by shape over the sources, since a roster of names would
// need the same edit it exists to catch.

const srcRoot = fileURLToPath(new URL("../", import.meta.url));

// A boot phase is any module handed the BootPhase shape, which includes the entrypoint that builds it.
const bootPhases = (): readonly { readonly path: string; readonly source: string }[] =>
    readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
        .map((path) => ({ path, source: readFileSync(join(srcRoot, path), "utf8") }))
        .filter(({ source }) => source.includes("BootPhase"));

const main = readFileSync(join(srcRoot, "main.ts"), "utf8");

// The signal handler's body: from `const stop = (…): void => {` to the line that closes it at the same indent.
const shutdownHandler = (): string => {
    const opening = main.indexOf("const stop = (");
    expect(opening, "main.ts must still install a shutdown handler named `stop`").toBeGreaterThan(-1);
    const closing = main.indexOf("\n    };", opening);
    return main.slice(opening, closing);
};

describe(`daemon shutdown`, () => {
    it(`tears down by disposing the store, never by naming subsystems`, () => {
        const body = shutdownHandler();
        // The store, newest first under the stop deadline (system/boot/daemon-stop.ts).
        expect(body).toContain(`tearDown(shutdown)`);

        // A match here is a subsystem stopped by name; register it at creation instead (`shutdown.push(() =>
        // thing.stop())`).
        const enumerated = [...body.matchAll(/\.stop\(\)|\.stopAll\(\)|\.close\(\)|\.cancel\(\)|clearInterval\(|clearTimeout\(/g)].map(
            (match) => match[0],
        );
        expect(enumerated).toEqual([]);
    });

    // A raw interval is the shape that grew eight sweeps in one file, each with its own cadence, its own run at every boot
    // and its own teardown (2026-10-12). Housekeeping is a chore on the persistent clock (system/chore-clock.ts), and a watch
    // that must look every few minutes is `startPeriodic`, which never overlaps its runs and unrefs its timers; either is
    // registered with the store, so none holds the event loop open on a clean exit.
    it(`starts no raw interval in any boot phase`, () => {
        const phases = bootPhases();
        expect(
            phases.map(({ path }) => path),
            "main.ts is itself a boot phase",
        ).toContain("main.ts");

        const raw = phases.flatMap(({ path, source }) => [...source.matchAll(/\bsetInterval\(/g)].map(() => path));
        expect(raw).toEqual([]);
    });
});
