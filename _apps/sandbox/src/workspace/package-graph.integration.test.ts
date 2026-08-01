import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readPackageGraph } from "./package-graph.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pkg-graph-"));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

const pkg = (name: string, blocks: Record<string, Record<string, string>> = {}): string => JSON.stringify({ name, ...blocks });

test("readPackageGraph returns empty for a repo without pnpm-workspace.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pkg-graph-"));
    expect(readPackageGraph(dir)).toEqual({ packages: [], edges: [] });
    await rm(dir, { recursive: true, force: true });
});

test("readPackageGraph discovers packages from globs and types edges by dependency block", async () => {
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

    const graph = readPackageGraph(dir);
    expect(graph.packages).toEqual(
        expect.arrayContaining([
            { name: "@shop/web", dir: "_apps/web", group: "_apps" },
            { name: "@shop/ui", dir: "_libs/ui", group: "_libs" },
            { name: "@shop/tsconfig", dir: "_libs/tsconfig", group: "_libs" },
            { name: "@shop/docs", dir: "docs", group: "docs" },
        ]),
    );
    expect(graph.packages).toHaveLength(4);
    // Only workspace-internal deps become edges (vue is external); the name-in-set match catches the
    // version-pinned @shop/ui ref from docs too.
    expect(graph.edges).toEqual(
        expect.arrayContaining([
            { from: "@shop/web", to: "@shop/ui", type: "prod" },
            { from: "@shop/web", to: "@shop/tsconfig", type: "dev" },
            { from: "@shop/ui", to: "@shop/tsconfig", type: "peer" },
            { from: "@shop/docs", to: "@shop/ui", type: "prod" },
        ]),
    );
    expect(graph.edges).toHaveLength(4);
    await rm(dir, { recursive: true, force: true });
});

test("readPackageGraph skips negations, ** globs, and unparseable manifests", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n  - "!_libs/private"\n  - "nested/**"\n`,
        "_libs/ui/package.json": pkg("@shop/ui"),
        "_libs/broken/package.json": "{ not json",
        "nested/deep/pkg/package.json": pkg("@shop/deep"),
    });

    const graph = readPackageGraph(dir);
    expect(graph.packages).toEqual([{ name: "@shop/ui", dir: "_libs/ui", group: "_libs" }]);
    expect(graph.edges).toEqual([]);
    await rm(dir, { recursive: true, force: true });
});
