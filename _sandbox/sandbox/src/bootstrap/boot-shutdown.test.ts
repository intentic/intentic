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

// The signal handler's body: from `const stop = (): void => {` to the line that closes it at the same indent.
const shutdownHandler = (): string => {
    const opening = main.indexOf("const stop = (): void => {");
    expect(opening, "main.ts must still install a shutdown handler named `stop`").toBeGreaterThan(-1);
    const closing = main.indexOf("\n    };", opening);
    return main.slice(opening, closing);
};

describe(`daemon shutdown`, () => {
    it(`tears down by disposing the store, never by naming subsystems`, () => {
        const body = shutdownHandler();
        expect(body).toContain(`shutdown.dispose()`);

        // A match here is a subsystem stopped by name; register it at creation instead (`shutdown.push(() =>
        // thing.stop())`).
        const enumerated = [...body.matchAll(/\.stop\(\)|\.stopAll\(\)|\.close\(\)|\.cancel\(\)|clearInterval\(|clearTimeout\(/g)].map(
            (match) => match[0],
        );
        expect(enumerated).toEqual([]);
    });

    // An uncleared interval keeps the event loop alive by itself, turning a clean exit into a hang; every timer a boot
    // phase names must go through the store. An unnamed one is unref'd by construction and holds nothing.
    it(`clears every interval a boot phase starts through the store`, () => {
        const phases = bootPhases();
        expect(
            phases.map(({ path }) => path),
            "main.ts is itself a boot phase",
        ).toContain("main.ts");

        const started = phases.flatMap(({ path, source }) =>
            [...source.matchAll(/const (\w+) = [^\n]*\bsetInterval\(/g)].map((match) => ({ path, source, name: match[1] as string })),
        );
        expect(started.length, "the boot phases should still be starting intervals — if not, drop this guard").toBeGreaterThan(0);

        const unregistered = started.filter(({ source, name }) => !source.includes(`shutdown.push(() => clearInterval(${name}))`));
        expect(unregistered.map(({ path, name }) => `${path}:${name}`)).toEqual([]);
    });
});
