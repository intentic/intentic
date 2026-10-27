import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { findText, scanText } from "./text-search.js";

// The box's text search over a real tree with a real rg: which files the walk admits, how a scope narrows it, where the
// ceiling stops it, and the recoveries it shares with `iq find`.

let parent: string;
let root: string;

const put = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
};

beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), "iq-text-"));
    root = join(parent, "work");
    await put(".gitignore", "*.log\n/build/\n");
    await put("app/src/widget.ts", "export const needle = 1;\n");
    await put("app/src/widget.test.ts", "needle in a test\n");
    await put("app/.gitignore", "generated/\n");
    await put("app/generated/out.ts", "needle generated\n");
    await put("app/notes.log", "needle logged\n");
    await put("build/bundle.js", "needle built\n");
    await put("node_modules/pkg/index.js", "needle installed\n");
    await put(".env.example", "NEEDLE=1\n");
    await put(`${STATE_DIR}/local/cache/iq/index.txt`, "needle in the index\n");
    await put("docs/many.md", Array.from({ length: 60 }, (_, line) => `needle ${line}`).join("\n"));
    await put("refs/other/a.ts", "needle on the shelf\n");
});
afterAll(() => rm(parent, { recursive: true, force: true }));

const paths = async (options: Partial<Parameters<typeof scanText>[0]> = {}): Promise<string[]> =>
    (await scanText({ root, pattern: "needle", literal: true, ...options })).groups.map((group) => group.path);

test("the walk admits what the sweep does: .gitignore at any depth without a repository, dotfiles in, junk and the shelf out", async () => {
    expect(await paths()).toEqual([".env.example", "app/src/widget.test.ts", "app/src/widget.ts", "docs/many.md"]);
});

test("ignored widens into everything a .gitignore or the junk list names, and the floor still holds", async () => {
    const found = await paths({ ignored: true });
    expect(found).toContain("node_modules/pkg/index.js");
    expect(found).toContain("app/generated/out.ts");
    expect(found).toContain("app/notes.log");
    expect(found).toContain("build/bundle.js");
    expect(found.some((path) => path.startsWith(`${STATE_DIR}/`))).toBe(false);
});

test("a subtree narrows the walk and keeps the ignore files above it; a missing one finds nothing", async () => {
    expect(await paths({ paths: ["app"] })).toEqual(["app/src/widget.test.ts", "app/src/widget.ts"]);
    expect(await paths({ paths: ["./app/src/"] })).toEqual(["app/src/widget.test.ts", "app/src/widget.ts"]);
    expect(await paths({ paths: ["nowhere"] })).toEqual([]);
    expect(await paths({ paths: [] })).toEqual([]);
});

test("with a .gitignore above the root, a subtree is still narrowed and the rules above the root never apply", async () => {
    await writeFile(join(parent, ".gitignore"), "*.ts\n");
    try {
        expect(await paths({ paths: ["app"] })).toEqual(["app/src/widget.test.ts", "app/src/widget.ts"]);
        expect(await paths()).toContain("app/src/widget.ts");
    } finally {
        await rm(join(parent, ".gitignore"));
    }
});

test("the include box's globs select and exclude after the walk, so a glob never lets in what a .gitignore drops", async () => {
    expect(await paths({ globs: ["**/*.ts"] })).toEqual(["app/src/widget.test.ts", "app/src/widget.ts"]);
    expect(await paths({ globs: ["**/*.ts"], notGlobs: ["**/*.test.ts"] })).toEqual(["app/src/widget.ts"]);
    expect(await paths({ globs: ["**/*.log"] })).toEqual([]);
});

test("a file keeps fifty lines and says it had more; every match is spanned", async () => {
    const scan = await scanText({ root, pattern: "needle", literal: true, paths: ["docs"] });
    const [group] = scan.groups;
    expect(group?.hits).toHaveLength(50);
    expect(group?.capped).toBe(true);
    expect(group?.hits[0]).toEqual({ line: 1, text: "needle 0", spans: [{ start: 0, end: 6 }], tags: [{ kind: "text" }] });
    expect(scan.ceiling).toBe(false);
});

test("the ceiling stops the scan after the file it lands in, and each file is handed over as it completes", async () => {
    const streamed: string[] = [];
    const scan = await scanText({ root, pattern: "needle", literal: true, maxHits: 1, onGroup: (group) => streamed.push(group.path) });
    expect(scan.ceiling).toBe(true);
    expect(scan.groups).toHaveLength(1);
    expect(streamed).toEqual(scan.groups.map((group) => group.path));
    expect(scan.firstMs).toBeGreaterThanOrEqual(0);
});

test("case, whole words and patterns read as the box's switches say", async () => {
    expect(await paths({ caseSensitive: true, pattern: "NEEDLE" })).toEqual([".env.example"]);
    expect(await paths({ literal: false, pattern: "need(le|ful) \\d+" })).toEqual(["docs/many.md"]);
    expect(await paths({ word: true, pattern: "needl" })).toEqual([]);
});

test("a pattern rg cannot read runs as plain text, and grep-style escapes that matched nothing are rewritten", async () => {
    const literal = await findText({ root, pattern: "needle (", paths: ["app"] });
    expect(literal.note).toContain("ran as literal text");
    const rewritten = await findText({ root, pattern: "needle \\(generated\\|in a\\)", paths: ["app"] });
    expect(rewritten.note).toContain("grep-style escapes rewritten");
    expect(rewritten.groups.map((group) => group.path)).toEqual(["app/src/widget.test.ts"]);
});

test("an aborted search rejects and leaves nothing running", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scanText({ root, pattern: "needle", signal: controller.signal })).rejects.toThrow();
});
