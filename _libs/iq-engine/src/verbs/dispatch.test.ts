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

test("find: literal/regex content search with ranked, grouped, anchored output", async () => {
    const outcome = await engine.run(request({ verb: "find", query: "createWidget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.total).toBeGreaterThanOrEqual(3);
    expect(outcome.text).toContain("repositories/alpha/src/widget.ts");
    expect(outcome.text).toMatch(/════ repositories\/alpha\/src\/[a-z.]+ \(\d+\) ════/);
    // Anchors are line-exact.
    const widgetGroup = outcome.result.groups.find((group) => group.path === "repositories/alpha/src/widget.ts");
    expect(widgetGroup?.hits.some((hit) => hit.text.includes("export const createWidget"))).toBe(true);
});

test("find: zero hits exit 1", async () => {
    const outcome = await engine.run(request({ verb: "find", query: "no_such_token_anywhere_xyz" }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.total).toBe(0);
});

test("files: fuzzy filename search, ranked", async () => {
    const outcome = await engine.run(request({ verb: "files", query: "widget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups[0]?.path).toBe("repositories/alpha/src/widget.ts");
    expect(outcome.text).toContain("[fuzzy");
});

test("q auto-mode: identifier query fuses word search; natural query keyword-expands", async () => {
    const identifier = await engine.run(request({ verb: "q", query: "createWidget" }));
    expect(identifier.exitCode).toBe(0);
    expect(identifier.result.groups.some((group) => group.path.startsWith("repositories/alpha/src/"))).toBe(true);

    const natural = await engine.run(request({ verb: "q", query: "how are widgets built for the registry?" }));
    expect(natural.exitCode).toBe(0);
    expect(natural.result.groups.some((group) => group.path === "notes.md")).toBe(true);
});

test("scope flags narrow search", async () => {
    const outcome = await engine.run(request({ verb: "find", query: "widget", scope: { langs: ["python"] } }));
    expect(outcome.result.groups.every((group) => group.path.endsWith(".py"))).toBe(true);
});

test("the index dir never surfaces; former-secret/.git paths follow the ignore model (no floor)", async () => {
    // The iq index dir self-excludes in every mode — it must never index or surface itself.
    for (const scope of [{}, { ignored: true }] as const) {
        const indexDir = await engine.run(request({ verb: "find", query: "never be surfaced", scope }));
        expect(indexDir.result.total).toBe(0);
    }
    // No security floor: a non-gitignore'd secret is indexed and searchable like any other file.
    const secret = await engine.run(request({ verb: "find", query: "fixture-secret-value" }));
    expect(secret.result.groups.map((group) => group.path)).toContain(".env");
    const files = await engine.run(request({ verb: "files", query: "env" }));
    expect(files.result.groups.map((group) => group.path)).toEqual(expect.arrayContaining([".env", ".env.example"]));
    // `.git` is a junk-ignored dir: content search skips it by default, so the token-bearing config never surfaces.
    expect((await engine.run(request({ verb: "find", query: "token@example.com" }))).result.total).toBe(0);
});

test("--ignored lifts .gitignore but keeps ranking honest", async () => {
    const withIgnored = await engine.run(request({ verb: "find", query: "IGNORED_BUILD_ARTIFACT", scope: { ignored: true } }));
    expect(withIgnored.result.groups.map((group) => group.path)).toEqual(["repositories/alpha/dist/decoy.js"]);
    const without = await engine.run(request({ verb: "find", query: "IGNORED_BUILD_ARTIFACT" }));
    expect(without.result.total).toBe(0);
});

test("cursor: truncated result resumes exactly with --after", async () => {
    const first = await engine.run(request({ verb: "find", query: "widget", render: { budget: 120 } }));
    expect(first.result.truncated).toBe(true);
    expect(first.result.cursor).toBeDefined();

    const next = await engine.run(request({ verb: "find", query: "widget", render: { budget: 4000, after: first.result.cursor! } }));
    expect(next.exitCode).toBe(0);
    // Pages never overlap.
    const firstPaths = first.result.groups.map((group) => group.path);
    const nextPaths = new Set(next.result.groups.map((group) => group.path));
    expect(firstPaths.filter((path) => nextPaths.has(path))).toEqual([]);
    expect(first.result.total).toBe(next.result.total);
});

test("index lifecycle: status counts files; drop resets", async () => {
    const status = await engine.indexStatus();
    expect(status.files).toBeGreaterThan(3);
    engine.indexDrop();
    const rebuilt = await engine.indexRebuild();
    expect(rebuilt.files).toBe(status.files);
});
