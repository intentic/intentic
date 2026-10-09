import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTooling, readUsedPackageGraph } from "./package-usage.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pkg-usage-"));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

const pkg = (name: string, blocks: Record<string, unknown> = {}): string => JSON.stringify({ name, ...blocks });
const deps = (...names: string[]): Record<string, string> => Object.fromEntries(names.map((name) => [name, "workspace:*"]));

test("each declared edge says what the dependent's own files do with it, the strongest use winning", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "libs/*"\n  - "apps/*"\n`,
        "apps/web/package.json": pkg("@s/web", {
            dependencies: deps("@s/code", "@s/types", "@s/tested", "@s/packed", "@s/unused", "@s/css"),
            devDependencies: deps("@s/runner", "@s/configured"),
            scripts: { test: "suite-run" },
        }),
        "apps/web/src/main.ts": `import type { T } from "@s/types";\nimport { a } from "@s/code/sub";\nimport type { U } from "@s/code";\n`,
        "apps/web/src/main.test.ts": `import { t } from "@s/tested";\n`,
        "apps/web/Dockerfile": `COPY libs/packed/dist /srv/packed\n`,
        "apps/web/src/styles.css": `@import "../../../libs/css/house.css";\n`,
        "apps/web/vite.config.ts": `import { plugin } from "@s/configured";\n`,
        // The manifest names every dependency and is the declaration itself, never a use.
        "apps/web/README.md": `Uses @s/unused.\n`,
        "libs/code/package.json": pkg("@s/code"),
        "libs/types/package.json": pkg("@s/types"),
        "libs/tested/package.json": pkg("@s/tested"),
        "libs/packed/package.json": pkg("@s/packed"),
        "libs/unused/package.json": pkg("@s/unused"),
        "libs/css/package.json": pkg("@s/css"),
        "libs/css/house.css": `:root {}\n`,
        "libs/runner/package.json": pkg("@s/runner", { bin: { "suite-run": "bin.js" } }),
        "libs/configured/package.json": pkg("@s/configured"),
    });
    const graph = await readUsedPackageGraph(dir);
    const usage = Object.fromEntries(graph.edges.map((edge) => [edge.to, edge.usage]));
    expect(usage).toEqual({
        "@s/code": "code",
        "@s/types": "types",
        "@s/tested": "tooling",
        "@s/packed": "reference",
        "@s/unused": "none",
        "@s/css": "code",
        "@s/runner": "tooling",
        "@s/configured": "tooling",
    });
    await rm(dir, { recursive: true, force: true });
});

test("a sibling whose name another's extends is not named by it", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "libs/*"\n`,
        "libs/app/package.json": pkg("@s/app", { dependencies: deps("@s/sdk") }),
        "libs/app/src/index.ts": `import { x } from "@s/sdk-node";\n`,
        "libs/sdk/package.json": pkg("@s/sdk"),
        "libs/sdk-node/package.json": pkg("@s/sdk-node"),
    });
    const graph = await readUsedPackageGraph(dir);
    expect(graph.edges).toEqual([{ from: "@s/app", to: "@s/sdk", type: "prod", usage: "none" }]);
    await rm(dir, { recursive: true, force: true });
});

test("tests, scripts and tool configs are tooling; the code a package ships is not", () => {
    for (const path of [
        "src/a.test.ts",
        "test/setup.ts",
        "scripts/build.mjs",
        "vite.config.ts",
        "electron.vite.config.ts",
        "tsconfig.app.json",
        "bunfig.toml",
        ".oxlintrc.json",
    ]) {
        expect([path, isTooling(path)]).toEqual([path, true]);
    }
    for (const path of ["src/index.ts", "src/testing-utils/x.ts", "deploy.config.ts", "Dockerfile", "src/config.ts"]) {
        expect([path, isTooling(path)]).toEqual([path, false]);
    }
});
