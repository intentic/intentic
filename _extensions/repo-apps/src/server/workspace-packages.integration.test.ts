import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageGraph, readWorkspaceManifests } from "./workspace-packages.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pkg-graph-"));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

const pkg = (name: string, blocks: Record<string, Record<string, string>> = {}): string => JSON.stringify({ name, ...blocks });

const graphOf = async (dir: string): ReturnType<typeof readPackageGraph> => readPackageGraph(dir, await readWorkspaceManifests(dir));

test("a repo without pnpm-workspace.yaml has no packages and no edges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pkg-graph-"));
    expect(await graphOf(dir)).toEqual({ packages: [], edges: [] });
    expect(await readWorkspaceManifests(join(dir, "nowhere"))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
});

test("packages come from the globs and edges are typed by dependency block", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "_apps/*"\n  - "_libs/*"\n  - "docs"\n`,
        "_apps/web/package.json": pkg("@shop/web", {
            dependencies: { "@shop/ui": "workspace:*", vue: "catalog:" },
            devDependencies: { "@shop/tsconfig": "workspace:*" },
        }),
        "_libs/ui/package.json": pkg("@shop/ui", { peerDependencies: { "@shop/tsconfig": "workspace:*" } }),
        "_libs/tsconfig/package.json": pkg("@shop/tsconfig"),
        // A literal (non-glob) entry.
        "docs/package.json": pkg("@shop/docs", { dependencies: { "@shop/ui": "1.2.3" } }),
        // A dir without package.json is not a workspace package.
        "_libs/scratch/notes.md": "",
    });

    const graph = await graphOf(dir);
    expect(graph.packages).toEqual([
        { name: "@shop/web", dir: "_apps/web", group: "_apps" },
        { name: "@shop/tsconfig", dir: "_libs/tsconfig", group: "_libs" },
        { name: "@shop/ui", dir: "_libs/ui", group: "_libs" },
        { name: "@shop/docs", dir: "docs", group: "docs" },
    ]);
    // Only workspace-internal deps become edges (vue is external); the name-in-set match catches the version-pinned
    // @shop/ui ref from docs too.
    expect(graph.edges).toEqual([
        { from: "@shop/web", to: "@shop/ui", type: "prod" },
        { from: "@shop/web", to: "@shop/tsconfig", type: "dev" },
        { from: "@shop/ui", to: "@shop/tsconfig", type: "peer" },
        { from: "@shop/docs", to: "@shop/ui", type: "prod" },
    ]);
    await rm(dir, { recursive: true, force: true });
});

test("negations, ** globs, unparseable and unnamed manifests and a missing parent are skipped, and a name two dirs claim stays with the first", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n  - "!_libs/private"\n  - "nested/**"\n  - "docs"\n  - "_apps/*"\n  - "missing/*"\n`,
        "_libs/ui/package.json": pkg("@shop/ui", { dependencies: { vue: "catalog:" } }),
        "_libs/broken/package.json": "{ not json",
        "_libs/nameless/package.json": JSON.stringify({ version: "1.0.0" }),
        "_libs/private/package.json": pkg("@shop/private"),
        "_libs/scratch/notes.md": "",
        "nested/deep/pkg/package.json": pkg("@shop/deep"),
        "docs/package.json": pkg("@shop/docs"),
        "_apps/web/package.json": pkg("@shop/ui"),
        "_apps/site/package.json": pkg("@shop/site"),
    });
    expect((await readWorkspaceManifests(dir)).map(({ dir: found, name }) => [found, name])).toEqual([
        ["_libs/ui", "@shop/ui"],
        ["docs", "@shop/docs"],
        ["_apps/site", "@shop/site"],
    ]);
    await rm(dir, { recursive: true, force: true });
});

test("a `!dir` negation takes out a directory a glob brought in", async () => {
    const dir = await scaffold({
        // The shape intentic's own file has: the store shells are globbed in by `_editor/*` and taken back out by name,
        // because pnpm never installs them there.
        "pnpm-workspace.yaml": `packages:\n  - "_editor/*"\n  - "!_editor/ios-app"\n`,
        "_editor/web/package.json": pkg("@shop/web", { dependencies: { "@shop/ui": "workspace:*" } }),
        "_editor/ui/package.json": pkg("@shop/ui"),
        "_editor/ios-app/package.json": pkg("@shop/ios", { dependencies: { "@capacitor/core": "^8" } }),
    });
    expect((await graphOf(dir)).packages.map((entry) => entry.name)).toEqual(["@shop/ui", "@shop/web"]);
    await rm(dir, { recursive: true, force: true });
});

test("each package is placed in the component the repository's map lists it under, and the map's components are listed", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n`,
        "_libs/ui/package.json": pkg("@shop/ui"),
        "_libs/api/package.json": pkg("@shop/api"),
        "_libs/kit/package.json": pkg("@shop/kit"),
        "docs/architecture/repo.json": JSON.stringify({
            components: [
                { id: "front", name: "Storefront", oneLiner: "x", packages: ["_libs/ui/", 7], accent: "2" },
                { id: "loose", packages: ["_libs/api"] },
                { id: "tools", name: "Tools", accent: 3, packages: ["_libs/kit", "_libs/ui"] },
            ],
        }),
    });
    const graph = await graphOf(dir);
    // A component the map does not name in full is skipped, and so is what it lists; an accent that is not a string is
    // dropped alone.
    expect(graph.components).toEqual([
        { id: "front", name: "Storefront", accent: "2" },
        { id: "tools", name: "Tools" },
    ]);
    // A package two components claim stays with the first.
    expect(graph.packages).toEqual([
        { name: "@shop/api", dir: "_libs/api", group: "_libs" },
        { name: "@shop/kit", dir: "_libs/kit", group: "_libs", component: "tools" },
        { name: "@shop/ui", dir: "_libs/ui", group: "_libs", component: "front" },
    ]);
    await rm(dir, { recursive: true, force: true });
});

test("a map that does not read as one draws the graph by folder", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n`,
        "_libs/ui/package.json": pkg("@shop/ui"),
        "docs/architecture/repo.json": `{ "components": [ { "id": "front"`,
    });
    expect(await graphOf(dir)).toEqual({ packages: [{ name: "@shop/ui", dir: "_libs/ui", group: "_libs" }], edges: [] });
    await rm(dir, { recursive: true, force: true });
});
