#!/usr/bin/env node
// Checks three facts about a package's tests no test run reports: coverage, budgets and build-reference order. All
// three are recognized by shape, not a list, so a new package needs no addition here. Whether a module mock provides
// what the code under test imports is no longer read here: every mock stands in for its whole module at run time
// (@intentic/testing module-mocks.ts), and one naming a module that moved fails at its own line.
// 1. every test file sits inside some type-check program; a suite reaching the machine is named as one
//    (`.integration.`/`.e2e.`), even through an imported fixture module
// 2. every package running `suites` preloads the shared budget through its bunfig.toml, and every preload it names
//    exists
// 3. an emitted package's tsconfig references every emitted package it depends on, so `tsgo -b` builds them in order
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { INTEGRATION_NAME } from "../constants/src/test-suites.mjs";
import { finish } from "./lib/report.mjs";
import { configFor, emitsDist, excludesOf, packages, root, sourceOf, TEST_FILE, walk } from "./lib/repo.mjs";

// Coverage, and the integration name.

const MACHINE_PRIMITIVES = /mkdtemp|node:child_process|simple-git|dockerode|testcontainers/;
const FIXTURE_MODULE = /(^|[.-])testing\.[cm]?tsx?$/;
// The package's test script is the shared runner (bin/suites.mjs in @intentic/testing), so the budget and the
// bunfig.toml preload are what it counts on.
const runsSuites = (pkg) => /\bsuites\b/.test(pkg.scripts?.test ?? "");
// Cuts what names a module without running it: a `jest.mock` replacing it, and a type-only import or
// `typeof import()` that erases before the suite runs.
const runtimeText = (source) =>
    source
        .replace(/jest\.mock\([^)]*\)/g, "")
        .replace(/\bimport\s+type\s[\s\S]*?from\s*["'][^"']+["'];?/g, "")
        .replace(/\btypeof\s+import\(\s*["'][^"']+["']\s*\)/g, "");

// Named bindings of each import this checkout can resolve, as `{ names, file }`.
const IMPORTS = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const importsOf = (file, source) =>
    [...source.matchAll(IMPORTS)].flatMap(([, clause, specifier]) => {
        const target = sourceOf(file, specifier);
        return target === undefined || !existsSync(target)
            ? []
            : [
                  {
                      names: clause.split(",").map((name) =>
                          name
                              .trim()
                              .split(/\s+as\s+/)
                              .at(-1),
                      ),
                      file: target,
                  },
              ];
    });

// Every top-level declaration of a module, as `name -> the text under it`.
const declarationsOf = (source) => {
    const heads = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z0-9_$]+)/gm)];
    return new Map(heads.map((head, index) => [head[1], source.slice(head.index, heads[index + 1]?.index)]));
};

// A helper's body plus everything it reaches; delegating to a private function still counts as doing it.
const closureOf = (declarations, names, seen) =>
    names.flatMap((name) => {
        const body = declarations.get(name);
        if (body === undefined || seen.has(name)) {
            return [];
        }
        seen.add(name);
        const referenced = [...declarations.keys()].filter((other) => new RegExp(String.raw`\b${other}\b`).test(body));
        return [body, closureOf(declarations, referenced, seen)];
    });

// Whether a suite does real work. `wanted` selects which helpers to read: every one for the suite itself, only the
// imported ones for a fixture module; production modules aren't followed, or one daemon import would mark every suite.
const reachesTheMachine = (file, wanted, seen = new Set()) => {
    const source = runtimeText(readFileSync(file, "utf8"));
    const text = wanted === undefined ? source : closureOf(declarationsOf(source), wanted, seen).flat(Infinity).join("\n");
    if (MACHINE_PRIMITIVES.test(text)) {
        return true;
    }
    return importsOf(file, source).some(
        ({ names, file: imported }) =>
            FIXTURE_MODULE.test(basename(imported)) &&
            names.some((name) => new RegExp(String.raw`\b${name}\b`).test(text)) &&
            reachesTheMachine(imported, names, seen),
    );
};

const problems = [];
for (const { name, dir, pkg } of packages) {
    // Only where the budget exists: `suites` picks it by file name; Playwright specs reach the machine by definition.
    for (const file of runsSuites(pkg) ? walk(dir) : []) {
        if (INTEGRATION_NAME.test(file) || !reachesTheMachine(file, undefined)) {
            continue;
        }
        const relative = file.slice(root.length + 1);
        problems.push(
            `${relative}: opens temp trees, spawns processes or drives real git, but its name puts it under the ` +
                `unit budget (a 20s hang detector): rename it to ${relative.replace(/\.(test|spec)\./, ".integration.$1.")}`,
        );
    }
    if (walk(dir).length === 0) {
        continue;
    }
    const typecheck = pkg.scripts?.typecheck;
    if (typecheck === undefined) {
        problems.push(`${name}: has test files but no "typecheck" script, turbo skips it silently`);
        continue;
    }
    const config = join(dir, configFor(typecheck));
    if (!existsSync(config)) {
        problems.push(`${name}: "typecheck" compiles ${configFor(typecheck)}, which does not exist`);
        continue;
    }
    const excluded = excludesOf(config).filter((pattern) => TEST_FILE.test(pattern.replace(/\*/g, "x")));
    if (excluded.length > 0) {
        problems.push(
            `${name}: ${configFor(typecheck)} excludes ${excluded.join(", ")}, its tests are in no type-check program. ` +
                `Point "typecheck" at a tsconfig.test.json that re-includes them (see any emitting package).`,
        );
    }
}

// Budgets.

const BUNFIG = "bunfig.toml";
// Loaded per file: the budget by suite name. Without it a bare `bun test` runs on bun's 5s hang detector.
const PRELOAD = "_tools/testing/src/bun-preload.ts";
const preloadsOf = (source) => [...(/preload\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
const budgetless = [];
for (const { name, dir, pkg } of packages) {
    if (!runsSuites(pkg) || walk(dir).length === 0) {
        continue;
    }
    const config = join(dir, BUNFIG);
    if (!existsSync(config)) {
        budgetless.push(`${name}: runs suites with no ${BUNFIG}. Add one whose [test] preload names ${PRELOAD}.`);
        continue;
    }
    const preloads = preloadsOf(readFileSync(config, "utf8"));
    if (!preloads.some((preload) => resolve(dir, preload) === join(root, PRELOAD))) {
        budgetless.push(`${name}: ${BUNFIG} does not preload ${PRELOAD}, so its suites carry no budget of their own.`);
    }
    for (const missing of preloads.filter((preload) => !existsSync(resolve(dir, preload)))) {
        budgetless.push(`${name}: ${BUNFIG} preloads ${missing}, which does not exist, so no suite in the package can start.`);
    }
}

// References.

// An emitted dependency or peer must appear in `references`; a dev dependency doesn't count.
const referencesOf = (configPath, dir) =>
    [...readFileSync(configPath, "utf8").matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((match) => join(dir, match[1]));
const unreferenced = [];
{
    const emitted = new Map(packages.filter(({ pkg }) => emitsDist(pkg)).map(({ name, pkg }) => [pkg.name, name]));
    for (const { name, dir, pkg } of packages) {
        const config = join(dir, "tsconfig.json");
        if (!emitted.has(pkg.name) || !existsSync(config)) {
            continue;
        }
        const referenced = referencesOf(config, name);
        const missing = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
            .filter((dependency) => emitted.has(dependency) && !referenced.includes(emitted.get(dependency)))
            .map((dependency) => `${dependency} (${emitted.get(dependency)})`);
        if (missing.length > 0) {
            unreferenced.push(
                `${name}: depends on ${missing.join(", ")} but its tsconfig.json references no such project, so \`tsgo -b\` may build it against a stale dist`,
            );
        }
    }
}

finish(
    [
        ["Test files outside the program or the budget they belong in", problems],
        ["A package's suites run without the shared budget, or name a preload that does not exist", budgetless],
        ["An emitted package depends on another without a project reference, so the emit may run in the wrong order", unreferenced],
    ],
    [
        "typecheck coverage: every package with tests type-checks them, and every machine-touching suite is named as one",
        "test budgets: every package running suites preloads the shared budget, and every preload it names exists",
        "references: every emitted package names the emitted packages it depends on, so tsgo -b builds them first",
    ],
);
