import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupedFolders, workspaceActivityOf } from "./workspace-activity.js";

// Real repositories, since what is pinned is how git's own history is read: which folder a commit counts toward, what
// does not count, and that a nested repository is read under its own area.

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (dir: string, ...args: string[]): void => {
    execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
};

const write = async (dir: string, files: Record<string, string>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
};

const repo = async (dir?: string): Promise<string> => {
    const at = dir ?? (await mkdtemp(join(tmpdir(), "workspace-activity-")));
    if (dir === undefined) {
        dirs.push(at);
    }
    await mkdir(at, { recursive: true });
    git(at, "init", "-q", "-b", "main");
    return at;
};

// One commit per call; the content changes each time so every commit touches what it names.
let edits = 0;
const commit = async (dir: string, ...paths: string[]): Promise<void> => {
    edits += 1;
    await write(dir, Object.fromEntries(paths.map((path) => [path, String(edits)])));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `edit ${edits}`);
};

// A feature shelf: four folders and no files of its own, the shape that is opened one more level.
const SHELF = ["chat", "agents", "sandbox", "workspace"].map((name) => `app/src/features/${name}/index.ts`);

test("commits count toward the feature-sized folder they touched, busiest first", async () => {
    const root = await repo();
    await commit(root, ...SHELF);
    await commit(root, "app/src/features/chat/panel/Pane.vue");
    await commit(root, "app/src/features/chat/tabs/Tabs.vue", "app/src/features/chat/panel/Pane.vue");
    await commit(root, "app/src/features/agents/board/Board.vue");
    await commit(root, "lib/src/util.ts");

    const { commits, hot } = workspaceActivityOf({ projectRoot: root, areas: ["app", "lib"] });

    expect(commits).toBe(5);
    // A commit counts once per folder however many files it touched there; `features` is a shelf, so it is opened.
    expect(hot.slice(0, 3)).toEqual([
        { folder: "app/src/features/chat", commits: 3 },
        { folder: "app/src/features/agents", commits: 2 },
        { folder: "app/src/features/sandbox", commits: 1 },
    ]);
    expect(hot.map((entry) => entry.folder)).toContain("lib/src");
});

test("docs, lockfiles, translations and generated output say nothing about where work is", async () => {
    const root = await repo();
    await commit(root, "app/src/main.ts");
    await commit(root, "app/README.md", "pnpm-lock.yaml", "app/src/locales/en.json", "app/src/generated/schema.json");

    const { commits, hot, byFolder } = workspaceActivityOf({ projectRoot: root, areas: ["app"] });

    expect(commits).toBe(2);
    expect(hot).toEqual([{ folder: "app/src", commits: 1 }]);
    expect(byFolder.get("app")).toBe(1);
});

test("a nested repository is read too, under its own area's name", async () => {
    const root = await repo();
    await commit(root, "notes/todo.ts");
    const inner = await repo(join(root, "product"));
    await commit(inner, "server/src/api/routes.ts");
    await commit(inner, "server/src/api/routes.ts");

    const { byFolder } = workspaceActivityOf({ projectRoot: root, areas: ["notes", "product"] });

    expect(byFolder.get("product/server/src/api")).toBe(2);
    expect(byFolder.get("notes")).toBe(1);
});

test("a project with no history has no activity, and no error", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-activity-"));
    dirs.push(root);
    await write(root, { "app/src/main.ts": "" });

    expect(workspaceActivityOf({ projectRoot: root, areas: ["app"] })).toEqual({ commits: 0, byFolder: new Map(), hot: [] });
});

test("folders sharing a parent read as one entry, and top-level names stay a plain list", () => {
    expect(groupedFolders(["web/features/chat", "contract/schemas", "web/features/agents", "video", "docs"])).toEqual([
        "web/features/{chat,agents}",
        "contract/schemas",
        "video",
        "docs",
    ]);
});
