import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    expect(outcome.text).toContain("alpha/src/widget.ts");
    expect(outcome.text).toMatch(/════ alpha\/src\/[a-z.]+ \(\d+\) ════/);
    const widgetGroup = outcome.result.groups.find((group) => group.path === "alpha/src/widget.ts");
    expect(widgetGroup?.hits.some((hit) => hit.text.includes("export const createWidget"))).toBe(true);
});

test("find: zero hits exit 1", async () => {
    const outcome = await engine.run(request({ verb: "find", query: "no_such_token_anywhere_xyz" }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.total).toBe(0);
});

test("find: a zero-hit prose phrase escalates semantically unless literal intent is explicit", async () => {
    const recovered = await engine.run(request({ verb: "find", query: "how are widgets built for the registry?" }));
    expect(recovered.exitCode).toBe(0);
    expect(recovered.result.note).toContain("answered semantically");
    expect(recovered.result.groups.some((group) => group.path === "notes.md")).toBe(true);

    const literal = await engine.run(request({ verb: "find", query: "how are widgets built for the registry?", options: { literal: true } }));
    expect(literal.exitCode).toBe(1);
    expect(literal.result.total).toBe(0);

    // Punctuation is scanned once, not end-anchored; a long `!` run cannot make recovery polynomial in query length.
    const emphatic = await engine.run(request({ verb: "find", query: `how are widgets built for the registry${"!".repeat(2_000)}` }));
    expect(emphatic.exitCode).toBe(0);
    expect(emphatic.result.note).toContain("answered semantically");
});

test("files: fuzzy filename search, ranked", async () => {
    const outcome = await engine.run(request({ verb: "files", query: "widget" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.groups[0]?.path).toBe("alpha/src/widget.ts");
    expect(outcome.text).toContain("[fuzzy");
});

test("q auto-mode: identifier query fuses word search; natural query keyword-expands", async () => {
    const identifier = await engine.run(request({ verb: "q", query: "createWidget" }));
    expect(identifier.exitCode).toBe(0);
    expect(identifier.result.groups.some((group) => group.path.startsWith("alpha/src/"))).toBe(true);

    const natural = await engine.run(request({ verb: "q", query: "how are widgets built for the registry?" }));
    expect(natural.exitCode).toBe(0);
    expect(natural.result.groups.some((group) => group.path === "notes.md")).toBe(true);
});

test("scope flags narrow search", async () => {
    const outcome = await engine.run(request({ verb: "find", query: "widget", scope: { langs: ["python"] } }));
    expect(outcome.result.groups.every((group) => group.path.endsWith(".py"))).toBe(true);
});

test("the index dir never surfaces; former-secret/.git paths follow the ignore model (no floor)", async () => {
    for (const scope of [{}, { ignored: true }] as const) {
        const indexDir = await engine.run(request({ verb: "find", query: "never be surfaced", scope }));
        expect(indexDir.result.total).toBe(0);
    }
    const secret = await engine.run(request({ verb: "find", query: "fixture-secret-value" }));
    expect(secret.result.groups.map((group) => group.path)).toContain(".env");
    const files = await engine.run(request({ verb: "files", query: "env" }));
    expect(files.result.groups.map((group) => group.path)).toEqual(expect.arrayContaining([".env", ".env.example"]));
    expect((await engine.run(request({ verb: "find", query: "token@example.com" }))).result.total).toBe(0);
});

test("--ignored lifts .gitignore but keeps ranking honest", async () => {
    const withIgnored = await engine.run(request({ verb: "find", query: "IGNORED_BUILD_ARTIFACT", scope: { ignored: true } }));
    expect(withIgnored.result.groups.map((group) => group.path)).toEqual(["alpha/dist/decoy.js"]);
    const without = await engine.run(request({ verb: "find", query: "IGNORED_BUILD_ARTIFACT" }));
    expect(without.result.total).toBe(0);
});

test("the sweep, not ripgrep's own ignore handling: decides what find can match", async () => {
    const alphaExclude = join(root, "alpha/.git/info/exclude");
    await mkdir(dirname(alphaExclude), { recursive: true });
    await writeFile(alphaExclude, "/src/\n");
    const outcome = await createEngine({ root }).run(request({ verb: "find", query: "createWidget" }));
    expect(outcome.result.groups.map((group) => group.path)).toContain("alpha/src/widget.ts");
    await rm(alphaExclude, { force: true });
});

test("cursor: truncated result resumes exactly with --after", async () => {
    const first = await engine.run(request({ verb: "find", query: "widget", render: { budget: 120 } }));
    expect(first.result.truncated).toBe(true);
    // Cursor format is an 8-hex spool id followed by a base36 group offset.
    expect(first.result.cursor).toMatch(/^[0-9a-f]{8}[0-9a-z]+$/);

    const next = await engine.run(request({ verb: "find", query: "widget", render: { budget: 4000, after: first.result.cursor! } }));
    expect(next.exitCode).toBe(0);
    const firstPaths = first.result.groups.map((group) => group.path);
    const nextPaths = new Set(next.result.groups.map((group) => group.path));
    expect(firstPaths.filter((path) => nextPaths.has(path))).toEqual([]);
    expect(first.result.total).toBe(next.result.total);
});

test("a scoped find answers with exactly the unscoped hits for the files in scope", async () => {
    const scoped = await engine.run(request({ verb: "find", query: "widget", options: { literal: true }, scope: { globs: ["alpha/src/*.ts"] } }));
    const unscoped = await engine.run(request({ verb: "find", query: "widget", options: { literal: true }, render: { budget: 100_000 } }));

    const paths = scoped.result.groups.map((group) => group.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => /^alpha\/src\/[^/]+\.ts$/.test(path))).toBe(true);
    for (const group of scoped.result.groups) {
        const same = unscoped.result.groups.find((candidate) => candidate.path === group.path);
        expect(group.hits.map((hit) => hit.line)).toEqual(same?.hits.map((hit) => hit.line));
    }
    const inScope = unscoped.result.groups.filter((group) => /^alpha\/src\/[^/]+\.ts$/.test(group.path)).map((group) => group.path);
    expect(paths.toSorted()).toEqual(inScope.toSorted());
});

test("a ceilinged list page and the page after it are one continuous result", async () => {
    const page = { hits: 2, files: 1 };
    const first = await engine.run(request({ verb: "find", query: "widget", options: { literal: true }, render: { budget: 1500, list: page } }));
    expect(first.result.groups).toHaveLength(1);
    expect(first.result.truncated).toBe(true);
    // Cursor format is an 8-hex spool id followed by a base36 group offset.
    expect(first.result.cursor).toMatch(/^[0-9a-f]{8}[0-9a-z]+$/);
    // Early stop sets `partial`, the same flag a per-file cap uses.
    expect(first.result.partial).toBe(true);

    const next = await engine.run(
        request({ verb: "find", query: "widget", options: { literal: true }, render: { budget: 1500, list: page, after: first.result.cursor! } }),
    );
    expect(next.result.groups.length).toBeGreaterThan(0);
    const seen = new Set(first.result.groups.map((group) => group.path));
    expect(next.result.groups.filter((group) => seen.has(group.path))).toEqual([]);
    expect(next.result.total).toBeGreaterThanOrEqual(first.result.total);
    expect(next.result.partial ?? false).toBe(false);
});

test("index lifecycle: status counts files; drop resets", async () => {
    const status = await engine.indexStatus();
    expect(status.files).toBeGreaterThan(3);
    engine.indexDrop();
    const rebuilt = await engine.indexRebuild();
    expect(rebuilt.files).toBe(status.files);
});
