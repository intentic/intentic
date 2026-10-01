import { extractReferences, type NameRef, type PathRef } from "./extract.js";

const paths = (text: string): Omit<PathRef, "kind" | "raw">[] =>
    extractReferences(text)
        .filter((ref): ref is PathRef => ref.kind === "path")
        .map(({ line, path, start, end }) => ({ line, path, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }));

const names = (text: string): string[] =>
    extractReferences(text)
        .filter((ref): ref is NameRef => ref.kind === "name" && ref.plain === undefined)
        .map((ref) => ref.name);

test("code-span paths, with and without anchors, in the forms answers write them", () => {
    expect(
        paths(
            [
                "- `src/click/core.py:2687` and `:2693` read the variable.",
                "- `src/render/cursor.ts:9-17` holds the spool, `lib/core/settle.js#L15-L28` settles.",
                "- `gin.go` routes, `tree.go:418` matches.",
            ].join("\n"),
        ),
    ).toEqual([
        { line: 1, path: "src/click/core.py", start: 2687 },
        { line: 1, path: "src/click/core.py", start: 2693 },
        { line: 2, path: "src/render/cursor.ts", start: 9, end: 17 },
        { line: 2, path: "lib/core/settle.js", start: 15, end: 28 },
        { line: 3, path: "gin.go" },
        { line: 3, path: "tree.go", start: 418 },
    ]);
});

test("prose paths need a directory, and a written-out range attaches to the path before it", () => {
    expect(paths("The limit is in src/middleware/body-limit/index.ts, lines 81–94; see index.ts too.")).toEqual([
        { line: 1, path: "src/middleware/body-limit/index.ts" },
        { line: 1, path: "src/middleware/body-limit/index.ts", start: 81, end: 94 },
    ]);
});

test("names: calls, chains, snake/camel/Pascal/CONSTANT spans; plain words and literals are not names", () => {
    expect(
        names("`syncModel` calls `clearVectors(db)` via `Option.resolve_envvar_value`; `PATTERNS`, `WidgetBox`, `size`, `true`, `None`, `etag`"),
    ).toEqual(["syncModel", "clearVectors", "resolve_envvar_value", "PATTERNS", "WidgetBox"]);
});

test("a plain lowercase word in backticks is kept for drift checks only", () => {
    const refs = extractReferences("`tree.go:418` — `getValue` walks it, `settle` too; `ok` and `true` are skipped");
    expect(refs.filter((ref): ref is NameRef => ref.kind === "name").map((ref) => [ref.name, ref.plain ?? false])).toEqual([
        ["getValue", false],
        ["settle", true],
    ]);
});

test("Go's receiver form names the method", () => {
    expect(names("`(*node).insertChild` and `(Engine).Run(ctx)`")).toEqual(["insertChild", "Run"]);
});

test("a dotted identifier is a name, not a file, unless its extension is a known one", () => {
    const refs = extractReferences("`response.status` and `os.environ` but `app.py`");
    expect(refs.filter((ref) => ref.kind === "name").map((ref) => (ref as NameRef).name)).toEqual(["status", "environ"]);
    expect(refs.filter((ref) => ref.kind === "path").map((ref) => (ref as PathRef).path)).toEqual(["app.py"]);
});

test("fenced code: calls and imports are checked, what the block defines and shell blocks are not", () => {
    const text = [
        "```python",
        "from flask.sessions import SecureCookieSessionInterface, NullSession",
        "def helper():",
        "    return iface.rotate_keys(app)  # comment_call()",
        'helper(); print("not_a_call()")',
        "```",
        "```sh",
        "pnpm install && run_thing()",
        "```",
    ].join("\n");
    const refs = extractReferences(text).filter((ref): ref is NameRef => ref.kind === "name");
    expect(refs.map((ref) => ref.name)).toEqual(["SecureCookieSessionInterface", "NullSession", "rotate_keys"]);
    expect(refs.every((ref) => ref.inCode)).toBe(true);
    expect(refs.find((ref) => ref.name === "rotate_keys")?.line).toBe(4);
});

test("iq read's path::symbol form yields both the path and the name", () => {
    const refs = extractReferences("`beta/app.py::WidgetBox::pack`");
    expect(refs).toEqual([
        { kind: "path", line: 1, raw: "beta/app.py::WidgetBox::pack", path: "beta/app.py" },
        { kind: "name", line: 1, raw: "beta/app.py::WidgetBox::pack", name: "pack", inCode: false },
    ]);
});
