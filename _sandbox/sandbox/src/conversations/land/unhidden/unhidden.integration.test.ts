import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/base/git";
import { pathExists } from "@intentic/base/fs";
import { ignoredBeforeLand, settleUnhidden, unhiddenSentences } from "./unhidden.js";

// A land that moves a folder and its .gitignore lines leaves the build output the old lines hid behind, hidden by
// nothing (shinobi-society, 2026-11-21: 4,992 files). Replayed here as a land writes it: the delta's patch applied to a
// main tree holding ignored files the branch never had.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout;
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

const put = async (root: string, files: Record<string, string>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
};

// A main tree at `from` holding `ignored` build files, and the delta from..tip a branch made with `change`, written into
// the tree as a land writes it (apply of the binary patch). Answers what the tree ignored before the write.
const landed = async (
    tracked: Record<string, string>,
    ignored: Record<string, string>,
    change: (branch: string) => Promise<void>,
): Promise<{ main: string; from: string; tip: string; before: Awaited<ReturnType<typeof ignoredBeforeLand>> }> => {
    const main = await mkdtemp(join(tmpdir(), "unhidden-"));
    roots.push(main);
    await sh(main, "init", "-q", "-b", "main");
    await sh(main, "config", "user.email", "t@example.com");
    await sh(main, "config", "user.name", "t");
    await put(main, tracked);
    await sh(main, "add", "-A");
    await sh(main, "commit", "-q", "-m", "base");
    const from = (await sh(main, "rev-parse", "HEAD")).trim();
    await put(main, ignored);
    const branch = join(main, "..", `${main.split("/").at(-1)}-branch`);
    roots.push(branch);
    await sh(main, "worktree", "add", "-q", "-b", "agent", branch);
    await change(branch);
    await sh(branch, "add", "-A");
    await sh(branch, "commit", "-q", "-m", "move");
    const tip = (await sh(branch, "rev-parse", "HEAD")).trim();
    const before = await ignoredBeforeLand(main, from, tip, defaultGit);
    const patch = join(branch, "..", `${main.split("/").at(-1)}.patch`);
    roots.push(patch);
    await sh(main, "diff", "--binary", `--output=${patch}`, from, tip);
    await sh(main, "apply", patch);
    return { main, from, tip, before };
};

// What is on show in the tree that the land did not write itself: its own new files are uncommitted there too.
const untracked = async (main: string, from: string, tip: string): Promise<string[]> => {
    const written = new Set((await sh(main, "diff", "--name-only", from, tip)).split("\n"));
    return (await sh(main, "ls-files", "--others", "--exclude-standard")).split("\n").filter((path) => path !== "" && !written.has(path));
};

const CLIENT = {
    ".gitignore": "/target\n/games/client-web/www/pkg\n/games/client-web/www/assets\n/games/client-web/www/**/*.gz\n",
    "games/client-web/src/lib.rs": "pub fn run() {}\n",
    "games/client-web/src/world.rs": "pub fn world() {}\n",
    "games/client-web/www/index.html": "<html></html>\n",
};
const BUILT = {
    "games/client-web/www/pkg/client.wasm": "wasm",
    "games/client-web/www/assets/ninja.imodel": "model",
    "games/client-web/www/assets/nested/oni.imodel": "model",
    "games/client-web/www/index.html.gz": "gz",
};

// The branch's move: `games/client-web` to `games/client/web`, its ignore lines with it.
const moveClient = async (branch: string): Promise<void> => {
    await mkdir(join(branch, "games/client"), { recursive: true });
    await sh(branch, "mv", "games/client-web", "games/client/web");
    await writeFile(join(branch, ".gitignore"), CLIENT[".gitignore"].replaceAll("/games/client-web/", "/games/client/web/"));
};

test("build output follows the folder a land renamed, still ignored, and the old folder is gone", async () => {
    const { main, from, tip, before } = await landed(CLIENT, BUILT, moveClient);
    expect(before?.rows).toEqual(expect.arrayContaining(["games/client-web/www/pkg/", "games/client-web/www/assets/", "games/client-web/www/index.html.gz"]));
    expect(await untracked(main, from, tip)).toHaveLength(4);
    const settled = await settleUnhidden("root", main, before!, from, tip, defaultGit);
    expect(await untracked(main, from, tip)).toEqual([]);
    expect(await readFile(join(main, "games/client/web/www/pkg/client.wasm"), "utf8")).toBe("wasm");
    expect(await readFile(join(main, "games/client/web/www/assets/nested/oni.imodel"), "utf8")).toBe("model");
    expect(await pathExists(join(main, "games/client/web/www/index.html.gz"))).toBe(true);
    expect(await pathExists(join(main, "games/client-web"))).toBe(false);
    expect(settled).toEqual({ repo: "root", moved: [{ path: "games/client-web/", to: "games/client/web/", files: 4, bytes: 16 }], kept: [] });
    expect(unhiddenSentences(settled!)).toEqual(["Moved 4 ignored files (16 B) along with games/client-web/ to games/client/web/, where the new ignore rules hide them."]);
});

test("what no rename carries is hidden where it is, by the paths the old rules hid, and nothing is deleted", async () => {
    const tracked = { ".gitignore": "/target\n/saves\n", "src/main.rs": "fn main() {}\n" };
    const { main, from, tip, before } = await landed(tracked, { "saves/world-1.db": "world", "target/debug/app": "bin" }, async (branch) => {
        await writeFile(join(branch, ".gitignore"), "/target\n");
    });
    expect(await untracked(main, from, tip)).toEqual(["saves/world-1.db"]);
    const settled = await settleUnhidden("root", main, before!, from, tip, defaultGit);
    expect(await untracked(main, from, tip)).toEqual([]);
    expect(await readFile(join(main, "saves/world-1.db"), "utf8")).toBe("world");
    const exclude = await readFile(join(main, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("# intentic: kept hidden after a land changed the ignore rules that hid them\n/saves/\n");
    expect(settled).toEqual({ repo: "root", moved: [], kept: [{ path: "saves/", files: 1, bytes: 5 }] });
});

test("a file whose new place is taken stays, hidden, and the rest of its folder still moves", async () => {
    const { main, from, tip, before } = await landed(CLIENT, BUILT, async (branch) => {
        await moveClient(branch);
        // The branch commits a file where one of main's ignored ones would go: not ignored there, so it cannot be overwritten.
        await put(branch, { "games/client/web/www/index.html.gz": "committed" });
        await writeFile(join(branch, ".gitignore"), "/target\n/games/client/web/www/pkg\n/games/client/web/www/assets\n");
    });
    const settled = await settleUnhidden("root", main, before!, from, tip, defaultGit);
    expect(await untracked(main, from, tip)).toEqual([]);
    expect(await readFile(join(main, "games/client/web/www/index.html.gz"), "utf8")).toBe("committed");
    expect(await readFile(join(main, "games/client-web/www/index.html.gz"), "utf8")).toBe("gz");
    expect(settled?.moved).toEqual([{ path: "games/client-web/", to: "games/client/web/", files: 3, bytes: 14 }]);
    expect(settled?.kept).toEqual([{ path: "games/client-web/www/", files: 1, bytes: 2 }]);
});

test("a land that starts versioning a folder its rules hid keeps its own files on show and hides only the old ones", async () => {
    const tracked = { ".gitignore": "/dist\n", "src/app.ts": "app\n" };
    const { main, from, tip, before } = await landed(tracked, { "dist/old.js": "stale" }, async (branch) => {
        await writeFile(join(branch, ".gitignore"), "");
        await put(branch, { "dist/app.js": "built" });
    });
    const settled = await settleUnhidden("root", main, before!, from, tip, defaultGit);
    const shown = (await sh(main, "ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
    expect(shown).toEqual(["dist/app.js"]);
    expect(settled?.kept).toEqual([{ path: "dist/", files: 1, bytes: 5 }]);
});

test("a land that changes no ignore file reads nothing more than its names", async () => {
    const { before } = await landed(CLIENT, BUILT, async (branch) => {
        await writeFile(join(branch, "games/client-web/src/lib.rs"), "pub fn run() { /* faster */ }\n");
    });
    expect(before).toBeUndefined();
});
