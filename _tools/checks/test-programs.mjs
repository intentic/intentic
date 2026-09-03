#!/usr/bin/env node
/* EVERY TEST IS IN A PROGRAM, UNDER A BUDGET, AGAINST A WHOLE MOCK, IN THE RIGHT EMIT ORDER: the four facts
 * about a package's tests that no test run can report, read from the manifests and the sources.
 *
 * 1. COVERAGE: every test file sits inside some type-check program. A package that emits to dist excludes
 *    `*.test.ts` from its build config, so the test code stays out of the published tree. That exclusion is
 *    correct and also took the tests out of the only type check the repo ran: 458 type errors had accumulated
 *    in them unseen, almost always a hand-built fake that no longer matched the seam it stood in for.
 *
 *    And a suite that reaches for the machine says so in its NAME. Those run under a budget of their own
 *    (`@intentic/testing/vitest`), selected by the file name, so a suite that opens temp trees, spawns
 *    processes or drives real git under a plain `*.test.ts` name silently gets the 5s hang detector. A suite
 *    can also reach the machine THROUGH a fixture module it imports, so the helpers a suite imports are read as
 *    part of it, found by the convention for where fixtures live (a package's `testing.ts`, or a sibling's
 *    `/testing` subpath) rather than by a list of names, which a new helper obeys for free.
 *
 * 2. BUDGETS: no package inherits vitest's 5s ceiling by accident. That default is a HANG DETECTOR, right for a
 *    test that composes objects in memory and nonsense for one that indexes a workspace. A package that names
 *    no ceiling is not choosing the default, it is unaware of it (docs/ci-failure-audit.md, class E).
 *
 * 3. MOCK COVERAGE: an allow-list mock of a workspace package provides every name the code under test imports.
 *    `vi.mock("@intentic/ui", () => ({ useDevice: … }))` replaces the whole package with the object the factory
 *    returns; the module under test imports from it too, and what IT reaches for is whatever the package grew
 *    last week (class B). A factory that spreads `importOriginal()` cannot drift that way and is not read.
 *
 * 4. REFERENCES: the emit order is the dependency order. `tsgo -b` orders the emit from the tsconfig
 *    `references` and nothing else: a package whose tsconfig names no reference to a workspace dependency is
 *    built wherever the command line puts it, against whatever that dependency's dist holds at the time. On
 *    the self-hosted runners, which keep their workspace between jobs, that is the PREVIOUS build (TS2305, "has
 *    no exported member", about an export that exists in source).
 *
 * All four are recognized by SHAPE rather than listed (AGENTS.md: "guard invariants by discovery, not
 * enumeration"): a list repeats the miss the first time somebody adds the 43rd package. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { finish } from "./lib/report.mjs";
import { byName, configFor, emitsDist, excludesOf, packages, root, sourceOf, TEST_FILE, walk } from "./lib/repo.mjs";

/* ---- 1. coverage, and the integration name ------------------------------------------------------------- */

const MACHINE_PRIMITIVES = /mkdtemp|node:child_process|simple-git|dockerode|testcontainers/;
const FIXTURE_MODULE = /(^|[.-])testing\.[cm]?tsx?$/;
const INTEGRATION_NAME = /\.(integration|e2e)\.(test|spec)\.[cm]?[jt]sx?$/;
// `vi.mock` lines are cut first: naming a module in order to REPLACE it is the opposite of reaching for it.
const mocked = (source) => source.replace(/vi\.mock\([^)]*\)/g, "");

// The named bindings of each import this checkout can resolve, as `{ names, file }`.
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

// What reading those helpers means: their own bodies plus every declaration in the module they reach, so a
// helper that delegates the real work to a private function still counts as doing it.
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

/* Whether a suite does real work. `wanted` is which helpers of the file to read: every one, for the suite
 * itself; the imported ones, for a fixture module it pulls them from. Production modules are not followed at
 * all: they reach the machine by definition, and one import of the daemon would mark every suite in it. */
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
    // Only where the budget exists: vitest selects it by file name. A package driven by Playwright (_tools/e2e)
    // has one budget for the whole run and its specs reach for the machine by definition.
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

/* ---- 2. budgets ---------------------------------------------------------------------------------------- */

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
    // Matched on the suite names rather than the import specifier, because `_tools/testing` imports them from
    // its own source: it is the package. Either the shared pair, or a number said out loud.
    if (!/\bUNIT_SUITE\b|\bINTEGRATION_SUITE\b/.test(source) && !/\btestTimeout\b/.test(source)) {
        budgetless.push(
            `${name}: ${VITEST_CONFIG} spreads neither UNIT_SUITE nor INTEGRATION_SUITE and sets no testTimeout, ` +
                `so its suites inherit the 5s hang detector silently. Use the shared pair, or state the ceiling ` +
                `this package needs and why (see _editor/web/vitest.config.ts).`,
        );
    }
}

/* ---- 3. mock coverage ---------------------------------------------------------------------------------- */

const MOCK = /vi\.mock\(\s*["']([^"']+)["']\s*,\s*(async\s*)?\(\s*\)\s*=>\s*\(?\s*\{/g;
const RELATIVE_IMPORT = /import\s+(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\}\s*)?from\s*["'](\.[^"']+)["']/g;
// The object literal that opens at `from`, by brace depth.
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
// The keys an object literal states: `name:`, `name(`, a shorthand `name,`/`name }`, or a quoted key.
const keysOf = (literal) =>
    new Set(
        [...literal.matchAll(/(?:^|[,{]\s*)(?:async\s+)?(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*(?=[:(,}])/gm)].map(
            (match) => match[1] ?? match[2],
        ),
    );
// The runtime names `source` imports from `specifier`: default as "default", named by their exported name.
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
// What one mock leaves unprovided: a line per reader that imports a name the factory's object lacks.
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

/* ---- 4. references ------------------------------------------------------------------------------------- */

// Read from the two manifests alone: a dependency (or peer) that is itself emitted has to appear in the
// dependent's `references`. Dev dependencies are left out because the emit does not read them.
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
