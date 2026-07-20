import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createResidentEngine, type ResidentEngine } from "./index.js";
import { makeFixtureWorkspace } from "./testing.js";
import type { QueryRequest } from "./types.js";

let root: string;
let cleanup: () => Promise<void>;
let engine: ResidentEngine;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    engine = createResidentEngine({ root });
});
afterAll(async () => {
    engine.close();
    await cleanup();
});

const request = (partial: Partial<QueryRequest> & { verb: QueryRequest["verb"]; query: string }): QueryRequest => ({
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${partial.verb} "${partial.query}"`,
    ...partial,
});

test("first query self-builds without warm() and serves from the resident index", async () => {
    const outcome = await engine.run(request({ verb: "files", query: "widget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups[0]?.path).toBe("alpha/src/widget.ts");
});

test("natural-language q answers from the resident BM25 index (no per-query revalidation)", async () => {
    // Queries never wait for the index build — so wait for it here before asserting on index-backed results.
    await engine.warm();
    const outcome = await engine.run(request({ verb: "q", query: "how are widgets built for the registry?" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups.some((group) => group.path === "notes.md")).toBe(true);
});

test("a new file surfaces only after markDirty triggers a refresh; staleness is reported meanwhile", async () => {
    await writeFile(join(root, "alpha/src/gadget_resident.ts"), "export const residentGadget = 1;\n");
    // The sweep is cached — without a change notification the file is invisible (that's the contract: queries
    // never pay the walk; the watcher owns freshness).
    const before = await engine.run(request({ verb: "files", query: "gadget_resident" }));
    expect(before.result.total).toBe(0);

    engine.markDirty();
    // Dirty → the next query reports non-fresh (self-healed refresh in flight) while still answering.
    const during = await engine.run(request({ verb: "files", query: "gadget_resident" }));
    expect(during.result.freshness.state).not.toBe("fresh");

    const deadline = Date.now() + 5000;
    let total = 0;
    while (Date.now() < deadline) {
        total = (await engine.run(request({ verb: "files", query: "gadget_resident" }))).result.total;
        if (total === 1) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(total).toBe(1);
});

test("warm reports index status after the initial refresh", async () => {
    const status = await engine.warm();
    expect(status.files).toBeGreaterThan(0);
    expect(status.symbols).toBeGreaterThan(0);
});
