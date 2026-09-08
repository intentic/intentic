import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";
import { createEngineClient, type EngineClient } from "./client.js";

// Pins behavior across a real process boundary: a forked child (built dist/host/child.js), not an in-process fake,
// since serialization, sync metrics and child-death recovery only show up there.

// warm() waits out a full index pass (sweep, hash, parse, chunk); a hang bound, not a measurement.
const WARM_TIMEOUT_MS = 120_000;

let root: string;
let cleanup: () => Promise<void>;
let engine: EngineClient;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    engine = createEngineClient({ root });
    await engine.warm();
}, WARM_TIMEOUT_MS);
afterAll(async () => {
    await engine.close();
    await cleanup();
});

const request = (partial: Partial<QueryRequest> & { verb: QueryRequest["verb"]; query: string }): QueryRequest => ({
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${partial.verb} "${partial.query}"`,
    ...partial,
});

test("the engine runs in another process, and answers from there", async () => {
    expect(engine.pid()).not.toBe(process.pid);
    expect(engine.pid()).toBeGreaterThan(0);

    const outcome = await engine.run(request({ verb: "files", query: "widget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups[0]?.path).toBe("alpha/src/widget.ts");
    // The rendered capsule crosses as a string and must arrive whole.
    expect(outcome.text).toContain("widget.ts");
});

test("an index built over there is searchable from here", async () => {
    const outcome = await engine.run(request({ verb: "q", query: "how are widgets built for the registry?" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups.some((group) => group.path === "notes.md")).toBe(true);
});

test("a per-call feature set crosses as a set, not as an empty object", async () => {
    const outcome = await engine.run(request({ verb: "q", query: "widget registry", features: new Set(["bm25"]) }));
    // Asserted as an Array: the field is declared ReadonlySet<Feature> but arrives here as a list once it crosses.
    expect(outcome.result.features).toEqual(expect.any(Array));
    expect(outcome.result.features).not.toContain("bm25");
    expect(outcome.result.features).toContain("semantic");
});

test("metrics read synchronously, with an age that goes on aging between pushes", async () => {
    const first = engine.metrics();
    expect(first.files).toBeGreaterThan(0);
    expect(first.revalidated).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(engine.metrics().sweepAgeMs ?? 0).toBeGreaterThan(first.sweepAgeMs ?? 0);
});

test("markDirty crosses the wire: a new file becomes findable without a restart", async () => {
    await writeFile(join(root, "alpha/src/gadget_host.ts"), "export const hostGadget = 1;\n");
    engine.markDirty();

    await expect
        .poll(async () => (await engine.run(request({ verb: "files", query: "gadget_host" }))).result.groups.length, { timeout: 30_000 })
        .toBeGreaterThan(0);
});

// The signal itself can't cross the boundary; forwarded as a message the child raises on its own controller.
test("an abort reaches across the boundary, and the engine keeps serving after it", async () => {
    const controller = new AbortController();
    const abandoned = engine.run(request({ verb: "q", query: "widget" }), controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toThrow(/abort/i);

    const after = await engine.run(request({ verb: "files", query: "widget" }));
    expect(after.result.groups[0]?.path).toBe("alpha/src/widget.ts");
});

// A separate client (`doomed`), so killing its child does not touch the shared `engine` used by other tests.
test("a killed child is reported, and the next search brings up a new one", async () => {
    const reported: Error[] = [];
    const doomed = createEngineClient({ root, onQueryError: (error) => reported.push(error) });
    try {
        const first = doomed.pid();
        expect(first).toBeGreaterThan(0);

        // What a real crash (OOM, a failing module) looks like from this side.
        const inFlight = doomed.run(request({ verb: "q", query: "widget" }));
        process.kill(first!, "SIGKILL");
        await expect(inFlight).rejects.toThrow(/exited/);
        // Search going missing must be visible through the host's existing channel for a degraded engine.
        expect(reported.some((error) => /exited/.test(error.message))).toBe(true);

        const outcome = await doomed.run(request({ verb: "files", query: "widget" }));
        expect(outcome.result.groups[0]?.path).toBe("alpha/src/widget.ts");
        expect(doomed.pid()).not.toBe(first);
    } finally {
        await doomed.close();
    }
});
