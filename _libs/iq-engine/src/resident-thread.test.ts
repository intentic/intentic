import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createResidentEngine, type ResidentEngine } from "./index.js";
import { openIndex } from "./store/db.js";
import { makeFixtureWorkspace } from "./testing.js";

/* The one property the resident engine's worker exists for: building the index must not spend the HOST thread.
 * The daemon that hosts this engine serves HTTP on that thread, and while the build ran in-thread a boot
 * re-index left it ~83% busy for minutes — every request behind it took seconds, 0.4 kB reads included.
 *
 * Proven by blocking the host thread outright rather than by timing anything. A spin loop lets nothing on this
 * side run — no timer, no microtask, no I/O callback — so every file the index gains across it was indexed
 * somewhere else. In-thread the count could only be zero, whatever the machine, which is what makes this a
 * regression test and not a benchmark: nothing here is tuned to a threshold that a loaded CI box can breach. */

const FILES = 900;
const BLOCK_MS = 750;

let root: string;
let cleanup: () => Promise<void>;
let engine: ResidentEngine;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    // Enough files that the first pass is still plainly in flight when the block starts.
    const dir = join(root, "bulk");
    await mkdir(dir, { recursive: true });
    await Promise.all(
        Array.from({ length: FILES }, (_, i) =>
            writeFile(
                join(dir, `module${i}.ts`),
                `export interface Shape${i} { readonly id: number; readonly label: string }\n` +
                    `export const build${i} = (label: string): Shape${i} => ({ id: ${i}, label });\n`,
            ),
        ),
    );
});
afterAll(async () => {
    await engine.close();
    await cleanup();
});

test("the index builds while the host thread is blocked solid", () => {
    // Construction schedules the first pass; nothing on this thread will get another turn until the spin ends.
    engine = createResidentEngine({ root });
    const until = Date.now() + BLOCK_MS;
    while (Date.now() < until) {
        /* hold the thread */
    }

    // A second handle on the index the worker is writing — WAL is what makes that a plain read rather than a
    // wait, and it is the same arrangement the engine itself runs on (host reads, worker writes).
    const db = openIndex(join(root, ".intentic/iq"));
    const indexed = Number(db.get("SELECT COUNT(*) AS n FROM files")?.["n"] ?? 0);
    db.close();
    expect(indexed).toBeGreaterThan(0);
});

test("warm() reports the finished index, and the sweep the host serves queries against is populated", async () => {
    const status = await engine.warm();
    expect(status.files).toBeGreaterThan(FILES);
    const outcome = await engine.run({
        verb: "files",
        query: "module42",
        scope: {},
        render: { budget: 1500 },
        options: {},
        echo: `files "module42"`,
    });
    expect(outcome.result.groups[0]?.path).toBe("bulk/module42.ts");
});
