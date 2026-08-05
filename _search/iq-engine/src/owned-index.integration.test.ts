import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine, type Engine, IQ_DIR } from "./index.js";
import { openIndex } from "./store/db.js";
import { listFiles } from "./store/index-store.js";
import { makeFixtureWorkspace } from "./testing.js";
import type { QueryRequest } from "./types.js";

/* A one-shot engine in a workspace whose index is OWNED by another live process (in a sandbox: the daemon's
 * resident engine). It used to revalidate anyway and lose the write lock to that process's sweep, which is how
 * every `iq` call in a warm sandbox came back "Exit code 2 — database is locked". */

let root: string;
let cleanup: () => Promise<void>;
let engine: Engine;
let indexDir: string;

const request = (partial: Partial<QueryRequest> & { verb: QueryRequest["verb"]; query: string }): QueryRequest => ({
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${partial.verb} "${partial.query}"`,
    ...partial,
});

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    indexDir = join(root, IQ_DIR);
    engine = createEngine({ root });
    // Build the index while nothing owns it — this is the unowned path, and it must still write.
    await engine.run(request({ verb: "find", query: "createWidget" }));
});
afterAll(() => cleanup());

test("unowned: the one-shot engine indexes inline and reports the index fresh", async () => {
    const outcome = await engine.run(request({ verb: "def", query: "createWidget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.freshness.state).toBe("fresh");
    const db = openIndex(indexDir, "read");
    expect(listFiles(db).has("alpha/src/widget.ts")).toBe(true);
    db.close();
});

test("owned by a live process: queries still answer, and the index is left alone", async () => {
    // pid 1 exists in every process namespace this can run in — a stand-in for the daemon holding the index.
    await writeFile(join(indexDir, "indexer.pid"), "1");
    // A file the (fake) owner has not indexed yet: the read-only pass must NOT write it, and must not pretend the
    // index is fresh either.
    await writeFile(join(root, "alpha/src/late.ts"), "export const late = (): number => 1;\n");

    const outcome = await engine.run(request({ verb: "find", query: "createWidget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.total).toBeGreaterThan(0);
    expect(outcome.result.freshness.state).toBe("stale");

    const db = openIndex(indexDir, "read");
    expect(listFiles(db).has("alpha/src/late.ts")).toBe(false);
    db.close();

    // rg-backed hits are live regardless of the index, so content search still finds the unindexed file.
    const live = await engine.run(request({ verb: "find", query: "export const late" }));
    expect(live.result.groups.some((group) => group.path === "alpha/src/late.ts")).toBe(true);
});

test("owned by a live process: a rebuild refuses rather than deleting the owner's index", async () => {
    await expect(engine.indexRebuild()).rejects.toThrow(/another process owns this index/);
    const db = openIndex(indexDir, "read");
    expect(listFiles(db).size).toBeGreaterThan(0);
    db.close();
});

test("the owner's death hands indexing back: the next query writes again", async () => {
    await writeFile(join(indexDir, "indexer.pid"), "4194304");
    const outcome = await engine.run(request({ verb: "find", query: "export const late" }));
    expect(outcome.result.freshness.state).toBe("fresh");
    const db = openIndex(indexDir, "read");
    expect(listFiles(db).has("alpha/src/late.ts")).toBe(true);
    db.close();
    await rm(join(indexDir, "indexer.pid"));
});
