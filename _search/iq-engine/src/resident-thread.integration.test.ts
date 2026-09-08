import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createResidentEngine, type ResidentEngine } from "./index.js";
import { openIndex } from "./store/db.js";
import { makeFixtureWorkspace } from "./testing.js";

// Pins that building the index never blocks the host thread: proven by spinning the host solid and counting files
// indexed elsewhere, not by timing anything.

const FILES = 900;
// Upper bound on the poll wait; the assertion is that files appear at all, not how fast.
const PROGRESS_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
// Covers a full index pass over FILES files; generous since nothing here asserts on speed.
const WARM_TIMEOUT_MS = 120_000;

let root: string;
let cleanup: () => Promise<void>;
let engine: ResidentEngine;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    // Enough files that the first pass is still running when the block starts.
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
    // Construction schedules the first pass; nothing on this thread runs again until the spin loop ends.
    engine = createResidentEngine({ root });
    const deadline = Date.now() + PROGRESS_TIMEOUT_MS;
    let indexed = 0;
    while (indexed === 0 && Date.now() < deadline) {
        const until = Date.now() + POLL_MS;
        while (Date.now() < until) {
            /* hold the thread */
        }
        // A second handle while the worker writes; WAL makes this a synchronous read, keeping the spin unbroken.
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
