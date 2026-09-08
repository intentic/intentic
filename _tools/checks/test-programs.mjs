#!/usr/bin/env node
// Checks four facts about a package's tests no test run reports: coverage, budgets, mock coverage, and build-reference
// order. All four are recognized by shape, not a list, so a new package needs no addition here.
// 1. every test file sits inside some type-check program; a suite reaching the machine is named as one
//    (`.integration.`/`.e2e.`), even through an imported fixture module
// 2. every package running vitest sets its own budget (UNIT_SUITE/INTEGRATION_SUITE or testTimeout), instead of
//    inheriting vitest's 5s hang detector
// 3. an allow-list `vi.mock` of a workspace package provides every name the code under test imports from it
// 4. an emitted package's tsconfig references every emitted package it depends on, so `tsgo -b` builds them in order
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { finish } from "./lib/report.mjs";
import { byName, configFor, emitsDist, excludesOf, packages, root, sourceOf, TEST_FILE, walk } from "./lib/repo.mjs";

// Coverage, and the integration name.

const MACHINE_PRIMITIVES = /mkdtemp|node:child_process|simple-git|dockerode|testcontainers/;
const FIXTURE_MODULE = /(^|[.-])testing\.[cm]?tsx?$/;
const INTEGRATION_NAME = /\.(integration|e2e)\.(test|spec)\.[cm]?[jt]sx?$/;
// Cuts `vi.mock` lines first: naming a module to replace it isn't reaching for it.
const mocked = (source) => source.replace(/vi\.mock\([^)]*\)/g, "");

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
    const source = mocked(readFileSync(file, "utf8"));
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
    // Only where the budget exists: vitest picks it by file name; Playwright specs reach the machine by definition.
    const runsVitest = /vitest/.test(pkg.scripts?.test ?? "");
    for (const file of runsVitest ? walk(dir) : []) {
        if (INTEGRATION_NAME.test(file) || !reachesTheMachine(file, undefined)) {
            continue;
        }
        const relative = file.slice(root.length + 1);
        problems.push(
            `${relative}: opens temp trees, spawns processes or drives real git, but its name puts it under the ` +
                `unit budget (5s): rename it to ${relative.replace(/\.(test|spec)\./, ".integration.$1.")}`,
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

const VITEST_CONFIG = "vitest.config.ts";
const budgetless = [];
for (const { name, dir, pkg } of packages) {
    if (!/vitest/.test(pkg.scripts?.test ?? "") || walk(dir).length === 0) {
        continue;
    }
    const config = join(dir, VITEST_CONFIG);
    if (!existsSync(config)) {
        budgetless.push(
            `${name}: runs vitest with no ${VITEST_CONFIG}, so every suite gets the 5s hang detector. Add one: ` +
                `\`projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }]\` from @intentic/testing/vitest.`,
        );
        continue;
    }
    const source = readFileSync(config, "utf8");
    // Matched on the suite names, not the import specifier: _tools/testing imports them from its own source.
    if (!/\bUNIT_SUITE\b|\bINTEGRATION_SUITE\b/.test(source) && !/\btestTimeout\b/.test(source)) {
        budgetless.push(
            `${name}: ${VITEST_CONFIG} spreads neither UNIT_SUITE nor INTEGRATION_SUITE and sets no testTimeout, ` +
                `so its suites inherit the 5s hang detector silently. Use the shared pair, or state the ceiling ` +
                `this package needs and why (see _editor/web/vitest.config.ts).`,
        );
    }
}

// Mock coverage.

const MOCK = /vi\.mock\(\s*["']([^"']+)["']\s*,\s*(async\s*)?\(\s*\)\s*=>\s*\(?\s*\{/g;
const RELATIVE_IMPORT = /import\s+(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\}\s*)?from\s*["'](\.[^"']+)["']/g;
// The object literal that opens at `from`, found by brace depth.
const literalAt = (source, from) => {
    let depth = 0;
    for (let i = from; i < source.length; i += 1) {
        if (source[i] === "{") {
            depth += 1;
        } else if (source[i] === "}") {
            depth -= 1;
            if (depth === 0) {
                return source.slice(from, i + 1);
            }
        }
    }
    return source.slice(from);
};
// Keys an object literal states: `name:`, `name(`, a shorthand, or a quoted key.
const keysOf = (literal) =>
    new Set(
        [...literal.matchAll(/(?:^|[,{]\s*)(?:async\s+)?(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*(?=[:(,}])/gm)].map(
            (match) => match[1] ?? match[2],
        ),
    );
// Runtime names `source` imports from `specifier`: default as "default", named by their exported name.
const namedImportsOf = (source, specifier) => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const names = new Set();
    for (const match of source.matchAll(
        new RegExp(String.raw`import\s+(?!type\s)([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']${escaped}["']`, "g"),
    )) {
        if (match[1] !== undefined) {
            names.add("default");
        }
        for (const binding of (match[2] ?? "").split(",")) {
            const name = binding
                .trim()
                .split(/\s+as\s+/)[0]
                ?.trim();
            if (name !== undefined && name !== "" && !name.startsWith("type ")) {
                names.add(name);
            }
        }
    }
    return names;
};
// The test file and the modules it stands up (its relative imports, one level), each as `[path, text]`.
const readersOf = (file, source) => {
    const readers = [[file, source]];
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
        const target = sourceOf(file, specifier);
        if (target !== undefined && existsSync(target) && !TEST_FILE.test(target)) {
            readers.push([target, readFileSync(target, "utf8")]);
        }
    }
    return readers;
};
// What one mock leaves unprovided: a line per reader importing a name the factory's object lacks.
const mockGaps = (file, source, match, readers) => {
    const [, specifier] = match;
    const provided = keysOf(literalAt(source, source.indexOf("{", match.index + match[0].length - 1)));
    return readers.flatMap(([reader, text]) => {
        const missing = [...namedImportsOf(text, specifier)].filter((name) => !provided.has(name));
        return missing.length === 0
            ? []
            : [
                  `${file.slice(root.length + 1)}: vi.mock("${specifier}") provides {${[...provided].join(", ")}} but ` +
                      `${reader.slice(root.length + 1)} imports {${missing.join(", ")}} from it: spread \`await importOriginal()\` into the factory, or add them`,
              ];
    });
};
const unmocked = [];
for (const { dir, pkg } of packages) {
    if (!/vitest/.test(pkg.scripts?.test ?? "")) {
        continue;
    }
    for (const file of walk(dir)) {
        const source = readFileSync(file, "utf8");
        const mocks = [...source.matchAll(MOCK)].filter(([, specifier]) => byName.has(specifier.split("/").slice(0, 2).join("/")));
        if (mocks.length === 0) {
            continue;
        }
        const readers = readersOf(file, source);
        unmocked.push(...mocks.flatMap((match) => mockGaps(file, source, match, readers)));
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
        ["A package's tests run on vitest's default 5s ceiling without saying so", budgetless],
        ["A workspace package is mocked with an allow-list that misses a name the code under test imports", unmocked],
        ["An emitted package depends on another without a project reference, so the emit may run in the wrong order", unreferenced],
    ],
    [
        "typecheck coverage: every package with tests type-checks them, and every machine-touching suite is named as one",
        "test budgets: every package running vitest names its ceiling instead of inheriting the 5s hang detector",
        "mock coverage: every allow-list mock of a workspace package provides what the code under test imports from it",
        "references: every emitted package names the emitted packages it depends on, so tsgo -b builds them first",
    ],
);
