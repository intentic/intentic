import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* THE INVARIANT THAT REPLACED THE LIST.
 *
 * Shutdown used to be twenty-five `.stop()` calls at the bottom of main.ts, and the failure mode was never that
 * one of them was wrong: it was that the twenty-sixth subsystem never got a line. Nothing tied the list to the
 * things it covered, and a missing stop is invisible in the only place anyone looks: the process was exiting
 * anyway. It surfaced instead as a hanging test suite or a dev sandbox whose timers fired against services that
 * were already gone.
 *
 * Every subsystem now registers its teardown where it is created, and the handler just disposes the store. That
 * only stays true if nobody re-grows the list, which is what these read. By SHAPE, over the file as it stands,
 * rather than against a roster of subsystem names: a roster would need the same edit the code needs, and would
 * therefore miss exactly the addition it exists to catch. */

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

        /* A subsystem named HERE is one that had to be remembered. Register it next to whatever creates it:
         * `shutdown.push(() => thing.stop())`, and this handler never has to know it exists. */
        const enumerated = [...body.matchAll(/\.stop\(\)|\.stopAll\(\)|\.close\(\)|\.cancel\(\)|clearInterval\(|clearTimeout\(/g)].map(
            (match) => match[0],
        );
        expect(enumerated).toEqual([]);
    });

    /* An interval is the cheapest thing to start and the easiest to leave running: it keeps the event loop
     * alive by itself, so one that nothing clears turns a clean exit into a hang. Every timer main.ts holds has
     * to be handed to the store. */
    it(`clears every interval it starts through the store`, () => {
        const started = [...main.matchAll(/const (\w+) = [^\n]*\bsetInterval\(/g)].map((match) => match[1]);
        expect(started.length, "main.ts should still be starting intervals — if not, drop this guard").toBeGreaterThan(0);

        const unregistered = started.filter((name) => !main.includes(`shutdown.push(() => clearInterval(${name}))`));
        expect(unregistered).toEqual([]);
    });
});
