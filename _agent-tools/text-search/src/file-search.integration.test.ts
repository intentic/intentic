import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { findFiles } from "./file-search.js";

// The box's name search over a real tree with a real rg: the same walk as text search, ranked as quick-open ranks.

let parent: string;
let root: string;

const put = async (path: string, content = ""): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
};

beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), "file-search-"));
    root = join(parent, "work");
    await put(".gitignore", "*.log\n");
    await put("app/src/widget.ts");
    await put("app/src/widget.test.ts");
    await put("app/src/window.ts");
    await put("app/notes.log");
    await put("docs/widgets.md");
    await put("node_modules/widget-lib/index.js");
    await put(`${STATE_DIR}/local/cache/widget.db`);
    await put(`${STATE_DIR}/config/skills/widget/SKILL.md`);
});
afterAll(() => rm(parent, { recursive: true, force: true }));

const found = async (query: string, options: Partial<Parameters<typeof findFiles>[0]> = {}): Promise<string[]> =>
    (await findFiles({ root, query, limit: 50, ...options })).groups.map((group) => group.path);

test("files rank by the quick-open scorer, ignored and junk files left out, the authored state slice kept", async () => {
    expect(await found("widget")).toEqual(["docs/widgets.md", "app/src/widget.ts", "app/src/widget.test.ts", `${STATE_DIR}/config/skills/widget/SKILL.md`]);
    expect(await found("notes")).toEqual([]);
});

test("ignored widens into what a .gitignore or the junk list names, and the floor still holds", async () => {
    const paths = await found("widget", { ignored: true });
    expect(paths).toContain("node_modules/widget-lib/index.js");
    expect(paths).not.toContain(`${STATE_DIR}/local/cache/widget.db`);
    expect((await found("notes", { ignored: true }))[0]).toBe("app/notes.log");
});

test("a glob is matched as a pattern, in path order", async () => {
    expect(await found("app/**/*.ts")).toEqual(["app/src/widget.test.ts", "app/src/widget.ts", "app/src/window.ts"]);
    expect(await found("*.md")).toEqual([`${STATE_DIR}/config/skills/widget/SKILL.md`, "docs/widgets.md"]);
});

test("the limit cuts the page and the count says how many matched", async () => {
    const answer = await findFiles({ root, query: "w", limit: 2 });
    expect(answer.groups).toHaveLength(2);
    expect(answer.files).toBeGreaterThan(2);
    expect(answer.groups.every((group) => group.hits.length === 0)).toBe(true);
    expect(answer.ceiling).toBe(false);
});

test("a subtree narrows the listing, and a missing one finds nothing", async () => {
    expect(await found("widget", { paths: ["docs"] })).toEqual(["docs/widgets.md"]);
    expect(await found("widget", { paths: ["nowhere"] })).toEqual([]);
});
