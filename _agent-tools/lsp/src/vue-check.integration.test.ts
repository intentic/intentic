import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { changedFiles } from "./changed.js";
import { buildImportGraph, importersAtAnyDepth, loadedBy } from "./import-graph.js";
import { cacheDirOf, planVueCheck, prepareVueCheck, runVueCheck } from "./vue-check.js";
import { diagnoseVueGroup, splitByVuePackage } from "./vue-diag.js";
import { vuePackageOf } from "./vue-project.js";

// Small fixture packages on disk: the import graph and its cache over real files, the changed-files list over a real git
// repository, and the scoped check over a real vue-tsc, the one the editor's kit installs.

const made: string[] = [];
const fixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-vue-"));
    made.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const write = (root: string, files: Readonly<Record<string, string>>): void => {
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
    }
};

// Imports as a reader finds them; the real check uses the package's own ts.preProcessFile.
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/gu;
const specifiersOf = (text: string): string[] => [...text.matchAll(IMPORT)].map((match) => match[1] ?? "");

describe("the import graph", () => {
    const tree = (): string => {
        const root = fixture();
        write(root, {
            "src/main.ts": 'import App from "./App.vue";\nimport { lazy } from "@/lazy.js";\nexport const boot = () => import("./routes");\n',
            "src/App.vue": '<template><div /></template>\n<script setup lang="ts">\nimport { card } from "@/card";\nimport "vue";\n</script>\n',
            "src/card.ts": 'export const card = 1;\n',
            "src/lazy.ts": 'export const lazy = 1;\n',
            "src/routes/index.ts": 'import { card } from "../card";\nexport default card;\n',
            "lib/button.ts": "export const button = 1;\n",
            "src/uses-lib.ts": 'import { button } from "@lib/button";\n',
        });
        return root;
    };
    const sourceOf = (root: string, cacheFile?: string, read = specifiersOf) => ({
        files: ["main.ts", "App.vue", "card.ts", "lazy.ts", "routes/index.ts", "uses-lib.ts"].map((file) => join(root, "src", file)),
        paths: { "@/*": ["src/*"], "@lib/*": ["lib/*"] },
        pathsBase: root,
        specifiersOf: read,
        cacheFile,
    });

    test("resolves relative and aliased imports, static and dynamic, `.vue` script blocks and index files, and drops packages", () => {
        const root = tree();
        const graph = buildImportGraph(sourceOf(root));
        const at = (file: string): string => join(root, file);
        expect([...(graph.imports.get(at("src/main.ts")) ?? [])].toSorted()).toEqual([at("src/App.vue"), at("src/lazy.ts"), at("src/routes/index.ts")]);
        expect([...(graph.imports.get(at("src/App.vue")) ?? [])]).toEqual([at("src/card.ts")]);
        expect([...(graph.importers.get(at("src/card.ts")) ?? [])].toSorted()).toEqual([at("src/App.vue"), at("src/routes/index.ts")]);
        // A file outside the project, through an alias, keeps its importers.
        expect([...(graph.importers.get(at("lib/button.ts")) ?? [])]).toEqual([at("src/uses-lib.ts")]);
        expect(importersAtAnyDepth(graph, at("src/card.ts"))).toBe(3);
        expect(importersAtAnyDepth(graph, at("src/main.ts"))).toBe(0);
        expect([...loadedBy(graph, [at("src/App.vue")])].toSorted()).toEqual([at("src/App.vue"), at("src/card.ts")]);
    });

    test.each(["</script >", '</script ignored="yes">', "</SCRIPT\t>"])("a script ending in %s cannot consume imports from the template", (closing) => {
        const root = tree();
        write(root, {
            "src/App.vue": `<script setup lang="ts">import { card } from "@/card";${closing}
                <template>import { lazy } from "@/lazy";</template>
                <SCRIPT>import routes from "./routes";</SCRIPT>
                <scripture>import { missing } from "@/uses-lib";</scripture>`,
        });
        const graph = buildImportGraph(sourceOf(root));
        expect([...(graph.imports.get(join(root, "src/App.vue")) ?? [])].toSorted()).toEqual([join(root, "src/card.ts"), join(root, "src/routes/index.ts")]);
    });

    test.each(["cash$&name", "cash$$name", "cash$`name"])("substitutes a wildcard import's name literally: %s", (name) => {
        const root = tree();
        write(root, {
            "src/main.ts": `import { value } from "@/${name}";`,
            [`src/${name}.ts`]: "export const value = 1;",
        });
        const graph = buildImportGraph(sourceOf(root));
        expect([...(graph.imports.get(join(root, "src/main.ts")) ?? [])]).toEqual([join(root, `src/${name}.ts`)]);
    });

    test("a cache from before the script parser fix is rebuilt even when the source files did not change", () => {
        const root = tree();
        const cache = join(root, "imports.json");
        const app = join(root, "src/App.vue");
        const stat = statSync(app);
        writeFileSync(cache, JSON.stringify({ version: 1, files: { [app]: { mtimeMs: stat.mtimeMs, size: stat.size, specifiers: [] } } }));
        const graph = buildImportGraph(sourceOf(root, cache));
        expect([...(graph.imports.get(app) ?? [])]).toEqual([join(root, "src/card.ts")]);
    });

    test("a second build reads only the files whose mtime or size moved", () => {
        const root = tree();
        const cache = join(root, ".cache", "imports.json");
        buildImportGraph(sourceOf(root, cache));
        const read: string[] = [];
        const counting = (text: string): string[] => {
            read.push(text);
            return specifiersOf(text);
        };
        buildImportGraph(sourceOf(root, cache, counting));
        expect(read).toEqual([]);
        const later = new Date(Date.now() + 5_000);
        utimesSync(join(root, "src/lazy.ts"), later, later);
        buildImportGraph(sourceOf(root, cache, counting));
        expect(read).toEqual(["export const lazy = 1;\n"]);
    });
});

describe("the files a change touched", () => {
    const git = (cwd: string, ...args: string[]): void => {
        const run = spawnSync("git", args, { cwd, encoding: "utf8" });
        if (run.status !== 0) {
            throw new Error(run.stderr);
        }
    };

    test("committed since the branch point, staged, unstaged and untracked, but not deleted or ignored", () => {
        const root = fixture();
        git(root, "init", "-q", "-b", "main");
        git(root, "config", "user.email", "t@t");
        git(root, "config", "user.name", "t");
        write(root, { "a.ts": "1", "gone.ts": "1", "same.ts": "1", ".gitignore": "ignored.ts\n" });
        git(root, "add", ".");
        git(root, "commit", "-qm", "base");
        git(root, "checkout", "-qb", "work");
        write(root, { "a.ts": "2", "committed.ts": "1" });
        git(root, "add", ".");
        git(root, "commit", "-qm", "work");
        // main moves on after the branch point: none of its files are this change's.
        git(root, "checkout", "-q", "main");
        write(root, { "mainline.ts": "1" });
        git(root, "add", ".");
        git(root, "commit", "-qm", "main");
        git(root, "checkout", "-q", "work");
        write(root, { "same.ts": "2", "untracked.ts": "1", "ignored.ts": "1" });
        rmSync(join(root, "gone.ts"));
        const found = changedFiles(join(root));
        expect(found).toMatchObject({ baseName: "the branch point with main" });
        expect("files" in found ? found.files.map((file) => file.slice(root.length + 1)) : found).toEqual(["a.ts", "committed.ts", "same.ts", "untracked.ts"]);
    });

    test("with no main line, what is not committed yet", () => {
        const root = fixture();
        git(root, "init", "-q", "-b", "trunk");
        git(root, "config", "user.email", "t@t");
        git(root, "config", "user.name", "t");
        write(root, { "a.ts": "1" });
        git(root, "add", ".");
        git(root, "commit", "-qm", "base");
        write(root, { "a.ts": "2" });
        const found = changedFiles(root);
        expect(found).toMatchObject({ base: "HEAD", files: [join(root, "a.ts")] });
    });

    test("outside a repository it says so", () => {
        expect(changedFiles(fixture())).toEqual({ failure: expect.stringMatching(/is not inside a git repository$/u) });
    });
});

// The editor kit's install carries vue, vue-tsc and the TypeScript it runs on; found above this file, not counted.
const kitModules = (): string => {
    for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
        const candidate = join(dir, "_editor", "ui", "node_modules");
        if (existsSync(candidate) || dirname(dir) === dir) {
            return candidate;
        }
    }
};
const KIT_MODULES = kitModules();
const vueTsc = requires(existsSync(join(KIT_MODULES, "vue-tsc", "bin", "vue-tsc.js")), `vue-tsc installed under ${KIT_MODULES}`);

// Without the heavy-command hook, so the fixture's compiler runs in place rather than in the sandbox's queue.
const { NODE_OPTIONS: _hook, INTENTIC_HEAVY: _table, ...quiet } = process.env;

describe.skipIf(!vueTsc.runs)(vueTsc.title("a scoped vue-tsc run on a fixture package"), () => {
    const pkg = (): string => {
        const root = fixture();
        symlinkSync(KIT_MODULES, join(root, "node_modules"), "dir");
        write(root, {
            "package.json": JSON.stringify({ name: "@fixture/app", devDependencies: { "vue-tsc": "*" }, scripts: { typecheck: "vue-tsc --noEmit -p tsconfig.app.json" } }),
            "tsconfig.app.json": JSON.stringify({
                compilerOptions: { strict: true, module: "ESNext", moduleResolution: "bundler", target: "ES2022", skipLibCheck: true, noEmit: true, types: [] },
                include: ["src/**/*.ts", "src/**/*.vue", "env.d.ts"],
            }),
            "env.d.ts": "declare const APP_NAME: string;\n",
            // In this fixture, count changes; Counter imports it directly, and Page only through Counter.
            "src/count.ts": "export const count = (): number => 1;\n",
            "src/Counter.vue": '<script setup lang="ts">\nimport { count } from "./count";\nconst shown: number = count();\nconst name: string = APP_NAME;\n</script>\n<template><span>{{ shown }}{{ name }}</span></template>\n',
            "src/Page.vue": '<script setup lang="ts">\nimport Counter from "./Counter.vue";\nconst broken: number = "not checked";\n</script>\n<template><Counter /></template>\n',
            "src/helper.ts": 'export const helper: number = "an error outside the change";\n',
            "src/uses-helper.ts": 'import { helper } from "./helper";\nimport { count } from "./count";\nexport const both: number = helper + count();\n',
        });
        return root;
    };

    test("a type change reaches its direct importers, `.vue` included, and nothing past them", async () => {
        const root = pkg();
        writeFileSync(join(root, "src/count.ts"), "export const count = (): string => \"1\";\n");
        const found = vuePackageOf(join(root, "src/count.ts"));
        expect(found).toMatchObject({ name: "@fixture/app", tsconfig: join(root, "tsconfig.app.json") });
        const prepared = prepareVueCheck(found!);
        const plan = planVueCheck(prepared.project, prepared.graph, [join(root, "src/count.ts")]);
        expect(plan).toMatchObject({ kind: "scoped", targets: [join(root, "src/Counter.vue"), join(root, "src/count.ts"), join(root, "src/uses-helper.ts")] });
        const run = await runVueCheck(prepared.project, plan.kind === "scoped" ? plan.targets : [], { env: quiet });
        expect(run).toMatchObject({
            diagnostics: [
                { file: join(root, "src/Counter.vue"), line: 3, code: 2322, category: "error" },
                { file: join(root, "src/uses-helper.ts"), line: 3, code: 2322, category: "error" },
            ],
            // The fixture helper's own error, loaded through uses-helper; Page's is never loaded.
            outside: 1,
        });
        // Nothing of the run is left beside the package's own config but its build info and the graph's cache.
        expect(readdirSync(cacheDirOf(found!)).toSorted()).toEqual(["imports.json", "tsbuildinfo"]);
    }, 120_000);

    test("`lsp diag` on such a file says what it checked; a declaration file leaves it to CI", async () => {
        const root = pkg();
        const { vue, rest } = splitByVuePackage([join(root, "src/count.ts"), join(root, "env.d.ts"), "/elsewhere/a.ts"]);
        expect(rest).toEqual(["/elsewhere/a.ts"]);
        const [group] = vue;
        const clean = await diagnoseVueGroup({ pkg: group!.pkg, files: [join(root, "src/count.ts")] }, { env: quiet });
        expect(clean.refused).toBe(false);
        expect(clean.lines.at(-1)).toMatch(
            /^lsp: @fixture\/app: vue-tsc checked 1 changed file and 2 direct importers under tsconfig\.app\.json in \d+s: no errors in them; 1 more error in files they import, outside the change$/u,
        );
        const full = await diagnoseVueGroup(group!, { env: quiet });
        expect(full).toEqual({
            lines: [
                "lsp: @fixture/app: not checked here: env.d.ts is a declaration file, which every file of the package may read. Leave it to CI, which typechecks the package on push; " +
                    "run its full check (pnpm --filter @fixture/app typecheck: vue-tsc over the whole package; on the editor, 7-10 minutes and 6.8 GB on an idle machine) only when asked to.",
            ],
            refused: true,
        });
    }, 120_000);
});
