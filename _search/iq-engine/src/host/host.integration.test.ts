import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";
import { createEngineClient, type EngineClient } from "./client.js";

/* Against a REAL forked child, because the whole module is a claim about a process boundary: that the surface
 * survives structured cloning, that a synchronous metrics read works without one, and that a child dying leaves
 * a degraded engine rather than a stuck one. An in-process fake would confirm none of those.
 *
 * The child is the built `dist/host/child.js` (see client.ts), which is why this package's `test` script builds
 * before it runs. */

// warm() waits out a whole index pass over the fixture: sweep, hash, parse, chunk. Seconds of real work by
// design, and on a loaded CI box well past vitest's default. A hang bound, not a measurement.
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
    // The rendered capsule is what a reading agent gets; it crosses as a string and must arrive whole.
    expect(outcome.text).toContain("widget.ts");
});

test("an index built over there is searchable from here", async () => {
    const outcome = await engine.run(request({ verb: "q", query: "how are widgets built for the registry?" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups.some((group) => group.path === "notes.md")).toBe(true);
});

/* `features` is a SET, and JSON IPC would have delivered it as `{}`: every stage silently disabled, producing
 * a result that still looks plausible. This is the case that decides the serialization mode, so it is a test
 * rather than a comment: asking for BM25 alone has to arrive as BM25 alone. */
test("a per-call feature set crosses as a set, not as an empty object", async () => {
    const outcome = await engine.run(request({ verb: "q", query: "widget registry", features: new Set(["bm25"]) }));
    /* The run's provenance: every stage the engine knows about MINUS the one that was asked for.
     *
     * Asserted as an ARRAY, which is what actually crosses the host boundary — the field is declared
     * `ReadonlySet<Feature>` and arrives here as a list. That gap is worth knowing about and is not this
     * test's to close; what matters is that the assertion describes the value that really turns up.
     *
     * A collection type, rather than a presence check, because the failure this whole test exists for is the
     * set arriving as `{}` — and `{}` is perfectly defined. `toContain("semantic")` below would have caught
     * it too, one line later and blaming the wrong stage. */
    expect(outcome.result.features).toEqual(expect.any(Array));
    expect(outcome.result.features).not.toContain("bm25");
    expect(outcome.result.features).toContain("semantic");
});

/* The host reads metrics SYNCHRONOUSLY (composition's resource series takes no await), which a process boundary
 * cannot serve, so the child pushes and this returns the last push. The age has to keep MOVING between pushes:
 * an idle engine whose sweep froze at a fixed age would read as one that had stopped sweeping. */
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

/* A caller that gave up: the browser superseding a search mid-flight. What the signal has to REACH is the rg
 * child, and that now lives in the other process: the signal itself does not cross, so it is forwarded as a
 * message the child raises on a controller of its own. Proven by the abort actually landing (the run ends as
 * aborted rather than as a result), and by the engine still serving afterwards: the failure the boundary
 * introduces would be a forwarded abort that strands the call or takes the child down with it. */
test("an abort reaches across the boundary, and the engine keeps serving after it", async () => {
    const controller = new AbortController();
    const abandoned = engine.run(request({ verb: "q", query: "widget" }), controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toThrow(/abort/i);

    const after = await engine.run(request({ verb: "files", query: "widget" }));
    expect(after.result.groups[0]?.path).toBe("alpha/src/widget.ts");
});

/* The child IS the engine; losing it must not wedge the daemon. The next call has to bring a whole new one up:
 * new sweep, new index claim, and answer from it. Its own client, so the kill cannot touch the shared one. */
test("a killed child is reported, and the next search brings up a new one", async () => {
    const reported: Error[] = [];
    const doomed = createEngineClient({ root, onQueryError: (error) => reported.push(error) });
    try {
        const first = doomed.pid();
        expect(first).toBeGreaterThan(0);

        // What a real crash (OOM, a module that will not load) looks like from this side.
        const inFlight = doomed.run(request({ verb: "q", query: "widget" }));
        process.kill(first!, "SIGKILL");
        await expect(inFlight).rejects.toThrow(/exited/);
        // Search going missing has to be VISIBLE: the host's existing channel for a degraded engine.
        expect(reported.some((error) => /exited/.test(error.message))).toBe(true);

        const outcome = await doomed.run(request({ verb: "files", query: "widget" }));
        expect(outcome.result.groups[0]?.path).toBe("alpha/src/widget.ts");
        expect(doomed.pid()).not.toBe(first);
    } finally {
        await doomed.close();
    }
});
