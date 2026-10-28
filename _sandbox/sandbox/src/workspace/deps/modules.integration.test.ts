import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        // Nested inside another module: an app with its own operator UI is a module of its own.
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

    expect((await readModules(dir)).toSorted((a, b) => a.dir.localeCompare(b.dir))).toEqual([
        { dir: "_apps/web", name: "@shop/web" },
        { dir: "_apps/web/operator", name: "@shop/web-operator" },
        { dir: "_libs/ui", name: "@shop/ui" },
        { dir: "scratch/tool", name: "@shop/tool" },
    ]);
    await rm(dir, { recursive: true, force: true });
});

test("readModules takes the repo's own manifest only when nothing under it is a module", async () => {
    const single = await scaffold({ "package.json": pkg("@shop/cli"), "src/index.ts": "" });
    expect(await readModules(single)).toEqual([{ dir: "", name: "@shop/cli" }]);

    const none = await scaffold({ "src/main.py": "" });
    expect(await readModules(none)).toEqual([]);

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

    expect(await readModules(dir)).toEqual([{ dir: "_apps/web", name: "@shop/web" }]);
    await rm(dir, { recursive: true, force: true });
});

const crate = (name: string): string => `[package]\nname = "${name}"\nversion = "0.1.0"\n`;

test("readModules groups a Cargo workspace by its crates", async () => {
    const dir = await scaffold({
        // A virtual manifest names no crate: the workspace root is not a module, as a pnpm root without a name.
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
        "Cargo.lock": "",
        "crates/core/Cargo.toml": crate("shop-core"),
        "crates/cli/Cargo.toml": crate("shop-cli"),
        // A crate shipping an npm binding names itself by the package people import.
        "bindings/node/Cargo.toml": crate("shop-napi"),
        "bindings/node/package.json": pkg("@shop/native"),
        // Not modules: a manifest mid-edit, one with no [package], and cargo's packaged copies under target/.
        "crates/broken/Cargo.toml": "[package\nname =",
        "crates/meta/Cargo.toml": "[dependencies]\n",
        "target/package/shop-core-0.1.0/Cargo.toml": crate("shop-core"),
    });

    expect((await readModules(dir)).toSorted((a, b) => a.dir.localeCompare(b.dir))).toEqual([
        { dir: "bindings/node", name: "@shop/native" },
        { dir: "crates/cli", name: "shop-cli" },
        { dir: "crates/core", name: "shop-core" },
    ]);
    await rm(dir, { recursive: true, force: true });
});

test("readModules takes a single crate's own Cargo.toml at the repo root, and keeps a target dir that is not cargo's", async () => {
    const single = await scaffold({ "Cargo.toml": crate("shop"), "src/main.rs": "" });
    expect(await readModules(single)).toEqual([{ dir: "", name: "shop" }]);

    // `target` is only cargo's output beside a Cargo manifest; elsewhere it is an ordinary folder name.
    const app = await scaffold({ "deploy/target/aws/package.json": pkg("@shop/aws") });
    expect(await readModules(app)).toEqual([{ dir: "deploy/target/aws", name: "@shop/aws" }]);

    await rm(single, { recursive: true, force: true });
    await rm(app, { recursive: true, force: true });
});
