import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createResidentEngine, type ResidentEngine } from "./index.js";
import { openIndex } from "./store/db.js";
import { makeFixtureWorkspace } from "./testing.js";

/* The one property the resident engine's worker exists for: building the index must not spend the HOST thread.
 * The daemon that hosts this engine serves HTTP on that thread, and while the build ran in-thread a boot
 * re-index left it ~83% busy for minutes: every request behind it took seconds, 0.4 kB reads included.
 *
 * Proven by blocking the host thread outright rather than by timing anything. A spin loop lets nothing on this
 * side run: no timer, no microtask, no I/O callback, so every file the index gains across it was indexed
 * somewhere else. In-thread the count could only be zero, whatever the machine, which is what makes this a
 * regression test and not a benchmark: nothing here is tuned to a threshold that a loaded CI box can breach. */

const FILES = 900;
/* How long the host stays blocked waiting for the worker to show something. A hang bound, not a measurement:
 * the property is that files appear while this thread never yields, and WHEN they appear is the runner's
 * business: a worker sharing a core with thirty other vitest processes starts late. The fixed 750ms window
 * this replaces read the count once and asserted on whatever the worker had managed by then, which is a
 * throughput claim wearing a regression test's clothes; it came back 0 three times on main. */
const PROGRESS_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
/* warm() waits out a whole index pass over FILES files: sweep, hash, parse, chunk, one transaction per file. That
 * is seconds of real work by design, and on a loaded CI box it breached vitest's 5s default. The wait is not an
 * assertion about speed (nothing here is timed), so the ceiling is set well clear of the work rather than near it. */
const WARM_TIMEOUT_MS = 120_000;

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
    const deadline = Date.now() + PROGRESS_TIMEOUT_MS;
    let indexed = 0;
    while (indexed === 0 && Date.now() < deadline) {
        const until = Date.now() + POLL_MS;
        while (Date.now() < until) {
            /* hold the thread */
        }
        /* A second handle on the index the worker is writing: WAL is what makes that a plain read rather than a
         * wait, and it is the same arrangement the engine itself runs on (host reads, worker writes). Reading it
         * is synchronous like the spin around it, so the block is unbroken across the whole loop: no timer, no
         * microtask, no I/O callback of this thread's has run between construction and the count below. */
        const db = openIndex(join(root, `${STATE_DIR}/local/cache/iq`), "write");
        indexed = Number(db.get("SELECT COUNT(*) AS n FROM files")?.["n"] ?? 0);
        db.close();
    }
    expect(indexed).toBeGreaterThan(0);
});

test(
    "warm() reports the finished index, and the sweep the host serves queries against is populated",
    async () => {
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
    },
    WARM_TIMEOUT_MS,
);
