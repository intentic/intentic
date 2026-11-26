import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceSearchGroup } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { createTextSearch, type TextQuery } from "./text-search.js";

// The box's text search with a real rg: an answer that found nothing says what one of the box's switches would have
// found, and what the probes find never streams as the answer's own files.

let root: string;

const put = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
};

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "box-probes-"));
    execFileSync("git", ["init", "-q", root]);
    await put(".gitignore", "dist/\n");
    await put("src/widget.ts", "export const FooBar = 1;\n");
    await put("dist/bundle.js", "var onlyBuilt = 1;\n");
});
afterAll(() => rm(root, { recursive: true, force: true }));

const query = (text: string, more: Partial<TextQuery> = {}): TextQuery => ({
    root,
    query: text,
    literal: false,
    word: false,
    caseSensitive: false,
    ignored: false,
    paths: undefined,
    globs: [],
    notGlobs: [],
    page: { hits: 100, files: 10 },
    after: undefined,
    ...more,
});

test("an empty answer's note names what a switch of the box would have found, and none of it streams", async () => {
    const streamed: WorkspaceSearchGroup[] = [];
    const { result } = await createTextSearch({ rgPath: undefined }).find(query("onlyBuilt"), undefined, (group) => streamed.push(group));
    expect(result.groups).toEqual([]);
    expect(result.note).toBe("no matches. Would match: with Search ignored files on → 1 file (dist/bundle.js)");
    expect(streamed).toEqual([]);
    const cased = await createTextSearch({ rgPath: undefined }).find(query("foobar", { caseSensitive: true }));
    expect(cased.result.note).toBe("no matches. Would match: with Match case off → 1 file (src/widget.ts)");
});

test("an answer with matches, or with nothing anywhere, carries no such note", async () => {
    const search = createTextSearch({ rgPath: undefined });
    expect((await search.find(query("FooBar"))).result.note).toBeUndefined();
    expect((await search.find(query("zzz_absent_zzz"))).result.note).toBeUndefined();
});
