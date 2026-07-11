import { run, type StricliProcess } from "@stricli/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureWorkspace } from "@intentic/iq-engine/testing";
import { app } from "./app.js";
import { echoOf } from "./lib/flags.js";
import { parseMultiLine, resolveMode, runMulti } from "./lib/run.js";

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    process.env["WORKSPACE_ROOT"] = root;
});
afterAll(async () => {
    delete process.env["WORKSPACE_ROOT"];
    await cleanup();
});

const invoke = async (argv: string[]): Promise<{ out: string; err: string; exitCode: number }> => {
    let out = "";
    let err = "";
    const fake = {
        stdout: { write: (chunk: string) => void (out += chunk) },
        stderr: { write: (chunk: string) => void (err += chunk) },
        env: process.env,
        exitCode: undefined as number | string | null | undefined,
    };
    await run(app, argv, { process: fake as unknown as StricliProcess });
    const code = typeof fake.exitCode === "number" ? fake.exitCode : 0;
    return { out, err, exitCode: code !== 0 && code !== 1 ? 2 : code };
};

test("bare query routes to q (defaultCommand)", async () => {
    const { out, exitCode } = await invoke(["createWidget"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("iq: createWidget —");
    expect(out).toContain("repositories/alpha/src/widget.ts");
});

test("find: hits → 0, zero hits → 1, bad regex → 2", async () => {
    expect((await invoke(["find", "createWidget"])).exitCode).toBe(0);
    expect((await invoke(["find", "zz_never_zz"])).exitCode).toBe(1);
    expect((await invoke(["find", "(*bad"])).exitCode).toBe(2);
});

test("--json emits a single IqResult document", async () => {
    const { out } = await invoke(["files", "widget", "--json"]);
    const result = JSON.parse(out) as { mode: string; groups: { path: string }[] };
    expect(result.mode).toBe("files");
    expect(result.groups[0]?.path).toBe("repositories/alpha/src/widget.ts");
});

test("--ndjson emits one line per group plus a result line", async () => {
    const { out } = await invoke(["find", "createWidget", "--ndjson"]);
    const lines = out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string });
    expect(lines.at(-1)?.kind).toBe("result");
    expect(lines.slice(0, -1).every((line) => line.kind === "group")).toBe(true);
});

test("--json + --ndjson is a usage error (exit 2)", async () => {
    expect((await invoke(["find", "x", "--json", "--ndjson"])).exitCode).toBe(2);
});

test("scope flags pass through (--lang)", async () => {
    const { out } = await invoke(["find", "widget", "--lang", "python", "--json"]);
    const result = JSON.parse(out) as { groups: { path: string }[] };
    expect(result.groups.every((group) => group.path.endsWith(".py"))).toBe(true);
});

test("ask without a model degrades to the lexical fallback; usage errors exit 2 with one line", async () => {
    const ask = await invoke(["ask", "how are widgets built?"]);
    expect(ask.out).toContain("no embedding backend — BM25 only");

    const usage = await invoke(["ast", "createWidget($A)"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.err).toContain("--lang is required");
});

test("index status reports counts", async () => {
    const { out, exitCode } = await invoke(["index", "status"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/iq index: generation \d+ · \d+ files/);
});

test("echoOf reconstructs the continuation command", () => {
    expect(echoOf("refs", "createIgnoreScope", { ignored: false }, { refKind: "call" })).toBe("refs createIgnoreScope --kind call");
    expect(echoOf("q", "how does x work?", { ignored: true, lang: ["ts"] }, {})).toBe('"how does x work?" --lang ts --ignored');
});

test("resolveMode: flags beat env", () => {
    expect(resolveMode({ json: false, ndjson: false }, "ndjson")).toBe("ndjson");
    expect(resolveMode({ json: true, ndjson: false }, "text")).toBe("json");
    expect(() => resolveMode({ json: true, ndjson: true }, "text")).toThrow();
});

test("--lang accepts extensions and canonical names alike; unknown tokens exit 2", async () => {
    const byExt = await invoke(["find", "widget", "--lang", "py", "--json"]);
    const result = JSON.parse(byExt.out) as { groups: { path: string }[] };
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups.every((group) => group.path.endsWith(".py"))).toBe(true);

    const unknown = await invoke(["find", "widget", "--lang", "klingon"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.err).toContain('unknown --lang "klingon"');
});

test("zero hits always carry a diagnostic hint", async () => {
    const dialect = await invoke(["find", "spooled\\|spool"]);
    expect(dialect.exitCode).toBe(1);
    expect(dialect.out).toContain("hint:");
    expect(dialect.out).toContain("rust regex");

    const scoped = await invoke(["find", "zz_never_zz", "--lang", "py"]);
    expect(scoped.out).toContain("scope may be too narrow");

    const def = await invoke(["def", "zz_never_zz"]);
    expect(def.out).toContain("iq sym 'zz_never_zz*'");
});

test("parseMultiLine: quoted query and per-line flags parse instead of being searched literally", () => {
    const parsed = parseMultiLine('find "createWidget" --lang ts --in repositories/alpha');
    expect(parsed.error).toBeUndefined();
    expect(parsed.verb).toBe("find");
    expect(parsed.query).toBe("createWidget");
    expect(parsed.scope).toEqual({ lang: ["ts"], in: ["repositories/alpha"] });
});

test("parseMultiLine: errors on unknown flags, unknown langs, and bad kinds — never literal-searches them", () => {
    expect(parseMultiLine("find foo -i -A 2").error).toContain("unknown flag");
    expect(parseMultiLine("find foo --lang klingon").error).toContain('unknown --lang "klingon"');
    expect(parseMultiLine("refs foo --kind banana").error).toContain("--kind for refs");
    expect(parseMultiLine("ast '$FN($$$)'").error).toContain("ast needs --lang");
});

test("parseMultiLine: bare lines stay auto-mode with the full text as query", () => {
    const parsed = parseMultiLine("where is the widget registry");
    expect(parsed.verb).toBe("q");
    expect(parsed.query).toBe("where is the widget registry");
});

test("multi: flagged sub-lines hit, error lines report without aborting the batch", async () => {
    let out = "";
    const context = {
        process: {
            stdout: { write: (chunk: string) => void (out += chunk) },
            stderr: { write: () => true },
            env: process.env,
            exitCode: undefined as number | string | null | undefined,
        },
    };
    const flags = { budget: 1500, filesOnly: false, count: false, full: false, json: false, ndjson: false, ignored: false };
    await runMulti(
        context as unknown as Parameters<typeof runMulti>[0],
        flags as Parameters<typeof runMulti>[1],
        'find "createWidget" --lang ts\nfind foo --bogus\ndef zz_nope',
    );
    expect(out).toContain("[1/3] iq: find createWidget --lang ts —");
    expect(out).toContain("widget.ts");
    expect(out).toContain("[2/3] iq: find foo --bogus — error: unknown flag --bogus");
    expect(out).toContain("[3/3]");
    expect(context.process.exitCode).toBe(0);
});
