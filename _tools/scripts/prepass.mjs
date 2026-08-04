#!/usr/bin/env node
/* Both gates, made runnable everywhere the code is written.
 *
 * `pnpm typecheck` runs this and then `turbo run typecheck`; `pnpm test` runs this and then `turbo run test
 * --only`. Three invariants live here, and all three exist because the checks that catch drift used to run in
 * exactly one place — CI, on main, after the merge.
 *
 * The first two need no node_modules and no network, which is what lets `--checks-only` run them from a
 * `pre-push` hook and from a CI job that has not installed anything yet (ci.yml, the `preflight` job).
 * Measured over 40 main pipelines, 10 of the 22 red ones died on invariant 1 or 3 — each after 0.6-2.0 min of
 * runner time, in four jobs at once, for a fact that is readable from the checkout in under a second.
 *
 * 1. COVERAGE — every test file sits inside some type-check program.
 *
 * A package that emits to dist excludes `*.test.ts` from its build config, so the test code stays out of the
 * published tree. That exclusion is correct and also took the tests out of the only type check the repo ran:
 * 458 type errors had accumulated in them unseen, and the shape of those errors was almost always the same — a
 * hand-built fake that no longer matched the seam it stood in for. A daemon fake was missing FOURTEEN required
 * members of Services and still compiled, because spreading a `Partial<T>` into a `T`-annotated literal tells
 * the compiler every key might be supplied. Nothing said a word until some unrelated route reached one of them
 * and a hundred tests failed at once with "Internal server error".
 *
 * 2. DIST — every package a check reads, or a test imports, is compiled before either runs.
 *
 * turbo models this as `dependsOn ["^build"]`, which is correct and unrunnable outside CI: `build` goes through
 * pnpm, pnpm's `syncInjectedDepsAfterScripts` hardlinks into `node_modules` after it, and in an agent worktree
 * `node_modules` is a different filesystem — so the compile succeeds and the run dies EXDEV (exit 238). EVERY
 * agent runs in a worktree. Both gates therefore ran nowhere that anyone could act on them before landing, and
 * main spent 1h48m red across ten landed commits with nobody able to see it locally.
 *
 * `tsgo -b` writes the same output without pnpm in the path, so it works in a worktree and in CI alike. That is
 * the whole fix: same command, same result, both places. It is what lets `pnpm test` skip the `^build` edge
 * (`turbo run test --only`) and still have every suite import a CURRENT dependency rather than whatever the
 * main checkout last compiled — 45 packages, ~40s, which is the difference between a suite the fleet runs
 * before landing and one only CI ever sees.
 *
 * Skipping the prepass is worse than not checking at all. Run against the dist a worktree inherits — built
 * from whatever the main checkout last compiled — `_apps/sandbox` reported 19 errors, of which 16 were stale
 * declarations and 3 were real. Output like that is what teaches everyone to read a red type check as
 * "baseline failures" and land anyway.
 *
 * 3. LOCKFILE — every dependency specifier in a package.json is the one the lockfile recorded.
 *
 * `pnpm install --frozen-lockfile` is the first line of every CI job, and ERR_PNPM_OUTDATED_LOCKFILE is what it
 * says when someone edited a package.json without installing. That is a pure comparison between two files in
 * the checkout, and CI reaches it only after resolving 1,800+ packages against the registry — 0.6-1.5 min, paid
 * by four jobs in parallel, to report a mismatch that needs no network to see. `verifyDepsBeforeRun: false`
 * (pnpm-workspace.yaml) is what makes it reachable at all: with the pre-run deps check off, nothing else in a
 * worktree ever says the manifest and the lockfile disagree.
 *
 * Read with a line scanner rather than a YAML parser on purpose — the check has to run BEFORE `pnpm install`,
 * so it cannot import one. The `importers:` block it reads is the flattest, most stable region of the v9 format
 * (importer at 2 spaces, dependency block at 4, name at 6, `specifier:` at 8), and a shape it stops recognizing
 * is a shape this reports as drift rather than passing in silence.
 *
 * All three invariants are recognized by SHAPE rather than listed, because a list repeats the miss the first time
 * somebody adds the 43rd package (AGENTS.md — "guard invariants by discovery, not enumeration"). The
 * hand-written `tsconfig.libs.json` is the proof: it names 13 of the 23 packages that need building, and the
 * one it happens to omit — `@intentic/constants` — was on its own worth 3 phantom errors in the daemon.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = ["_apps", "_libs", "_extensions", "_tools"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "generated", ".git"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Every workspace package, as `{ name: "_libs/graph", dir, pkg }` — the one directory walk both checks read.
const packages = WORKSPACES.flatMap((workspace) =>
    readdirSync(join(root, workspace)).flatMap((name) => {
        const dir = join(root, workspace, name);
        const manifest = join(dir, "package.json");
        return existsSync(manifest) ? [{ name: `${workspace}/${name}`, dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) }] : [];
    }),
);

const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (SKIP_DIRS.has(entry.name)) {
            return [];
        }
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : TEST_FILE.test(entry.name) ? [path] : [];
    });

// tsconfigs here carry comments and trailing commas; this only needs `exclude`, so read it without a parser.
const excludesOf = (configPath) => {
    const raw = readFileSync(configPath, "utf8");
    const match = /"exclude"\s*:\s*\[([^\]]*)\]/.exec(raw);
    return match === null ? [] : [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

// Which config `pnpm typecheck` actually compiles — `-p <path>` if the script names one, else tsconfig.json.
const configFor = (script) => /-p\s+(\S+)/.exec(script)?.[1] ?? "tsconfig.json";

/* What makes a suite an INTEGRATION suite: it reaches for the machine, so how long it takes is a fact about
 * the runner and not about the code. Those run under a budget of their own (`@intentic/testing/vitest`), and
 * the budget is selected by the FILE NAME — so a suite that opens temp trees, spawns processes, drives real
 * git or boots containers under a plain `*.test.ts` name silently gets the 5s hang detector instead.
 *
 * That is not a hypothetical: iq-engine's warm pass, the chat-tabs mount and the daemon's fire routes each
 * went red on a loaded CI runner and each was repaired by hand with its own constant, after main was already
 * broken. Recognized by shape rather than by a list, like every other invariant here. `vi.mock` lines are cut
 * first — naming a module in order to REPLACE it is the opposite of reaching for it. */
/* A suite can also reach the machine THROUGH a fixture module — `makeFixtureWorkspace` writes 900 files under
 * tmpdir, `tempWorkspace` builds a repo tree, `runAgentTurn` drives the real turn path — naming none of the
 * primitives itself. Naming those helpers here instead was the enumeration this file warns against, and it
 * missed: iq-engine's resident-thread suite builds and indexes a 900-file tree through one of them and, under a
 * plain `*.test.ts` name, sat under the 5s detector until a loaded runner failed it three times on main.
 *
 * So the helpers a suite IMPORTS are read as part of the suite, found by the convention for where fixtures live
 * (AGENTS.md: a package's `testing.ts`) rather than by a list of names, which a new helper obeys for free. Per
 * HELPER and not per module, because one fixture module holds both kinds: four route suites import `routesClient`
 * out of the same file as `tempWorkspace`, compose objects in memory, and would be renamed to say they reach for
 * a machine they never touch. Production modules are not followed at all — they reach the machine by definition,
 * and one import of the daemon would mark every suite in it. */
const MACHINE_PRIMITIVES = /mkdtemp|node:child_process|simple-git|dockerode|testcontainers/;
const FIXTURE_MODULE = /(^|[.-])testing\.[cm]?tsx?$/;
const INTEGRATION_NAME = /\.(integration|e2e)\.(test|spec)\.[cm]?[jt]sx?$/;
const mocked = (source) => source.replace(/vi\.mock\([^)]*\)/g, "");

// The named bindings of each relative import, as `{ names, file }`. The repo writes ESM (`./testing.js` for
// `testing.ts`), so the extension in the specifier is the one the compiler emits, not the one on disk.
const IMPORTS = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g;
const importsOf = (file, source) =>
    [...source.matchAll(IMPORTS)].flatMap(([, clause, specifier]) => {
        const path = join(dirname(file), specifier);
        const target = [path.replace(/\.[cm]?js$/, ".ts"), path.replace(/\.[cm]?js$/, ".tsx"), `${path}.ts`].find((candidate) =>
            existsSync(candidate),
        );
        return target === undefined
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

/* Whether a suite does real work. `wanted` is which helpers of the file to read — every one, for the suite
 * itself; the imported ones, for a fixture module it pulls them from. */
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
    // has one budget for the whole run, declared in its own config, and its specs reach for the machine by
    // definition — holding them to this name would say nothing.
    const runsVitest = /vitest/.test(pkg.scripts?.test ?? "");
    for (const file of runsVitest ? walk(dir) : []) {
        if (INTEGRATION_NAME.test(file) || !reachesTheMachine(file, undefined)) {
            continue;
        }
        const relative = file.slice(root.length + 1);
        problems.push(
            `${relative}: opens temp trees, spawns processes or drives real git, but its name puts it under the ` +
                `unit budget (5s) — rename it to ${relative.replace(/\.(test|spec)\./, ".integration.$1.")}`,
        );
    }
    if (walk(dir).length === 0) {
        continue;
    }
    const typecheck = pkg.scripts?.typecheck;
    if (typecheck === undefined) {
        problems.push(`${name}: has test files but no "typecheck" script — turbo skips it silently`);
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
            `${name}: ${configFor(typecheck)} excludes ${excluded.join(", ")} — its tests are in no type-check program. ` +
                `Point "typecheck" at a tsconfig.test.json that re-includes them (see any emitting package).`,
        );
    }
}

/* Invariant 3. The `importers:` region of pnpm-lock.yaml, as `importer -> block -> { name: specifier }`.
 *
 * A line scanner rather than a YAML parser because this has to run before `pnpm install` — see the header. The
 * indentation IS the grammar here (2/4/6/8), and each level's anchor makes the levels mutually exclusive, so a
 * line is read as exactly one of importer, block, entry or specifier. Everything outside `importers:` — the
 * `packages:` and `snapshots:` regions, which are far larger and far less regular — is never looked at. */
const unquote = (value) => (/^'.*'$/s.test(value) ? value.slice(1, -1).replaceAll("''", "'") : /^".*"$/s.test(value) ? value.slice(1, -1) : value);

const LEVELS = [
    { depth: 2, of: "importer" },
    { depth: 4, of: "block" },
    { depth: 6, of: "entry" },
];
const SPECIFIER = /^ {8}specifier:[ \t]*(.*?)[ \t]*$/;

const recorded = new Map();
let inImporters = false;
let at, block, entry;
for (const line of readFileSync(join(root, "pnpm-lock.yaml"), "utf8").split("\n")) {
    // A column-0 key ends the region as surely as it starts it; blank lines are neither and are left alone.
    if (/^\S/.test(line)) {
        inImporters = line.startsWith("importers:");
        continue;
    }
    if (!inImporters) {
        continue;
    }
    const level = LEVELS.find(({ depth }) => new RegExp(String.raw`^ {${depth}}\S`).test(line));
    const key = level && new RegExp(String.raw`^ {${level.depth}}(\S.*?):[ \t]*$`).exec(line);
    if (key) {
        const name = unquote(key[1]);
        if (level.of === "importer") {
            at = name;
            recorded.set(at, new Map());
        } else if (level.of === "block") {
            block = name;
            // `?.` here and below: a level arriving without its parent means the shape moved, and the empty
            // `recorded` that leaves is reported as drift by the size check — which a stack trace would not be.
            recorded.get(at)?.set(block, new Map());
        } else {
            entry = name;
        }
        continue;
    }
    const specifier = SPECIFIER.exec(line);
    if (specifier) {
        recorded.get(at)?.get(block)?.set(entry, unquote(specifier[1]));
    }
}

/* The catalogs, as `catalog name -> { dependency: version }`. A `catalog:` specifier in a package.json may be
 * recorded in the importer EITHER verbatim or already resolved through these — pnpm writes whichever form was
 * current when that entry was last touched, and accepts both on the way back in. This lockfile holds both at
 * once (`@orpc/server: 'catalog:'` beside `zod: 4.4.3`), and the pipelines that installed it were green, which
 * is the whole reason this is a resolution and not a string compare. Same flat shape, same scanner: `catalog:`
 * at column 0 is the default catalog's entries, `catalogs:` is a level of named ones above them. */
const catalogs = new Map([["default", new Map()]]);
let named;
for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^\S/.test(line)) {
        named = line.startsWith("catalog:") ? "default" : line.startsWith("catalogs:") ? "" : undefined;
        continue;
    }
    if (named === undefined || /^\s*(#|$)/.test(line)) {
        continue;
    }
    const mapping = /^ {2}(\S.*?):[ \t]*(.*?)[ \t]*$/.exec(line) ?? /^ {4}(\S.*?):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (mapping === null) {
        continue;
    }
    // A 2-space key with no value inside `catalogs:` names the catalog the 4-space entries below it belong to.
    if (named === "" || (mapping[2] === "" && /^ {2}\S/.test(line))) {
        named = unquote(mapping[1]);
        catalogs.set(named, new Map());
        continue;
    }
    catalogs.get(named).set(unquote(mapping[1]), unquote(mapping[2]));
}

/* What a package.json declares, flattened to `name -> { specifier, required }`.
 *
 * Compared as one set against the union of the importer's blocks rather than block by block, because which
 * block an entry lands in is pnpm's business and not a fact about the manifest: `autoInstallPeers: true` (see
 * the lockfile's own settings) installs peerDependencies and files them under the importer's `dependencies`,
 * which is why `_libs/astro-integrations` records an `astro` its package.json only ever declares as a peer.
 * Matching by name keeps every drift this exists to catch — a dependency added, removed, or re-specified
 * without an install — and drops a placement rule that would only ever produce false alarms.
 *
 * A peer is PERMITTED rather than required for the same reason from the other side: pnpm installs one only when
 * nothing else already satisfies it, so its absence from the lockfile says nothing, while a mismatch still does.
 * And it never SHADOWS a real declaration — a package that declares the same name both ways is recorded by the
 * real one, which every Vue library here does (`vue: catalog:` as a devDependency, `vue: 3` as the peer). */
const declaredBy = (manifest) => {
    const declared = new Map(
        ["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) =>
            Object.entries(manifest[field] ?? {}).map(([name, specifier]) => [name, { specifier, required: true }]),
        ),
    );
    for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!declared.has(name)) {
            declared.set(name, { specifier, required: false });
        }
    }
    return declared;
};

// Whether the lockfile's recorded specifier is one the declared specifier is allowed to have produced.
const matches = (name, declared, inLockfile) => {
    if (inLockfile === declared) {
        return true;
    }
    if (!declared.startsWith("catalog:")) {
        return false;
    }
    return catalogs.get(declared.slice("catalog:".length) || "default")?.get(name) === inLockfile;
};

// Every importer pnpm would write, by the same walk the checks above use, plus the root the walk does not reach.
const importers = [{ at: ".", dir: root }, ...packages.map(({ name, dir }) => ({ at: name, dir }))];

const drift = [];
if (recorded.size === 0) {
    drift.push(`pnpm-lock.yaml has no readable "importers:" region — the lockfile format moved and this check needs rewriting`);
}
for (const { at: importer, dir } of recorded.size === 0 ? [] : importers) {
    const declared = declaredBy(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
    const blocks = recorded.get(importer);
    if (blocks === undefined) {
        // A package that installs nothing gets no importer — there is nothing for pnpm to have recorded.
        if (declared.size > 0) {
            drift.push(`${importer}: declares dependencies but has no importer in the lockfile — it has never been installed`);
        }
        continue;
    }
    const inLockfile = new Map(blocks.values().flatMap((fromBlock) => fromBlock.entries()));
    for (const [name, { specifier, required }] of declared) {
        const was = inLockfile.get(name);
        if (was === undefined) {
            if (required) {
                drift.push(`${importer}: ${name}@${specifier} is not in the lockfile`);
            }
        } else if (!matches(name, specifier, was)) {
            drift.push(`${importer}: ${name} is ${specifier}, the lockfile records ${was}`);
        }
    }
    for (const name of inLockfile.keys()) {
        if (!declared.has(name)) {
            drift.push(`${importer}: ${name} is in the lockfile but no longer in package.json`);
        }
    }
}
for (const importer of recorded.keys()) {
    if (!importers.some(({ at: known }) => known === importer)) {
        drift.push(`${importer}: an importer in the lockfile with no package.json — the package was removed without installing`);
    }
}

// Both reports before either exit, so one run says everything that is wrong rather than the first thing.
const reports = [
    ["Test files outside the program or the budget they belong in", problems],
    ["pnpm-lock.yaml is out of date — run `pnpm install` and commit it (this is CI's ERR_PNPM_OUTDATED_LOCKFILE)", drift],
];
if (reports.some(([, lines]) => lines.length > 0)) {
    for (const [heading, lines] of reports.filter(([, some]) => some.length > 0)) {
        console.error(`${heading}:\n${lines.map((line) => `  - ${line}`).join("\n")}`);
    }
    process.exit(1);
}
console.log(`typecheck coverage: every package with tests type-checks them, and every machine-touching suite is named as one`);
console.log(`lockfile: ${importers.length} importers record the specifiers their package.json declares`);

/* Everything below needs node_modules and writes to the tree; everything above reads the checkout and nothing
 * else. `--checks-only` is that line — it is what the pre-push hook and the CI preflight job run. */
if (process.argv.includes("--checks-only")) {
    process.exit(0);
}

/* A package needs building exactly when its `exports` resolve into `dist/`: that is the path a DEPENDENT's
 * compiler reads, so a stale or absent dist there is a phantom error in somebody else's package. The ones that
 * export `./src/...` (the Vue libraries) are already the source of truth and have nothing to emit.
 * `tsgo -b` orders the set itself from the project references, and is incremental — a no-op pass is ~1s. */
const needsDeclarations = packages.filter(({ pkg }) => /\.\/dist\//.test(JSON.stringify(pkg.exports ?? "")));

/* A package whose sources are themselves GENERATED has nothing for `tsgo -b` to read until its generator has
 * run: `_libs/prisma` is one re-export of `./generated/client.js`, which `prisma generate` writes and git
 * ignores. turbo used to cover this by way of `^build` (the package's `build` runs the generator first); this
 * prepass replaced `^build`, and on a fresh checkout it therefore reported the generated module as missing —
 * one TS2307 in the prepass, then `@intentic-app/prisma` unresolvable in every dependent, ~20 errors deep in
 * api and e2e that named nothing about the real cause. Recognized by shape (a `generate` script), not by name,
 * and run through a shell with the package's own `.bin` on PATH rather than through pnpm — pnpm's
 * `syncInjectedDepsAfterScripts` hardlinks into `node_modules` afterwards and dies EXDEV in an agent worktree,
 * which is the very thing this script exists to keep out of the path. Generation is unconditional: it is
 * ~0.8s, and a conditional pass would have to model each generator's inputs to know when it is stale. */
const generated = needsDeclarations.filter(({ pkg }) => pkg.scripts?.generate !== undefined);
for (const { name, dir, pkg } of generated) {
    console.log(`generating: ${name}`);
    const bin = [join(dir, "node_modules/.bin"), join(root, "node_modules/.bin"), process.env.PATH].join(":");
    const generate = spawnSync(pkg.scripts.generate, { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, PATH: bin } });
    if (generate.status !== 0) {
        process.exit(generate.status ?? 1);
    }
}

console.log(`declarations: building ${needsDeclarations.length} packages that dependents read from dist`);
const build = spawnSync(join(root, "node_modules/.bin/tsgo"), ["-b", ...needsDeclarations.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}
