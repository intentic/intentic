import type { ImportGraph } from "./import-graph.js";
import { CHANGED_TSCONFIG, FALLBACK_IMPORTERS, fullCommandOf, judgeRun, planVueCheck, scopedTsconfig } from "./vue-check.js";
import { projectOfScript, type VueProject } from "./vue-project.js";

// What a changed-files check decides before any compiler runs, and how it reads what one printed: over a graph and a
// project described in memory, so every boundary is pinned without a package on disk.

const DIR = "/repo/web";
const at = (name: string): string => `${DIR}/src/${name}`;

const projectOf = (files: readonly string[]): VueProject => ({
    pkg: { dir: DIR, name: "@scope/web", tsconfig: `${DIR}/tsconfig.app.json`, vueTsc: "/nm/vue-tsc/bin/vue-tsc.js", typescript: "/nm/typescript/lib/typescript.js" },
    files: [...files, `${DIR}/env.d.ts`],
    ambient: [`${DIR}/env.d.ts`],
    paths: {},
    pathsBase: DIR,
});

// A graph from `importer -> imported` pairs.
const graphOf = (edges: readonly (readonly [string, string])[]): ImportGraph => {
    const imports = new Map<string, Set<string>>();
    const importers = new Map<string, Set<string>>();
    for (const [from, to] of edges) {
        imports.set(from, (imports.get(from) ?? new Set()).add(to));
        importers.set(to, (importers.get(to) ?? new Set()).add(from));
    }
    return { imports, importers };
};

describe("which files a change is checked over", () => {
    const files = ["View.vue", "Card.vue", "useCard.ts", "Page.vue", "App.vue"].map(at);
    // App -> Page -> View -> Card -> useCard
    const graph = graphOf([
        [at("App.vue"), at("Page.vue")],
        [at("Page.vue"), at("View.vue")],
        [at("View.vue"), at("Card.vue")],
        [at("Card.vue"), at("useCard.ts")],
    ]);

    test("the changed files and their direct importers, never the importers' importers", () => {
        expect(planVueCheck(projectOf(files), graph, [at("useCard.ts")])).toEqual({
            kind: "scoped",
            targets: [at("Card.vue"), at("useCard.ts")],
            changed: [at("useCard.ts")],
            importers: 1,
            unchecked: [],
        });
        const two = planVueCheck(projectOf(files), graph, [at("useCard.ts"), at("Card.vue")]);
        expect(two).toMatchObject({ kind: "scoped", targets: [at("Card.vue"), at("View.vue"), at("useCard.ts")], importers: 1 });
    });

    test("a file imported at some depth by more than the threshold goes to the full check; at the threshold it does not", () => {
        // In this fixture, useCard is imported by 4 files at some depth, Card by 3.
        expect(planVueCheck(projectOf(files), graph, [at("useCard.ts")], 3)).toEqual({
            kind: "full",
            reason: "src/useCard.ts is imported by more than 3 of the package's files at some depth, past what its direct importers can vouch for",
        });
        expect(planVueCheck(projectOf(files), graph, [at("Card.vue")], 3).kind).toBe("scoped");
        expect(FALLBACK_IMPORTERS).toBe(300);
    });

    test.each([
        [`${DIR}/env.d.ts`, "env.d.ts is a declaration file"],
        [at("shims.d.mts"), "src/shims.d.mts is a declaration file"],
        [`${DIR}/tsconfig.app.json`, "tsconfig.app.json is a tsconfig"],
        [`${DIR}/package.json`, "package.json is a manifest"],
    ])("%s goes to the full check whatever else changed", (file, said) => {
        const plan = planVueCheck(projectOf(files), graph, [at("Card.vue"), file]);
        expect(plan).toEqual({ kind: "full", reason: `${said}, which every file of the package may read` });
    });

    test("a changed file the package's typecheck does not compile is named as unchecked, not silently passed", () => {
        expect(planVueCheck(projectOf(files), graph, [`${DIR}/vite.config.ts`])).toEqual({ kind: "none", unchecked: [`${DIR}/vite.config.ts`] });
        expect(planVueCheck(projectOf(files), graph, [`${DIR}/vite.config.ts`, at("App.vue")])).toMatchObject({ kind: "scoped", targets: [at("App.vue")], unchecked: [`${DIR}/vite.config.ts`] });
    });

    test("a file of another package is checked through this package's files importing it, a barrel in between", () => {
        const lib = "/repo/ui/src/Button.vue";
        const barrel = "/repo/ui/src/index.ts";
        const withLib = graphOf([
            [at("Card.vue"), lib],
            [at("Page.vue"), barrel],
            [barrel, lib],
            [lib, "/repo/ui/src/tone.ts"],
        ]);
        expect(planVueCheck(projectOf(files), withLib, [lib])).toEqual({ kind: "scoped", targets: [at("Card.vue"), at("Page.vue")], changed: [], importers: 2, unchecked: [] });
    });

    test("a file of another package the graph never reached goes to the full check: its package name is not traced", () => {
        expect(planVueCheck(projectOf(files), graph, ["/repo/contract/src/wire.ts"])).toEqual({
            kind: "full",
            reason: "../contract/src/wire.ts is reached through a package import this check does not trace",
        });
    });
});

test("the scoped tsconfig is the package's own with only the targets and the ambient declarations as its files", () => {
    expect(scopedTsconfig(projectOf([at("Card.vue")]), [at("Card.vue"), at("useCard.ts")], "/c/tsbuildinfo.1")).toEqual({
        extends: `${DIR}/tsconfig.app.json`,
        compilerOptions: { noEmit: true, incremental: true, composite: false, tsBuildInfoFile: "/c/tsbuildinfo.1" },
        // `.vue` by literal path in `include`, since `files` takes only extensions TypeScript itself knows.
        files: [at("useCard.ts"), `${DIR}/env.d.ts`],
        include: [at("Card.vue")],
    });
    // The heavy-command table finds a scoped run by the file name (heavy-rules.cjs `vue-typecheck-changed`).
    expect(CHANGED_TSCONFIG).toBe("tsconfig.lsp-changed");
    expect(fullCommandOf(projectOf([]).pkg)).toBe("pnpm --filter @scope/web typecheck");
});

describe("what a run printed", () => {
    const project = projectOf([at("Card.vue"), at("useCard.ts")]);
    const config = `${DIR}/.cache/lsp-changed/${CHANGED_TSCONFIG}.1.json`;
    const ran = (output: string, code: number | null, signal: NodeJS.Signals | null = null) => ({ output, stderr: "", code, signal, ms: 4200, timedOut: false });

    test("errors in the targets are the change's; errors elsewhere are only counted", () => {
        const output = [
            "src/Card.vue(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
            "src/useCard.ts(1,1): warning TS6133: 'x' is declared but never read.",
            "src/lib/deep.ts(9,1): error TS2304: Cannot find name 'y'.",
        ].join("\n");
        expect(judgeRun(ran(output, 2), project, config, [at("Card.vue"), at("useCard.ts")])).toEqual({
            diagnostics: [
                { file: at("Card.vue"), line: 3, column: 7, category: "error", code: 2322, message: "Type 'string' is not assignable to type 'number'." },
                { file: at("useCard.ts"), line: 1, column: 1, category: "warning", code: 6133, message: "'x' is declared but never read." },
            ],
            outside: 1,
            ms: 4200,
        });
    });

    test("a clean run is a verdict of no diagnostics", () => {
        expect(judgeRun(ran("", 0), project, config, [at("Card.vue")])).toEqual({ diagnostics: [], outside: 0, ms: 4200 });
    });

    test("a config that did not load, a crash, a kill or an error it cannot parse is no verdict", () => {
        expect(judgeRun(ran("error TS5083: Cannot read file '/x/tsconfig.json'.", 1), project, config, [])).toEqual({ failure: "the scoped tsconfig did not load: Cannot read file '/x/tsconfig.json'." });
        expect(judgeRun(ran(`${config}(1,1): error TS6053: File not found.`, 1), project, config, [])).toEqual({ failure: "the scoped tsconfig did not load: File not found." });
        expect(judgeRun({ ...ran("", 134), stderr: "FATAL ERROR: Reached heap limit" }, project, config, [])).toEqual({ failure: "vue-tsc exited with code 134: FATAL ERROR: Reached heap limit" });
        expect(judgeRun(ran("", null, "SIGKILL"), project, config, [])).toEqual({ failure: "vue-tsc was killed by SIGKILL" });
        expect(judgeRun({ ...ran("", null, "SIGKILL"), timedOut: true }, project, config, [])).toEqual({ failure: "vue-tsc did not finish within 4s" });
        expect(judgeRun(ran("something else entirely", 2), project, config, [])).toEqual({ failure: "vue-tsc exited with code 2 and no error this reader parses: something else entirely" });
    });
});

test.each([
    ["node ../../_tools/scripts/lib/seed-buildinfo.mjs .cache/t && node --max-old-space-size=8192 ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.app.json && node x", "tsconfig.app.json"],
    ["vue-tsc --noEmit --project=tsconfig.build.json", "tsconfig.build.json"],
    ["vue-tsc --noEmit && tsc -p other.json", "tsconfig.json"],
    ["tsc -p other.json", "tsconfig.json"],
    [undefined, "tsconfig.json"],
] as const)("the typecheck script %s checks %s", (script, project) => {
    expect(projectOfScript(script)).toBe(project);
});
