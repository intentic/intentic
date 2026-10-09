import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceManifests } from "./package-graph.js";
import { placer, readPackageModules } from "./package-modules.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pkg-modules-"));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

const LAYERS = {
    shelves: ["features"],
    surface: ["*.routes.ts"],
    layers: [
        { name: "base", about: "what all stand on", units: ["lib"] },
        { name: "features", units: ["features", "lib/late"] },
    ],
};

test("a module is placed by the longest unit naming it; a shelf's subdirectory is its own unit, and every surface module and every root file share one", () => {
    const place = placer(LAYERS);
    expect(place("lib/a.ts")).toEqual({ unit: "lib", layer: 0, surface: false });
    expect(place("lib/late/b.ts")).toEqual({ unit: "lib/late", layer: 1, surface: false });
    expect(place("features/chat/x.ts")).toEqual({ unit: "features/chat", layer: 1, surface: false });
    expect(place("features/index.ts")).toEqual({ unit: "features", layer: 1, surface: false });
    expect(place("lib/http.routes.ts")).toEqual({ unit: "(surface)", layer: undefined, surface: true });
    expect(place("features/chat/chat.routes.ts")).toEqual({ unit: "(surface)", layer: undefined, surface: true });
    expect(place("main.ts")).toEqual({ unit: "(root)", layer: undefined, surface: false });
    expect(place("other/y.ts")).toEqual({ unit: "other", layer: undefined, surface: false });
    // Without a table every top-level directory is a unit, in no layer.
    expect(placer(undefined)("lib/a.ts")).toEqual({ unit: "lib", layer: undefined, surface: false });
});

test("readPackageModules counts value imports between units, with their sites, and leaves out types, tests and its own unit", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "apps/*"\n`,
        "apps/web/package.json": JSON.stringify({ name: "@s/web" }),
        "apps/web/layers.json": JSON.stringify(LAYERS),
        "apps/web/src/main.ts": `import { a } from "./lib/a.js";\nimport { c } from "./features/chat/c.js";\n`,
        "apps/web/src/lib/a.ts": `import { b } from "./b.js";\nimport { c } from "../features/chat/c.js";\nimport type { D } from "../features/docs/d.js";\n`,
        "apps/web/src/lib/b.ts": `export const b = 1;\n`,
        "apps/web/src/lib/a.test.ts": `import { c } from "../features/docs/d.js";\n`,
        "apps/web/src/features/chat/c.ts": `import { a } from "../../lib/a";\nimport { d } from "../docs";\n`,
        "apps/web/src/features/docs/index.ts": `export const d = 1;\n`,
        "apps/web/src/features/docs/d.ts": `export type D = 1;\n`,
    });
    const modules = await readPackageModules(dir, readWorkspaceManifests(dir), "@s/web");
    expect(modules).toEqual({
        package: "@s/web",
        root: "apps/web/src",
        layers: [{ name: "base", about: "what all stand on" }, { name: "features" }],
        units: [
            { id: "(root)", modules: 1 },
            { id: "features/chat", modules: 1, layer: 1 },
            { id: "features/docs", modules: 2, layer: 1 },
            { id: "lib", modules: 2, layer: 0 },
        ],
        edges: [
            { from: "(root)", to: "features/chat", imports: 1, sites: ["main.ts:2"] },
            { from: "(root)", to: "lib", imports: 1, sites: ["main.ts:1"] },
            { from: "features/chat", to: "features/docs", imports: 1, sites: ["features/chat/c.ts:2"] },
            { from: "features/chat", to: "lib", imports: 1, sites: ["features/chat/c.ts:1"] },
            { from: "lib", to: "features/chat", imports: 1, sites: ["lib/a.ts:2"] },
        ],
    });
    expect(await readPackageModules(dir, readWorkspaceManifests(dir), "@s/nope")).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
});

test("a layers.json that does not match its shape is reported, and the units are still read", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "apps/*"\n`,
        "apps/web/package.json": JSON.stringify({ name: "@s/web" }),
        "apps/web/layers.json": JSON.stringify({ layers: [{ units: ["lib"] }] }),
        "apps/web/src/lib/a.ts": `export const a = 1;\n`,
    });
    const modules = await readPackageModules(dir, readWorkspaceManifests(dir), "@s/web");
    expect(modules?.invalid).toContain("layers.0.name");
    expect(modules?.layers).toBeUndefined();
    expect(modules?.units).toEqual([{ id: "lib", modules: 1 }]);
    await rm(dir, { recursive: true, force: true });
});
