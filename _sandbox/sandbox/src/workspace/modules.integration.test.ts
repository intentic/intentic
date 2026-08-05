import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readModules } from "./modules.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "modules-"));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

const pkg = (name: string): string => JSON.stringify({ name });

test("readModules finds every named package dir, whatever the layout", async () => {
    const dir = await scaffold({
        "package.json": pkg("@shop/root"),
        "_apps/web/package.json": pkg("@shop/web"),
        // Nested inside another module — an app with its own operator UI is a module of its own.
        "_apps/web/operator/package.json": pkg("@shop/web-operator"),
        "_libs/ui/package.json": pkg("@shop/ui"),
        // Outside any pnpm glob: a package the dependency graph would not list, holding files a reviewer still
        // thinks of by name.
        "scratch/tool/package.json": pkg("@shop/tool"),
        // Not modules: no manifest, an unparseable one, and one that names nothing.
        "_libs/notes/README.md": "",
        "_libs/broken/package.json": "{",
        "_libs/anon/package.json": JSON.stringify({ version: "1.0.0" }),
    });

    expect(readModules(dir).toSorted((a, b) => a.dir.localeCompare(b.dir))).toEqual([
        { dir: "_apps/web", name: "@shop/web" },
        { dir: "_apps/web/operator", name: "@shop/web-operator" },
        { dir: "_libs/ui", name: "@shop/ui" },
        { dir: "scratch/tool", name: "@shop/tool" },
    ]);
    await rm(dir, { recursive: true, force: true });
});

test("readModules takes the repo's own manifest only when nothing under it is a module", async () => {
    const single = await scaffold({ "package.json": pkg("@shop/cli"), "src/index.ts": "" });
    expect(readModules(single)).toEqual([{ dir: "", name: "@shop/cli" }]);

    const none = await scaffold({ "src/main.py": "" });
    expect(readModules(none)).toEqual([]);

    await rm(single, { recursive: true, force: true });
    await rm(none, { recursive: true, force: true });
});

test("readModules skips ignored dirs and nested repos", async () => {
    const dir = await scaffold({
        "_apps/web/package.json": pkg("@shop/web"),
        "_apps/web/node_modules/left-pad/package.json": pkg("left-pad"),
        "dist/bundle/package.json": pkg("@shop/bundle"),
        ".cache/x/package.json": pkg("@shop/cached"),
        // A repo inside the repo: its files arrive under its OWN {repo} id, so its packages are not this
        // repo's modules.
        "vendor/other/.git": "gitdir: /history/gits/other\n",
        "vendor/other/package.json": pkg("@other/app"),
    });

    expect(readModules(dir)).toEqual([{ dir: "_apps/web", name: "@shop/web" }]);
    await rm(dir, { recursive: true, force: true });
});
