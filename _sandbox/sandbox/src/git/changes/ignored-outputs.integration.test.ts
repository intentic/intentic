import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { IGNORED_OUTPUTS_LISTED } from "@intentic/sandbox-contract/schemas/git/git";
import { copyIntoMain, ignoredOutputsOf, isDeliverableName, isOutputPath, namedIgnoredOutputs } from "./ignored-outputs.js";

// Against real git and a real worktree: what an ignore rule hides is git's answer, and whose file it is is the main
// tree's, so no stub could say either.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const put = async (dir: string, path: string, content: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
};

// A main tree ignoring `out/`, `dist/`, `target/`, `*.mp4` and `node_modules/`, and a conversation's copy of it cut as a worktree, which
// holds the tracked files and nothing ignored, as every agent copy starts.
const setup = async (): Promise<{ main: string; copy: string; outside: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-ignored-"));
    tempDirs.push(base);
    const main = join(base, "main");
    const copy = join(base, "copy");
    const outside = join(base, "outside");
    await mkdir(main);
    await mkdir(outside);
    await sh(main, "init", "-q", "--initial-branch=main");
    await put(main, ".gitignore", "out/\ndist/\ntarget/\n*.mp4\nnode_modules/\n__pycache__/\n*.log\n.env\n.cache/\n");
    await put(main, "src/app.ts", "export {};\n");
    await sh(main, "add", "-A");
    await sh(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    await sh(main, "worktree", "add", "-q", "-b", "agent/c1", copy);
    return { main, copy, outside };
};

const listed = async (copy: string, main: string): Promise<string[][]> =>
    (await ignoredOutputsOf(copy, main, [])).paths.map((output) => [output.path, output.kind, String(output.bytes)]);

test("an ignored file the conversation wrote is listed, inside an ignored folder and in a new folder alike", async () => {
    const { main, copy } = await setup();
    await put(copy, "out/film.webm", "twelve bytes");
    await put(copy, "out/plates/one.png", "1");
    // A new folder git would add, holding a file an ignore rule names: `ls-files --directory` drops this one.
    await put(copy, "renders/notes.md", "# notes\n");
    await put(copy, "renders/cut.mp4", "mp4");

    expect(await listed(copy, main)).toEqual([
        ["out/film.webm", "new", "12"],
        ["out/plates/one.png", "new", "1"],
        ["renders/cut.mp4", "new", "3"],
    ]);
});

test("an ignored file main already holds as it is is not listed, and one it holds differently is", async () => {
    const { main, copy } = await setup();
    await put(main, "out/same.pdf", "same bytes");
    await put(copy, "out/same.pdf", "same bytes");
    // Same size, other bytes, other time: only a read tells them apart.
    await put(main, "out/edited.csv", "version A");
    await put(copy, "out/edited.csv", "version B");
    await utimes(join(copy, "out/edited.csv"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    await put(main, "out/grown.pdf", "short");
    await put(copy, "out/grown.pdf", "longer than before");

    expect(await listed(copy, main)).toEqual([
        ["out/edited.csv", "changed", "9"],
        ["out/grown.pdf", "changed", "18"],
    ]);
});

test("dependencies, hidden files and folders, caches, logs, links and other checkouts are never listed", async () => {
    const { main, copy, outside } = await setup();
    await put(copy, "node_modules/left-pad/index.js", "module.exports = 1;\n");
    await put(copy, "out/node_modules/dep/index.js", "x");
    await put(copy, "tools/__pycache__/mod.cpython-312.pyc", "pyc");
    await put(copy, ".env", "TOKEN=1\n");
    await put(copy, ".cache/blob", "cached");
    await put(copy, "out/.hidden/kept.txt", "hidden");
    await put(copy, "out/run.log", "log");
    await put(copy, "out/sub/.git", "gitdir: elsewhere\n");
    await put(copy, "out/sub/inside.png", "another checkout's");
    await put(outside, "secret.png", "not yours");
    await symlink(outside, join(copy, "out", "linked"));
    await symlink(join(outside, "secret.png"), join(copy, "out", "secret.png"));
    await put(copy, "out/kept.png", "kept");

    expect(await listed(copy, main)).toEqual([["out/kept.png", "new", "4"]]);
    expect(isOutputPath("out/kept.png")).toBe(true);
    expect(isOutputPath("out/../escape.png")).toBe(false);
});

test("what a build regenerates is never offered: code, maps and declarations, and anything in a tagged cache", async () => {
    const { main, copy } = await setup();
    await put(copy, "dist/index.js", "export {};\n");
    await put(copy, "dist/index.js.map", "{}");
    await put(copy, "dist/index.d.ts", "export {};\n");
    await put(copy, "dist/bundle.js.gz", "gz");
    await put(copy, "out/report.json", "{}");
    // Cargo's `target/`: tagged as a cache, so not even the binary it built is entered.
    await put(copy, "target/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n");
    await put(copy, "target/debug/build/libc-1/output", "cargo:rerun-if-changed=build.rs\n");
    await put(copy, "target/release/app.exe", "MZ");
    await put(copy, "out/film.mp4", "mp4");

    expect(await listed(copy, main)).toEqual([["out/film.mp4", "new", "3"]]);
});

test("a deliverable is a file a person opens: media, documents, tables, archives and installers", () => {
    for (const name of ["cut.MP4", "poster.png", "deck.pptx", "export.csv", "site.tar.gz", "app.apk", "Report.PDF"]) {
        expect(isDeliverableName(name)).toBe(true);
    }
    for (const name of ["index.js", "index.js.map", "types.d.ts", "libc.rlib", "main.o", "output", "notes.txt", "bundle.js.gz", "CACHEDIR.TAG"]) {
        expect(isDeliverableName(name)).toBe(false);
    }
});

test("a folder another repository owns is skipped", async () => {
    const { main, copy } = await setup();
    await put(copy, "out/nested/render.png", "r");
    await put(copy, "out/own.png", "o");

    expect((await ignoredOutputsOf(copy, main, ["out/nested"])).paths.map((output) => output.path)).toEqual(["out/own.png"]);
});

test("a render's worth of frames is listed up to the ceiling and counted past it", async () => {
    const { main, copy } = await setup();
    const total = IGNORED_OUTPUTS_LISTED + 15;
    await Promise.all(Array.from({ length: total }, (_, index) => put(copy, `out/frame-${String(index).padStart(4, "0")}.png`, "x")));

    const outputs = await ignoredOutputsOf(copy, main, []);

    expect(outputs.paths).toHaveLength(IGNORED_OUTPUTS_LISTED);
    expect(outputs.paths[0]?.path).toBe("out/frame-0000.png");
    expect(outputs.more).toBe(15);
});

test("copying puts the bytes at the same path in main, never in git's index, and the listing then drops it", async () => {
    const { main, copy } = await setup();
    const render = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
    await put(copy, "out/deep/film.mp4", render);
    await put(main, "out/old.csv", "version A");
    await put(copy, "out/old.csv", "version B, longer");

    const named = await namedIgnoredOutputs(copy, main, ["out/deep/film.mp4", "out/old.csv"], []);
    expect(named).toEqual({
        outside: [],
        not: [],
        same: [],
        named: [
            { path: "out/deep/film.mp4", kind: "new", bytes: 4096 },
            { path: "out/old.csv", kind: "changed", bytes: 17 },
        ],
    });
    await copyIntoMain(copy, main, named.named);

    expect(await readFile(join(main, "out/deep/film.mp4"))).toEqual(render);
    expect(await readFile(join(main, "out/old.csv"), "utf8")).toBe("version B, longer");
    // The source's time to the millisecond, which is how the listing knows the two for the same file without reading.
    expect(Math.trunc((await stat(join(main, "out/old.csv"))).mtimeMs)).toBe(Math.trunc((await stat(join(copy, "out/old.csv"))).mtimeMs));
    // Ignored, so neither staged nor even listed as untracked; the copy keeps its own.
    expect(await sh(main, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await sh(main, "ls-files", "--", "out")).toBe("");
    expect(await sh(main, "diff", "--cached", "--name-only")).toBe("");
    expect(existsSync(join(copy, "out/deep/film.mp4"))).toBe(true);
    expect(await listed(copy, main)).toEqual([]);
    // A second press over the same files finds nothing left to copy.
    expect(await namedIgnoredOutputs(copy, main, ["out/deep/film.mp4"], [])).toEqual({ outside: [], not: [], same: ["out/deep/film.mp4"], named: [] });
});

test("a path that leaves the repository is refused on either side, and one that is no ignored output is named as such", async () => {
    const { main, copy, outside } = await setup();
    await put(outside, "secret.txt", "not yours");
    await symlink(outside, join(copy, "out"));
    await put(copy, "renders/cut.mp4", "mp4");
    await mkdir(join(main, "renders"));
    await symlink(join(outside, "secret.txt"), join(main, "renders", "cut.mp4"));
    await put(copy, "src/app.ts", "export const changed = 1;\n");
    await put(copy, "dist/index.js", "export {};\n");
    // Of a deliverable's type, but tracked: git does not ignore it, so no copy beside git is its way to main.
    await put(copy, "docs/diagram.png", "png");
    await sh(copy, "add", "docs/diagram.png");

    const named = await namedIgnoredOutputs(
        copy,
        main,
        ["../outside/secret.txt", "/etc/passwd", "out/secret.txt", "renders/cut.mp4", "src/app.ts", ".env", "dist/index.js", "docs/diagram.png"],
        [],
    );

    expect(named).toEqual({
        outside: ["../outside/secret.txt", "/etc/passwd", "out/secret.txt", "renders/cut.mp4"],
        // Source and build output are no type a person opens, a hidden file is never an output, and a tracked one is no
        // ignored file at all.
        not: ["src/app.ts", ".env", "dist/index.js", "docs/diagram.png"],
        same: [],
        named: [],
    });
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("not yours");
});
