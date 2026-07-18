import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine, type Engine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;
let engine: Engine;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    engine = createEngine({ root });
});
afterAll(() => cleanup());

const request = (partial: Partial<QueryRequest> & { verb: QueryRequest["verb"]; query: string }): QueryRequest => ({
    scope: {},
    render: { budget: 1500 },
    options: {},
    echo: `${partial.verb} "${partial.query}"`,
    ...partial,
});

test("recent: committed files with change summaries, uncommitted by mtime", async () => {
    const outcome = await engine.run(request({ verb: "recent", query: "" }));
    expect(outcome.exitCode).toBe(0);
    // Committed alpha files carry a commit summary…
    expect(outcome.text).toMatch(/alpha\/src\/widget\.ts\s+just now\s+\+\d+ -\d+\s+\(1 commit\)/);
    // …while beta (no git repo) files appear as uncommitted mtime hits.
    expect(outcome.text).toMatch(/beta\/app\.py\s+just now\s+uncommitted/);

    const filtered = await engine.run(request({ verb: "recent", query: "widget" }));
    expect(filtered.result.groups.every((group) => group.path.includes("widget"))).toBe(true);

    await expect(engine.run(request({ verb: "recent", query: "", options: { since: "yesterday" } }))).rejects.toThrow("--since expects");
});

test("log: pickaxe finds the commit that added a string; metadata only", async () => {
    const outcome = await engine.run(request({ verb: "log", query: "createWidget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("add widget module");
    expect(outcome.text).toContain("fixture-author");
    // No patch bodies ever.
    expect(outcome.text).not.toContain("export const createWidget");

    const miss = await engine.run(request({ verb: "log", query: "never_committed_string" }));
    expect(miss.exitCode).toBe(1);
});

test("who: blames an anchor with commit metadata and the source line", async () => {
    const outcome = await engine.run(request({ verb: "who", query: "alpha/src/widget.ts:6" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("fixture-author");
    expect(outcome.text).toContain("add widget module");
    expect(outcome.text).toContain("line: export const createWidget");

    await expect(engine.run(request({ verb: "who", query: "beta/app.py:1" }))).rejects.toThrow("not inside a git repo");
});

test("uncommitted edits show up in recent immediately", async () => {
    await writeFile(join(root, "alpha/src/fresh.ts"), "export const fresh = 1;\n");
    const outcome = await engine.run(request({ verb: "recent", query: "fresh" }));
    expect(outcome.text).toContain("alpha/src/fresh.ts");
    expect(outcome.text).toContain("uncommitted");
});
