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
    // Anchors are line-exact.
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

    // Terminal prose punctuation is scanned once rather than matched by an end-anchored repetition. A pasted
    // run of punctuation stays prose and cannot make zero-hit recovery polynomial in the query length.
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
    // The iq index dir self-excludes in every mode: it must never index or surface itself.
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
    expect(withIgnored.result.groups.map((group) => group.path)).toEqual(["alpha/dist/decoy.js"]);
    const without = await engine.run(request({ verb: "find", query: "IGNORED_BUILD_ARTIFACT" }));
    expect(without.result.total).toBe(0);
});

test("the sweep, not ripgrep's own ignore handling: decides what find can match", async () => {
    // git's repo-local excludes are a source rg reads and the sweep does not. A workspace whose code sits under
    // such an exclude answered files/ask normally while every find returned zero; the sweep is the authority.
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
    expect(first.result.cursor).toBeDefined();

    const next = await engine.run(request({ verb: "find", query: "widget", render: { budget: 4000, after: first.result.cursor! } }));
    expect(next.exitCode).toBe(0);
    // Pages never overlap.
    const firstPaths = first.result.groups.map((group) => group.path);
    const nextPaths = new Set(next.result.groups.map((group) => group.path));
    expect(firstPaths.filter((path) => nextPaths.has(path))).toEqual([]);
    expect(first.result.total).toBe(next.result.total);
});

/* A NARROWED search is handed its surviving paths as the scan's arguments rather than the whole tree, so that
 * narrowing makes it faster instead of merely smaller. The optimisation is only sound if it changes nothing
 * about the answer, so that is what this asserts: the scoped run's hits are exactly the unscoped run's hits
 * for the same files. A mistranslated scope would show up here as a missing file or a short group. */
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
    // And it did not quietly drop a file the scope admits: every in-scope file the unscoped run found is here.
    const inScope = unscoped.result.groups.filter((group) => /^alpha\/src\/[^/]+\.ts$/.test(group.path)).map((group) => group.path);
    expect(paths.toSorted()).toEqual(inScope.toSorted());
});

/* A list caller's first page stops the scan one past the page it asked for, which is the whole latency fix. The
 * page after it re-runs UNCAPPED and slices at the offset, and these two have to agree: the ceilinged page is
 * the path-order prefix of exactly the set the continuation walks, so pages cannot overlap or skip. */
test("a ceilinged list page and the page after it are one continuous result", async () => {
    const page = { hits: 2, files: 1 };
    const first = await engine.run(request({ verb: "find", query: "widget", options: { literal: true }, render: { budget: 1500, list: page } }));
    expect(first.result.groups).toHaveLength(1);
    expect(first.result.truncated).toBe(true);
    expect(first.result.cursor).toBeDefined();
    // The scan stopped early, so the counts beside it are floors and say so through the same flag a per-file
    // cap sets. A panel renders this as "N+".
    expect(first.result.partial).toBe(true);

    const next = await engine.run(
        request({ verb: "find", query: "widget", options: { literal: true }, render: { budget: 1500, list: page, after: first.result.cursor! } }),
    );
    expect(next.result.groups.length).toBeGreaterThan(0);
    const seen = new Set(first.result.groups.map((group) => group.path));
    expect(next.result.groups.filter((group) => seen.has(group.path))).toEqual([]);
    // The continuation was not ceilinged, so ITS total is the real one, and it is at least what page one could
    // see. This is the assertion that fails if a ceiling ever leaks onto a continuation.
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
