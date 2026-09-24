import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEngine, type Engine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

const exec = promisify(execFile);

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

    // The pattern match is case-insensitive, so PascalCase paths (WidgetList.vue) count as hits too.
    const filtered = await engine.run(request({ verb: "recent", query: "widget" }));
    expect(filtered.result.groups.every((group) => group.path.toLowerCase().includes("widget"))).toBe(true);
    expect(filtered.result.groups.some((group) => group.path === "alpha/src/WidgetList.vue")).toBe(true);

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

test("a git failure is an error, never an empty history", async () => {
    // `-G(` is a regex git refuses; reading its exit as "no commit touched this" would send the caller looking elsewhere.
    await expect(engine.run(request({ verb: "log", query: "(", options: { logRegex: true } }))).rejects.toThrow("invalid regex");
});

test("a repo with no commits yet reads as no history, not as a failure", async () => {
    const gamma = join(root, "gamma");
    await mkdir(gamma);
    await exec("git", ["-C", gamma, "init", "-q"]);
    await writeFile(join(gamma, "draft.ts"), "export const draft = 1;\n");
    const recent = await engine.run(request({ verb: "recent", query: "draft" }));
    expect(recent.result.groups.map((group) => group.path)).toEqual(["gamma/draft.ts"]);
    expect(recent.text).toContain("uncommitted");
    const log = await engine.run(request({ verb: "log", query: "draft", options: { path: "gamma/draft.ts" } }));
    expect(log.exitCode).toBe(1);
    // An unborn HEAD has no diff to take, so every untracked file seeds `impact` on its own.
    const impact = await engine.run(request({ verb: "impact", query: "" }));
    expect(impact.result.note).toMatch(/^one hop each way over the import graph, \d+ changed files?/);
});
