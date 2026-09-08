import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins that shutdown works by disposing a store of registered teardowns, never by naming subsystems: checked by shape
// over main.ts, since a roster of names would need the same edit it exists to catch.

const main = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

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

    // An uncleared interval keeps the event loop alive by itself, turning a clean exit into a hang; every timer must go
    // through the store.
    it(`clears every interval it starts through the store`, () => {
        const started = [...main.matchAll(/const (\w+) = [^\n]*\bsetInterval\(/g)].map((match) => match[1]);
        expect(started.length, "main.ts should still be starting intervals — if not, drop this guard").toBeGreaterThan(0);

        const unregistered = started.filter((name) => !main.includes(`shutdown.push(() => clearInterval(${name}))`));
        expect(unregistered).toEqual([]);
    });
});
