#!/usr/bin/env node
/* Both gates, made runnable everywhere the code is written.
 *
 * `pnpm typecheck` runs this and then `turbo run typecheck`; `pnpm test` runs this and then `turbo run test
 * --only`. Thirteen invariants live here, and all of them exist because the checks that catch drift used to run
 * in exactly one place (CI, on main, after the merge. (5 through 13) the release-heading contract, the
 * undeclared-shrink gate on the wire contract, the armed-hooks check, the reusable-workflow permission
 * ceiling, the runner npm will attest a publish from, the tag pushes GitHub never delivers, the packages a
 * lockfile keeps after nothing depends on them, the Vue templates no type checker reads, and the vitest ceiling
 * a package inherits by saying nothing: are documented at their own blocks below.)
 *
 * All but invariant 2 need no network, which is what lets `--checks-only` run them from a `pre-push` hook and
 * from a CI job that has not installed anything yet (ci.yml, the `preflight` job). Two of them read
 * node_modules and are written to do without it: invariant 2 regenerates, so it stays below the `--checks-only`
 * line entirely; invariant 12 compiles templates when the compiler is there and says so when it is not, which
 * is what puts the gate in front of a push instead of behind one.
 *
 * Measured over 40 main pipelines, 10 of the 22 red ones died on invariant 1 or 3: each after 0.6-2.0 min of
 * runner time, in four jobs at once, for a fact that is readable from the checkout in under a second.
 *
 * 1. COVERAGE: every test file sits inside some type-check program.
 *
 * A package that emits to dist excludes `*.test.ts` from its build config, so the test code stays out of the
 * published tree. That exclusion is correct and also took the tests out of the only type check the repo ran:
 * 458 type errors had accumulated in them unseen, and the shape of those errors was almost always the same: a
 * hand-built fake that no longer matched the seam it stood in for. A daemon fake was missing FOURTEEN required
 * members of Services and still compiled, because spreading a `Partial<T>` into a `T`-annotated literal tells
 * the compiler every key might be supplied. Nothing said a word until some unrelated route reached one of them
 * and a hundred tests failed at once with "Internal server error".
 *
 * 2. DIST: every package a check reads, or a test imports, is compiled before either runs.
 *
 * turbo models this as `dependsOn ["^build"]`, which is correct and unrunnable outside CI: `build` goes through
 * pnpm, pnpm's `syncInjectedDepsAfterScripts` hardlinks into `node_modules` after it, and in an agent worktree
 * `node_modules` is a different filesystem, so the compile succeeds and the run dies EXDEV (exit 238). EVERY
 * agent runs in a worktree. Both gates therefore ran nowhere that anyone could act on them before landing, and
 * main spent 1h48m red across ten landed commits with nobody able to see it locally.
 *
 * `tsgo -b` writes the same output without pnpm in the path, so it works in a worktree and in CI alike. That is
 * the whole fix: same command, same result, both places. It is what lets `pnpm test` skip the `^build` edge
 * (`turbo run test --only`) and still have every suite import a CURRENT dependency rather than whatever the
 * main checkout last compiled: 45 packages, ~40s, which is the difference between a suite the fleet runs
 * before landing and one only CI ever sees.
 *
 * Skipping the prepass is worse than not checking at all. Run against the dist a worktree inherits: built
 * from whatever the main checkout last compiled: `_sandbox/sandbox` reported 19 errors, of which 16 were stale
 * declarations and 3 were real. Output like that is what teaches everyone to read a red type check as
 * "baseline failures" and land anyway.
 *
 * 3. LOCKFILE: every dependency specifier in a package.json is the one the lockfile recorded.
 *
 * `pnpm install --frozen-lockfile` is the first line of every CI job, and ERR_PNPM_OUTDATED_LOCKFILE is what it
 * says when someone edited a package.json without installing. That is a pure comparison between two files in
 * the checkout, and CI reaches it only after resolving 1,800+ packages against the registry: 0.6-1.5 min, paid
 * by four jobs in parallel, to report a mismatch that needs no network to see. `verifyDepsBeforeRun: false`
 * (pnpm-workspace.yaml) is what makes it reachable at all: with the pre-run deps check off, nothing else in a
 * worktree ever says the manifest and the lockfile disagree.
 *
 * Read with a line scanner rather than a YAML parser on purpose: the check has to run BEFORE `pnpm install`,
 * so it cannot import one. The `importers:` block it reads is the flattest, most stable region of the v9 format
 * (importer at 2 spaces, dependency block at 4, name at 6, `specifier:` at 8), and a shape it stops recognizing
 * is a shape this reports as drift rather than passing in silence.
 *
 * 4. FORK BOUNDARY: no job of a fork-triggerable workflow reaches the self-hosted fleet from a fork.
 *
 * This repository is public and CI runs on runners that are not ephemeral, share one /ci-cache with `release`,
 * and mount the host docker socket. A pull request from a fork therefore had a path to host root and, through a
 * poisoned cache entry, into a published artifact: GitHub's own warning on the runner page. The boundary is
 * that the fleet builds only branches pushed to this repository, and it takes BOTH this guard and the repo's
 * approval-for-all-outside-contributors setting: approval alone still runs a hostile postinstall once someone
 * clicks it, and this guard alone is editable by a fork, because a `pull_request` event runs the workflow file
 * from the pull request's own merge ref. Neither covers the other's case (docs/ci-runner.md).
 *
 * It is asserted here rather than trusted because it is the kind of property that regresses in silence: the two
 * guards sit on the DAG roots, thirteen other jobs inherit safety by descending from them, and a job added
 * without a `needs` edge would simply be exposed with nothing going red. A skipped dependency skips its
 * dependents: that inheritance is the whole mechanism, and `always()`/`!cancelled()` are the two ways to opt
 * out of it, so a job using either has to read a safe parent's result or output to still see the skip.
 *
 * All four invariants are recognized by SHAPE rather than listed, because a list repeats the miss the first time
 * somebody adds the 43rd package (AGENTS.md: "guard invariants by discovery, not enumeration"). The
 * hand-written `tsconfig.libs.json` is the proof: it names 13 of the 23 packages that need building, and the
 * one it happens to omit (`@intentic/constants`) was on its own worth 3 phantom errors in the daemon.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
/* BY FILE, NOT BY PACKAGE NAME. The walker is the same one `@intentic/constants/node` exports, but a BARE
 * specifier is resolved through `node_modules`, and the two callers that matter most here run before there is
 * one: the `preflight` job checks out and runs this immediately (no `pnpm install`), and the `pre-push` hook
 * fires on a clone that may never have installed. Both died on ERR_MODULE_NOT_FOUND before reaching a single
 * invariant. A relative specifier is resolved by the filesystem alone, so it works at every point in the
 * build, and unlike a counted root it cannot go quietly wrong: move either file and the import fails loudly.
 * One `..` to a sibling package, and still one copy of the walk. */
import { repoRoot } from "../constants/src/node.mjs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = repoRoot(import.meta.url);
// Discovered, not listed: every `_`-prefixed root directory is a package group (pnpm-workspace.yaml globs the same set).
const WORKSPACES = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("_"))
    .map((entry) => entry.name);
const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "generated", ".git"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const VUE_FILE = /\.vue$/;

/* The workspace file's negations are part of the same discovery: a directory it excludes (the store shells:
 * installed standalone on the machine that actually builds them, a Mac with Xcode or Bubblewrap's JDK) is not
 * an importer, so the lockfile owes it nothing and its files belong to no type-check program here. Exact
 * paths only, matching how the negations are written; a glob negation would be a shape this scanner does not
 * recognize, and the package it hides would then fail invariant 3 loudly rather than pass in silence. */
const EXCLUDED = new Set();
{
    let inPackages = false;
    for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
        if (/^\S/.test(line)) {
            inPackages = line.startsWith("packages:");
            continue;
        }
        const negated = inPackages && /^\s*-\s*["']?!(.+?)["']?\s*$/.exec(line);
        if (negated) {
            EXCLUDED.add(negated[1]);
        }
    }
}

// Every workspace package, as `{ name: "_deploy/graph", dir, pkg }`, the one directory walk both checks read.
const packages = WORKSPACES.flatMap((workspace) =>
    readdirSync(join(root, workspace)).flatMap((name) => {
        if (EXCLUDED.has(`${workspace}/${name}`)) {
            return [];
        }
        const dir = join(root, workspace, name);
        const manifest = join(dir, "package.json");
        return existsSync(manifest) ? [{ name: `${workspace}/${name}`, dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) }] : [];
    }),
);

// One walk, two file kinds: the test files invariant 1 reads, and the templates invariant 12 compiles.
const walk = (dir, wanted = TEST_FILE) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (SKIP_DIRS.has(entry.name)) {
            return [];
        }
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path, wanted) : wanted.test(entry.name) ? [path] : [];
    });

// tsconfigs here carry comments and trailing commas; this only needs `exclude`, so read it without a parser.
const excludesOf = (configPath) => {
    const raw = readFileSync(configPath, "utf8");
    const match = /"exclude"\s*:\s*\[([^\]]*)\]/.exec(raw);
    return match === null ? [] : [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

// Which config `pnpm typecheck` actually compiles: `-p <path>` if the script names one, else tsconfig.json.
const configFor = (script) => /-p\s+(\S+)/.exec(script)?.[1] ?? "tsconfig.json";

/* What makes a suite an INTEGRATION suite: it reaches for the machine, so how long it takes is a fact about
 * the runner and not about the code. Those run under a budget of their own (`@intentic/testing/vitest`), and
 * the budget is selected by the FILE NAME, so a suite that opens temp trees, spawns processes, drives real
 * git or boots containers under a plain `*.test.ts` name silently gets the 5s hang detector instead.
 *
 * That is not a hypothetical: iq-engine's warm pass, the chat-tabs mount and the daemon's fire routes each
 * went red on a loaded CI runner and each was repaired by hand with its own constant, after main was already
 * broken. Recognized by shape rather than by a list, like every other invariant here. `vi.mock` lines are cut
 * first: naming a module in order to REPLACE it is the opposite of reaching for it. */
/* A suite can also reach the machine THROUGH a fixture module: `makeFixtureWorkspace` writes 900 files under
 * tmpdir, `tempWorkspace` builds a repo tree, `runAgentTurn` drives the real turn path: naming none of the
 * primitives itself. Naming those helpers here instead was the enumeration this file warns against, and it
 * missed: iq-engine's resident-thread suite builds and indexes a 900-file tree through one of them and, under a
 * plain `*.test.ts` name, sat under the 5s detector until a loaded runner failed it three times on main.
 *
 * So the helpers a suite IMPORTS are read as part of the suite, found by the convention for where fixtures live
 * (AGENTS.md: a package's `testing.ts`) rather than by a list of names, which a new helper obeys for free. Per
 * HELPER and not per module, because one fixture module holds both kinds: four route suites import `routesClient`
 * out of the same file as `tempWorkspace`, compose objects in memory, and would be renamed to say they reach for
 * a machine they never touch. Production modules are not followed at all: they reach the machine by definition,
 * and one import of the daemon would mark every suite in it. */
/* And a fixture is not always a file in the same package. A package publishes its own under the subpath the
 * convention gives it (`@intentic/iq-engine/testing`), and a sibling that imports it by that specifier reaches
 * exactly the same tmpdir tree and the same real git as a relative import would. Following only relative
 * specifiers therefore left a hole the shape of a package boundary: `_search/iq`'s CLI suites build a fixture
 * workspace and index it through `makeFixtureWorkspace`/`makeRecallFixture`, sat under the 5s detector, and
 * broke main from a loaded runner: the very failure the paragraph above records, one import style over.
 *
 * Resolved from the CHECKOUT, never through `node_modules`: this runs before `pnpm install` in the preflight
 * job and in the pre-push hook. Every workspace package's `exports` states an `@intentic/src` condition
 * pointing at the .ts source (it is what lets vitest read a sibling's source rather than its last build), so
 * the manifests already walked above are the whole resolver: shape again, not a list of packages. */
const SOURCE_CONDITION = "@intentic/src";
const byName = new Map(packages.map((entry) => [entry.pkg.name, entry]));
const workspaceSource = (specifier) => {
    const segments = specifier.split("/");
    // A scoped name is two segments and a bare one is one; whatever follows is the export subpath.
    const depth = specifier.startsWith("@") ? 2 : 1;
    const owner = byName.get(segments.slice(0, depth).join("/"));
    const subpath = segments.length > depth ? `./${segments.slice(depth).join("/")}` : ".";
    const entry = owner?.pkg.exports?.[subpath];
    const source = entry?.import?.[SOURCE_CONDITION] ?? entry?.[SOURCE_CONDITION];
    return source === undefined ? undefined : join(owner.dir, source);
};

const MACHINE_PRIMITIVES = /mkdtemp|node:child_process|simple-git|dockerode|testcontainers/;
const FIXTURE_MODULE = /(^|[.-])testing\.[cm]?tsx?$/;
const INTEGRATION_NAME = /\.(integration|e2e)\.(test|spec)\.[cm]?[jt]sx?$/;
const mocked = (source) => source.replace(/vi\.mock\([^)]*\)/g, "");

// Where an import lands in this checkout: a relative specifier by the filesystem, a workspace one by the
// manifest. The repo writes ESM (`./testing.js` for `testing.ts`), so the extension in a relative specifier is
// the one the compiler emits, not the one on disk.
const sourceOf = (file, specifier) => {
    if (!specifier.startsWith(".")) {
        return workspaceSource(specifier);
    }
    const path = join(dirname(file), specifier);
    return [path.replace(/\.[cm]?js$/, ".ts"), path.replace(/\.[cm]?js$/, ".tsx"), `${path}.ts`].find((candidate) => existsSync(candidate));
};

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
    // definition: holding them to this name would say nothing.
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

/* Invariant 3. The `importers:` region of pnpm-lock.yaml, as `importer -> block -> { name: specifier }`.
 *
 * A line scanner rather than a YAML parser because this has to run before `pnpm install`: see the header. The
 * indentation IS the grammar here (2/4/6/8), and each level's anchor makes the levels mutually exclusive, so a
 * line is read as exactly one of importer, block, entry, specifier or version. The `packages:` and `snapshots:`
 * regions below (far larger and far less regular) are read by invariant 11 alone, and by their own scanner. */
const unquote = (value) => (/^'.*'$/s.test(value) ? value.slice(1, -1).replaceAll("''", "'") : /^".*"$/s.test(value) ? value.slice(1, -1) : value);

const LEVELS = [
    { depth: 2, of: "importer" },
    { depth: 4, of: "block" },
    { depth: 6, of: "entry" },
];
const SPECIFIER = /^ {8}specifier:[ \t]*(.*?)[ \t]*$/;
// The line under it: what that specifier RESOLVED to, which is where invariant 11 starts walking.
const VERSION = /^ {8}version:[ \t]*(.*?)[ \t]*$/;

const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").split("\n");
const recorded = new Map();
const installed = [];
let inImporters = false;
let at, block, entry;
for (const line of lockfile) {
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
            // `recorded` that leaves is reported as drift by the size check, which a stack trace would not be.
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
    const version = VERSION.exec(line);
    if (version) {
        installed.push([entry, unquote(version[1])]);
    }
}

/* The catalogs, as `catalog name -> { dependency: version }`. A `catalog:` specifier in a package.json may be
 * recorded in the importer EITHER verbatim or already resolved through these: pnpm writes whichever form was
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
 * which is why `_site/astro-integrations` records an `astro` its package.json only ever declares as a peer.
 * Matching by name keeps every drift this exists to catch: a dependency added, removed, or re-specified
 * without an install, and drops a placement rule that would only ever produce false alarms.
 *
 * A peer is PERMITTED rather than required for the same reason from the other side: pnpm installs one only when
 * nothing else already satisfies it, so its absence from the lockfile says nothing, while a mismatch still does.
 * And it never SHADOWS a real declaration: a package that declares the same name both ways is recorded by the
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
    drift.push(`pnpm-lock.yaml has no readable "importers:" region: the lockfile format moved and this check needs rewriting`);
}
for (const { at: importer, dir } of recorded.size === 0 ? [] : importers) {
    const declared = declaredBy(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
    const blocks = recorded.get(importer);
    if (blocks === undefined) {
        // A package that installs nothing gets no importer: there is nothing for pnpm to have recorded.
        if (declared.size > 0) {
            drift.push(`${importer}: declares dependencies but has no importer in the lockfile, it has never been installed`);
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
        drift.push(`${importer}: an importer in the lockfile with no package.json, the package was removed without installing`);
    }
}

/* Invariant 4. Every job of a fork-triggerable workflow that reaches the self-hosted fleet is unreachable from
 * a fork's pull request. Read by SHAPE, like the other three: the safe set is grown to a fixpoint from the jobs
 * that guard themselves, so adding a job costs nothing as long as it descends from one. */
const GUARD = "head.repo.full_name == github.repository";
const PUSH_ONLY = "github.event_name == 'push'";
const WORKFLOWS = join(root, ".github/workflows");

/* Same line scanner as the lockfile check, and for a milder version of the same reason: a YAML parser is not a
 * dependency this script may take. Jobs sit at 2 spaces and their keys at 4, a block scalar (`if: |`) or a
 * block sequence (`needs:` over several lines) is folded back to one line, which is all either is read for. */
const jobsOf = (text) => {
    const lines = text.split("\n");
    const jobs = new Map();
    let job = null;
    for (let i = lines.findIndex((line) => /^jobs:\s*$/.test(line)) + 1; i < lines.length; i++) {
        const header = lines[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
        if (header) {
            jobs.set(header[1], (job = { name: header[1], if: "", needs: [], runsOn: "", uses: "" }));
            continue;
        }
        const field = job && lines[i].match(/^ {4}(if|needs|runs-on|uses):[ \t]*(.*?)\s*$/);
        if (!field) {
            continue;
        }
        let value = field[2];
        if (value === "" || value === "|" || value === ">") {
            for (value = ""; /^ {6,}\S/.test(lines[i + 1] ?? "");) {
                value += ` ${lines[++i].trim().replace(/^-\s*/, ",")}`;
            }
        }
        if (field[1] === "needs") {
            job.needs = value
                .replaceAll(/[[\]]/g, "")
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);
        } else {
            job[field[1] === "runs-on" ? "runsOn" : field[1]] = value;
        }
    }
    return jobs;
};

const exposed = [];
for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    // Only a workflow a fork can trigger at all. A `workflow_call` target runs under its caller's guard, and a
    // schedule or a dispatch carries no fork's code.
    if (!/^ {2}pull_request:\s*$/m.test(text)) {
        continue;
    }
    const jobs = jobsOf(text);
    const safe = new Set();
    for (let pass = 0; pass <= jobs.size; pass++) {
        for (const job of jobs.values()) {
            if (safe.has(job.name) || job.if.includes(GUARD) || job.if.includes(PUSH_ONLY)) {
                safe.add(job.name);
                continue;
            }
            const parents = job.needs.filter((name) => safe.has(name));
            // A skipped dependency skips the job: the rule that carries the two roots' guard across the DAG.
            // `always()` and `!cancelled()` opt out of exactly that rule, so a job using either has to read a
            // safe parent's own result or output to still notice the skip.
            if (parents.length > 0 && (!/always\(\)|!\s*cancelled\(\)/.test(job.if) || parents.some((name) => job.if.includes(`needs.${name}.`)))) {
                safe.add(job.name);
            }
        }
    }
    for (const job of jobs.values()) {
        if (!safe.has(job.name) && (/self-hosted/.test(job.runsOn) || job.uses !== "")) {
            exposed.push(
                `.github/workflows/${file}: job \`${job.name}\` runs a fork's pull request on the self-hosted fleet, ` +
                    `give it \`if: github.event_name != 'pull_request' || github.event.pull_request.${GUARD}\`, or a ` +
                    `\`needs\` edge to a job that has one`,
            );
        }
    }
}

/* Invariant 5. The release-body headings are ONE contract spelled in three files that share no dependency
 * edge: publish-github.sh writes "## Breaking changes" and "## What's new" into the Release, and the daemon's
 * update card (release-notes.ts) and the site's changelog page (changelog.ts) parse them back off it. Each
 * parser is deliberately its own copy: the files say why, so nothing but this check notices a drifted
 * spelling. And a drift fails NOTHING at runtime: the section simply stops being seen, which for the breaking
 * heading means a breaking update is offered as routine, the one silence the heading exists to prevent. */
const HEADINGS = ["What's new", "Breaking changes"];
const HEADING_FILES = ["_tools/scripts/publish-github.sh", "_sandbox/sandbox/src/platform/release-notes.ts", "_site/site/src/lib/changelog.ts"];
const headingDrift = [];
for (const file of HEADING_FILES) {
    const text = readFileSync(join(root, file), "utf8");
    for (const heading of HEADINGS.filter((spelling) => !text.includes(spelling))) {
        headingDrift.push(`${file}: no longer spells "${heading}", writer and both parsers must stay in step`);
    }
}

/* Invariant 6. A SHRUNK wire contract arrives declared. contract.lock.json is the sandbox-contract package's
 * exported schemas as one comparable document (its contract-lock.ts explains the pair); this check diffs the
 * committed lock against its merge-base and, when something that EXISTED is gone or different, insists some
 * commit in the range says so, a `type!:` subject or a `Breaking-Note:` trailer, the two spellings the
 * release pipeline majors and warns on. Additions pass in silence: every reader parses loosely, so growth
 * breaks nobody, and a gate that fired on every new field would train everyone to game it.
 *
 * Compared against merge-base rather than the worktree so it gates the PUSH (pre-push hook, PR preflight):
 * on main itself the merge-base IS HEAD and the check stands down, which is honest: by then the declaration
 * either landed or the moment for it has passed. No base, no lock at base, no git: stand down rather than
 * guess.
 *
 * A LINKED WORKTREE STANDS DOWN TOO. Every conversation runs in one (invariant 2), and a conversation is the
 * one place this gate can never be satisfied: landing carries work to the main tree as PATCHES, so a
 * declaring commit written on a conversation's branch never joins any range a push is checked on: the
 * five-sessions lesson at the remedy below. Firing here therefore blocked `pnpm test` on a commit that could
 * only ever be theater, and taxed every legitimate shrink one hand-typed empty commit per conversation. The
 * declaration is the landing draft's to write: git/contract-shrink.ts (in _sandbox/sandbox) detects the
 * shrink in the claim and agents/landed-subject.ts forces the `!` and the Breaking-Note into the message:
 * and the commit that draft becomes joins a range this gate still checks, at the pre-push hook and the CI
 * preflight, both of which run from a primary checkout. Recognized by shape: a checkout whose git dir is not
 * its common dir is a linked worktree. A git too old to answer the question reads as primary, which fails
 * toward checking. */
const LOCK_FILE = "_sandbox/sandbox-contract/contract.lock.json";
const undeclaredBreaks = [];
const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return result.status === 0 ? result.stdout : undefined;
};
/* The JSON Schema keywords whose value is a map of NAME to schema: inside one a key is a field the wire
 * carries, everywhere else a key is a keyword. The lock's own root is one too (its keys are the exported
 * schema names), which is why the walk starts `named`. It exists for the `description` rule below. */
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const shrunk = (base, head, at, out, named = true) => {
    /* Arrays are the schema's COLLECTIONS: `oneOf` alternatives, `enum` values, `required` names, and
     * contract-lock.ts keeps them in the order zod declared them rather than sorting, so a position means
     * nothing on its own. Compared as one blob they made growth look like a break: a union that gained a
     * member, an enum that gained a value, a variant that gained an OPTIONAL field each came back as
     * "CapabilitySchema.oneOf changed", which is the one thing this gate promised not to say. So every element
     * the base offered must still be matched by SOME element of the head, and extras pass in silence exactly
     * like a new property does. An element that merely changed reads as removed: the same verdict either way,
     * and `git diff` on the lock line says which. */
    if (Array.isArray(base) || Array.isArray(head)) {
        if (!Array.isArray(base) || !Array.isArray(head)) {
            out.push(at);
            return;
        }
        for (const [index, item] of base.entries()) {
            const itemAt = typeof item === "object" && item !== null ? `${at}[${index}]` : `${at} ${JSON.stringify(item)}`;
            const offered = head.some((candidate) => {
                const missing = [];
                shrunk(item, candidate, itemAt, missing, false);
                return missing.length === 0;
            });
            if (!offered) {
                out.push(`${itemAt} (removed)`);
            }
        }
        return;
    }
    if (typeof base !== "object" || base === null || typeof head !== "object" || head === null) {
        if (JSON.stringify(base) !== JSON.stringify(head)) {
            out.push(at);
        }
        return;
    }
    /* `description` AS A KEYWORD IS PROSE, AND PROSE IS NOT A PROMISE: skipped, so re-wording a help sentence
     * (or refreshing the example paths inside one) stops demanding a `!` commit for a change no client can
     * observe. Skipped ONLY as a keyword: 78 schemas in this lock carry a real field NAMED `description`, and
     * losing one of those is a genuine break, which is what `named` distinguishes. Kept in lockstep with
     * git/contract-shrink.ts in _sandbox/sandbox: the two copies are one judgment, and a change to either
     * owes the other a look. */
    for (const key of Object.keys(base)) {
        if (!named && key === "description") {
            continue;
        }
        if (key in head) {
            shrunk(base[key], head[key], `${at}.${key}`, out, !named && NAME_MAPS.has(key));
        } else {
            out.push(`${at}.${key} (removed)`);
        }
    }
};
const gitDir = git("rev-parse", "--absolute-git-dir")?.trim();
const gitCommonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
const conversation = gitDir !== undefined && gitCommonDir !== undefined && gitDir !== gitCommonDir;
if (!conversation && existsSync(join(root, LOCK_FILE))) {
    const head = git("rev-parse", "HEAD")?.trim();
    const mergeBase = (git("merge-base", "HEAD", "origin/main") ?? git("merge-base", "HEAD", "main"))?.trim();
    const baseLock = head !== undefined && mergeBase !== undefined && mergeBase !== head ? git("show", `${mergeBase}:${LOCK_FILE}`) : undefined;
    if (baseLock !== undefined) {
        const gone = [];
        shrunk(JSON.parse(baseLock), JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")), "", gone);
        const messages = git("log", "--format=%B", `${mergeBase}..HEAD`) ?? "";
        const declared = /^[a-z]+(\([^)]*\))?!:/m.test(messages) || /^Breaking-Note:/m.test(messages);
        if (gone.length > 0 && !declared) {
            /* The remedy, PASTEABLE, because five sessions in a row proved what happens without it: agents
             * asked to "fix the failing test" each wrote the declaring commit on their own conversation branch,
             * where landing (which applies patches, not commits) can never carry it to the range this check
             * reads. The declaration has to be a commit on THIS checkout, made by whoever is about to push:
             * so the check hands over the exact command and leaves only the sentence to write. (The landing
             * drafter now also declares detected shrinks by itself: _sandbox/sandbox/src/git/contract-shrink.ts
             *, so reaching this report at all means a commit slipped past that draft, or predates it.) */
            undeclaredBreaks.push(
                ...gone.slice(0, 10).map((path) => `${LOCK_FILE}: ${path.replace(/^\./, "")}`),
                ...(gone.length > 10 ? [`…and ${gone.length - 10} more`] : []),
                `something users could rely on was removed or changed: declare it, or make the change compatible`,
                `to declare it, run this ON THIS CHECKOUT (fill in the sentence) and re-run the push:`,
                `    git commit --allow-empty -m 'feat!: declare the wire-contract removals in this range' ` +
                    `-m 'Breaking-Note: <what stops working and what to do instead, one plain sentence>'`,
            );
        }
    }
}

/* Invariant 7. THE HOOKS ARE ARMED. A hook git cannot execute is a hook git SKIPS: with a hint, not an
 * error, and the push sails past every gate above, invariant 6 included. That is not hypothetical: the
 * checkout this was written against had a pre-push born 100644, healed to 100755 in the index on 2026-08-07,
 * and never once healed ON DISK: every later update reached its working tree as a patch, which keeps the mode
 * a file already has. prepass there said "undeclared shrink", the hook there said nothing, and an undeclared
 * contract break reached main.
 *
 * Asserted on disk rather than in the index because the disk is what git consults at push time, and asserted
 * here because this runs on the machine about to push: a fresh CI checkout re-applies the tracked bit and
 * passes untouched.
 *
 * RE-ARMED, NOT REFUSED, and this is the one invariant here that repairs rather than reports. The other eleven
 * describe the tree that is about to be pushed: prepass cannot know what the author meant, so it says no and
 * stops. This one describes a bit on the pusher's own disk that carries no intent whatsoever, and the fix is a
 * chmod this process is already entitled to make. Failing was strictly worse on both ends: `pnpm test` died
 * over a mode that has nothing to do with any test, and the hook stayed disarmed until somebody read the
 * message and ran a full install. A mode-only flip in the index is invisible to every existing working tree
 * FOREVER (git rewrites contents, never modes), so the install-time repair alone never reaches a clone that
 * does not reinstall. Now every prepass arms the hook for the next push, which is the outcome the invariant
 * was ever asking for. Still reported when the chmod itself fails: a hook nobody can arm is the real finding.
 * Windows has no executable bit and never runs these hooks through one, so it has nothing to assert. */
const disarmed = [];
const rearmed = [];
const hooksDir = join(root, ".githooks");
if (process.platform !== "win32" && existsSync(hooksDir)) {
    for (const hook of readdirSync(hooksDir)) {
        const path = join(hooksDir, hook);
        if ((statSync(path).mode & 0o111) !== 0) {
            continue;
        }
        try {
            chmodSync(path, 0o755);
            rearmed.push(hook);
        } catch (error) {
            disarmed.push(
                `.githooks/${hook} is not executable and could not be made executable (${error.message}): git skips it with a hint and the push bypasses every gate in this file`,
            );
        }
    }
}

/* Invariant 8. A CALLED WORKFLOW STAYS INSIDE ITS CALLER'S CEILING. A reusable workflow can never hold more
 * than the calling job grants, and Actions decides that BEFORE the run starts: a job in the callee naming a
 * permission the caller's list omits is an invalid-workflow error, which fails the pipeline as a
 * `startup_failure`: no job, no log, and a message that names neither file. ci.yml's release call carries a
 * comment saying exactly this. The comment did not stop `actions: write` from landing in release.yml's publish
 * job alone, and main went red on a pipeline that never started a job, with nothing to read but the diff.
 *
 * Line-scanned like invariant 4, for the same reason. `permissions:` sits at column 0 (the workflow's own,
 * inherited by every job that names none) or column 4 (one job's, replacing it outright: a scope the block
 * omits is `none`, not inherited). A workflow declaring neither leaves the ceiling to the repository default,
 * which is not a fact in this checkout, so those are skipped rather than guessed at. */
const RANK = { none: 0, read: 1, write: 2 };
// What the shorthands (`permissions: read-all`) set every scope to at once.
const SHORTHAND = { read: "read", write: "write", "read-all": "read", "write-all": "write", "{}": "none" };
const SCOPES = [
    "actions",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
];

// The `permissions:` blocks of one workflow, keyed by the job that owns each, "" for the workflow's own.
const permissionsOf = (text) => {
    const lines = text.split("\n");
    const blocks = new Map();
    let job = "";
    let inJobs = false;
    for (let i = 0; i < lines.length; i++) {
        inJobs ||= /^jobs:\s*$/.test(lines[i]);
        const header = inJobs && lines[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
        if (header) {
            job = header[1];
            continue;
        }
        const declared = lines[i].match(/^( *)permissions:[ \t]*(.*?)\s*$/);
        if (!declared || (declared[1].length !== 0 && declared[1].length !== 4)) {
            continue;
        }
        const owner = declared[1].length === 0 ? "" : job;
        if (declared[2] !== "") {
            blocks.set(owner, Object.fromEntries(SCOPES.map((scope) => [scope, SHORTHAND[declared[2]] ?? "none"])));
            continue;
        }
        // The scopes under the key, to the first line that is not indented past it. A comment among them is a
        // line to step over, not a scope: several of these blocks explain themselves scope by scope.
        const scopes = {};
        const under = new RegExp(`^ {${declared[1].length + 2},}(?:#|([a-z-]+):[ \\t]*(\\S+))`);
        for (let scope; (scope = (lines[i + 1] ?? "").match(under)); i++) {
            if (scope[1]) {
                scopes[scope[1]] = scope[2];
            }
        }
        blocks.set(owner, scopes);
    }
    return blocks;
};

const overreach = [];
for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    const callerBlocks = permissionsOf(text);
    for (const job of jobsOf(text).values()) {
        const call = job.uses.match(/^\.\/(\.github\/workflows\/[\w.-]+\.yml)$/);
        const granted = callerBlocks.get(job.name) ?? callerBlocks.get("");
        if (!call || !granted) {
            continue;
        }
        const calledText = readFileSync(join(root, call[1]), "utf8");
        const calledBlocks = permissionsOf(calledText);
        for (const called of jobsOf(calledText).values()) {
            const wanted = calledBlocks.get(called.name) ?? calledBlocks.get("") ?? {};
            for (const [scope, level] of Object.entries(wanted)) {
                const held = granted[scope] ?? "none";
                if ((RANK[level] ?? 0) > (RANK[held] ?? 0)) {
                    overreach.push(
                        `${call[1]}: job \`${called.name}\` asks for \`${scope}: ${level}\`, but .github/workflows/${file} job ` +
                            `\`${job.name}\` grants it \`${scope}: ${held}\`, add \`${scope}: ${level}\` to that call's \`permissions\``,
                    );
                }
            }
        }
    }
}

/* Invariant 9. A JOB THAT PUBLISHES WITH PROVENANCE RUNS ON A GITHUB-HOSTED RUNNER. npm builds the
 * attestation's builder id out of the runner's own environment: `https://github.com/actions/runner/
 * $RUNNER_ENVIRONMENT` (libnpmpublish/lib/provenance.js), and npm's registry reads it back and accepts only
 * "github-hosted". The fleet is `self-hosted`, so from it every publish packs the tarball, signs the bundle,
 * writes it to the public transparency log, and THEN 422s on the PUT. v1.208.0 died exactly there, one package
 * into 29, after a full install and build: nothing before the last call of the last step said a word.
 *
 * The two halves of that mistake sit in different files and neither is wrong alone: `--provenance` lives in
 * the publish script, `runs-on` in the workflow, which is the shape a check here is for. The flag is found by
 * following the job's steps into the repository scripts they run, so the pairing is read rather than listed;
 * publish-npm.sh now also asserts it at runtime, but that assertion fires in the release, and this one fires
 * in the commit that would break it. */
const PROVENANCE = /npm publish[^\n]*--provenance/;

// The step block of each job of one workflow, keyed by job: the same line scanner as invariants 4 and 8, and
// everything below a job's header until the next one is that job's.
const stepsOf = (text) => {
    const lines = text.split("\n");
    const blocks = new Map();
    let job = null;
    for (let i = lines.findIndex((line) => /^jobs:\s*$/.test(line)) + 1; i < lines.length; i++) {
        const header = lines[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
        if (header) {
            blocks.set((job = header[1]), []);
        } else if (job !== null) {
            blocks.get(job).push(lines[i]);
        }
    }
    return new Map([...blocks].map(([name, block]) => [name, block.join("\n")]));
};

const unattestable = [];
for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    const steps = stepsOf(text);
    for (const job of jobsOf(text).values()) {
        if (!/self-hosted/.test(job.runsOn)) {
            continue;
        }
        const block = steps.get(job.name) ?? "";
        // A step rarely spells the publish itself: it names a script, and the script spells the flag. One hop
        // into the shell scripts is enough for every publish path in this repository, and a hop that lands
        // nowhere reads as no flag. Shell only: every publish here is a `.sh`, and following the `.mjs` a job
        // runs would make this file, which has to write the pattern down to look for it: match itself.
        const scripts = [...block.matchAll(/_tools\/scripts\/[\w.-]+\.sh/g)].map(([path]) => path);
        const spelled = [block, ...scripts.filter((path) => existsSync(join(root, path))).map((path) => readFileSync(join(root, path), "utf8"))];
        if (spelled.some((where) => PROVENANCE.test(where))) {
            unattestable.push(
                `.github/workflows/${file}: job \`${job.name}\` publishes with provenance on the self-hosted fleet, npm's ` +
                    `registry rejects an attestation whose builder id is not "github-hosted", with a 422 the release only ` +
                    `reaches after the tarball is packed and signed; run this job on \`ubuntu-24.04\``,
            );
        }
    }
}

/* Invariant 10. NO WORKFLOW WAITS ON A TAG PUSH IT CAN NEVER SEE. semantic-release pushes this repository's
 * `v*` tags with the built-in GITHUB_TOKEN, and GitHub deliberately starts NO workflow from an event that
 * token created, the loop guard that stops a workflow triggering itself forever. `on: push: tags` here is
 * therefore not a trigger that fires late or rarely; it is one that cannot fire at all, and a workflow behind
 * it is dead code that reads exactly like a pipeline with nothing to do. Every release goes green and the
 * artifact is simply never published.
 *
 * MORE THAN ONE FILE HAS MADE THIS MISTAKE, and the last one is why this check exists. npm-publish.yml fell
 * ~30 versions behind the tags; action-publish.yml was written AFTER it was fixed, copied its shape, claimed
 * its trigger in its own header: "the same trigger and shape as npm-publish.yml", and kept the broken one,
 * so the Marketplace action was built by a workflow that could not run and was never published once. Reading
 * the diff caught neither, because the wrong line looks exactly like the right one and the comment above it
 * agreed.
 *
 * workflow_dispatch is the documented exception to the loop guard, so the remedy is always the same and this
 * check names it: dispatch the workflow from dispatch-publish.sh, at the tag.
 *
 * WHEN THIS INVARIANT SHOULD BE DELETED: if the release ever pushes its tag with a GitHub App installation
 * token or a PAT instead of GITHUB_TOKEN, the loop guard stops applying and `on: push: tags` becomes the
 * simpler correct answer for every publish workflow. Delete this block together with that change: leaving it
 * would forbid the very thing that fixed it.
 *
 * Line-scanned like invariants 4, 8 and 9, and for the same reason: `on:` sits at column 0, its events at 2,
 * an event's own keys at 4. */
const tagTriggered = [];
for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const lines = readFileSync(join(WORKFLOWS, file), "utf8").split("\n");
    const on = lines.findIndex((line) => /^on:\s*$/.test(line));
    if (on === -1) {
        continue;
    }
    // From `on:` to the next line that starts a top-level key. A blank line is inside the block; anything
    // unindented ends it, comments at column 0 included: those sit between blocks here, never within one.
    let inPush = false;
    for (let i = on + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
        if (/^ {2}\S/.test(lines[i])) {
            inPush = /^ {2}push:\s*$/.test(lines[i]);
        } else if (inPush && /^ {4}tags:/.test(lines[i])) {
            tagTriggered.push(
                `.github/workflows/${file}: \`on: push: tags\` is a trigger this repository can never fire, semantic-release ` +
                    `pushes its tags with GITHUB_TOKEN, and GitHub starts no workflow from that token's events. Use ` +
                    `\`on: workflow_dispatch\` and add this file to WORKFLOWS in _tools/scripts/dispatch-publish.sh, which ` +
                    `dispatches it AT THE TAG so the checkout and \`GITHUB_REF_NAME\` are what a tag push would have given it`,
            );
        }
    }
}

/* Invariant 11. EVERY PACKAGE THE LOCKFILE CARRIES IS REACHABLE FROM AN IMPORTER.
 *
 * pnpm rewrites `importers:` on every install and prunes the two regions below it only when it RESOLVES. A
 * `--frozen-lockfile` install compares importers against the manifests and touches nothing else; so does
 * `--lockfile-only`, and so does `--force`. Delete a package from the workspace, commit the lockfile the
 * shortcut hands back, and its whole subtree stays in the file: installed, and still owed a decision in
 * `allowBuilds` for any build script inside it.
 *
 * That is what took five jobs down at once. Removing the VSCode extension dropped `@vscode/vsce-sign` from
 * `allowBuilds` while `ovsx -> @vscode/vsce -> @vscode/vsce-sign` stayed in the lockfile, and every job died on
 * ERR_PNPM_IGNORED_BUILDS in `pnpm install` (the first step of all of them) before it ran a single check. The
 * author's own tree was green: the package was gone from every manifest, so nothing local ever said otherwise.
 * `pnpm install` (a real resolution, no flags) is what prunes, and this is what says it was skipped.
 *
 * Reachability, not a name match, because the subtree is the point: 169 entries went dead behind those three,
 * and only the graph knows which. Roots are the `version:` lines invariant 3's scanner collects; edges are the
 * `dependencies:`/`optionalDependencies:` of `snapshots:`, whose values are versions of the key beside them:
 * except when they name a package outright, which is how pnpm writes an alias (`'@openai/codex-linux-x64':
 * '@openai/codex@0.147.0-linux-x64'`). A leading digit is the whole difference, and `file:` (an injected
 * workspace package, which does get an entry) parts company with `link:` (a symlinked one, which does not). */
const idOf = (name, value) => (value.startsWith("link:") ? undefined : value.startsWith("file:") || /^\d/.test(value) ? `${name}@${value}` : value);

const edges = new Map();
let inSnapshots = false;
let snapshot, group;
for (const line of lockfile) {
    if (/^\S/.test(line)) {
        inSnapshots = line.startsWith("snapshots:");
        continue;
    }
    if (!inSnapshots || !line.trim()) {
        continue;
    }
    // 2 spaces is a package id, 4 a dependency group, 6 an edge: the same grammar, one region down.
    const id = /^ {2}(\S.*?):(?: \{\})?[ \t]*$/.exec(line);
    if (id) {
        snapshot = unquote(id[1]);
        edges.set(snapshot, []);
        continue;
    }
    if (/^ {4}\S/.test(line)) {
        group = line.trim().replace(/:$/, "");
        continue;
    }
    const edge = group === "dependencies" || group === "optionalDependencies" ? /^ {6}(\S.*?):[ \t]*(.*?)[ \t]*$/.exec(line) : null;
    const to = edge && idOf(unquote(edge[1]), unquote(edge[2]));
    if (to) {
        edges.get(snapshot)?.push(to);
    }
}

const reached = new Set();
for (const pending = installed.map(([name, version]) => idOf(name, version)).filter(Boolean); pending.length > 0;) {
    const id = pending.pop();
    if (reached.has(id)) {
        continue;
    }
    reached.add(id);
    pending.push(...(edges.get(id) ?? []).filter((to) => !reached.has(to)));
}

const stranded = [];
if (edges.size === 0) {
    stranded.push(`pnpm-lock.yaml has no readable "snapshots:" region: the lockfile format moved and this check needs rewriting`);
}
// An id reached but absent from `snapshots:` means the walk read an edge it should not have, and every orphan
// this run reports is then suspect. Said as its own line rather than folded in, because the fix is different.
for (const id of reached) {
    if (!edges.has(id)) {
        stranded.push(`${id} is depended on by something in "snapshots:" but has no entry of its own: this check misread the lockfile`);
    }
}
if (stranded.length === 0) {
    for (const id of edges.keys()) {
        if (!reached.has(id)) {
            stranded.push(id);
        }
    }
}

/* 13. BUDGETS: no package inherits vitest's 5s ceiling by accident.
 *
 * That default is a HANG DETECTOR, right for a test that composes objects in memory and nonsense for one that
 * indexes a workspace, clones a repo or boots a container — @intentic/testing/vitest is the long version, and
 * UNIT_SUITE / INTEGRATION_SUITE are the two ceilings it draws from the file name.
 *
 * THE BUDGETS WERE ALREADY RIGHT; ADOPTION WAS NOT, and this invariant is about the second one. The shared
 * pair had reached 21 of 52 configs, and eleven packages ran `vitest run` with no config at all. The rest sat
 * on the bare default with nothing said, which is how the same failure kept arriving under new names: a suite
 * green on a developer's box and red on a runner with every core busy, repaired with its own private constant,
 * after it had already broken main. `_tools/testing/src/vitest.ts` names six of those by hand; `_search/iq`
 * and `_editor/web` were the seventh and eighth, in one pipeline, the day this was written
 * (docs/ci-failure-audit.md, class E). Two of the config-less packages were running `*.integration.test.ts`
 * files — real git, real subprocesses — under the 5s detector, and had simply not lost the race yet.
 *
 * EITHER SUITE, OR A NUMBER SAID OUT LOUD. `_editor/web` states `testTimeout: 20_000` with forty lines of
 * measurement behind it, and that is a better answer than the shared pair for that package; the thing being
 * refused is neither. A package that names no ceiling is not choosing the default, it is unaware of it.
 *
 * MATCHED ON THE SUITE NAMES rather than the import specifier, because `_tools/testing` imports them from its
 * own source — it is the package. Text, not evaluation: this runs before `pnpm install`, in front of the CI
 * preflight job and the pre-push hook, where node_modules may not exist. */
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
    if (!/\bUNIT_SUITE\b|\bINTEGRATION_SUITE\b/.test(source) && !/\btestTimeout\b/.test(source)) {
        budgetless.push(
            `${name}: ${VITEST_CONFIG} spreads neither UNIT_SUITE nor INTEGRATION_SUITE and sets no testTimeout, ` +
                `so its suites inherit the 5s hang detector silently. Use the shared pair, or state the ceiling ` +
                `this package needs and why (see _editor/web/vitest.config.ts).`,
        );
    }
}

// Every report before any exit, so one run says everything that is wrong rather than the first thing.
const reports = [
    ["Test files outside the program or the budget they belong in", problems],
    ["A package's tests run on vitest's default 5s ceiling without saying so", budgetless],
    ["pnpm-lock.yaml is out of date: run `pnpm install` and commit it (this is CI's ERR_PNPM_OUTDATED_LOCKFILE)", drift],
    ["Self-hosted CI is reachable from a fork's pull request (docs/ci-runner.md, 'The fork boundary')", exposed],
    ["The release-body headings drifted apart (they are parsed, not prose)", headingDrift],
    ["The wire contract shrank without a declared breaking change", undeclaredBreaks],
    ["Git hooks are disarmed on this checkout, so pushes skip these gates entirely", disarmed],
    ["A called workflow asks for more than its caller grants: Actions fails this before any job starts", overreach],
    ["A publish with provenance is on a runner npm's registry will not attest", unattestable],
    ["A workflow is triggered by a tag push GitHub will never deliver (dispatch it instead)", tagTriggered],
    [
        "pnpm-lock.yaml still carries packages nothing depends on: run `pnpm install` (a real resolution prunes them) and " +
            "commit it. They are installed on every runner, and each build script inside them is one CI demands a decision " +
            "for in `allowBuilds`",
        stranded,
    ],
];
if (reports.some(([, lines]) => lines.length > 0)) {
    for (const [heading, lines] of reports.filter(([, some]) => some.length > 0)) {
        console.error(`${heading}:\n${lines.map((line) => `  - ${line}`).join("\n")}`);
    }
    process.exit(1);
}
console.log(`typecheck coverage: every package with tests type-checks them, and every machine-touching suite is named as one`);
console.log(`test budgets: every package running vitest names its ceiling instead of inheriting the 5s hang detector`);
console.log(`lockfile: ${importers.length} importers record the specifiers their package.json declares`);
console.log(`fork boundary: no self-hosted job is reachable from a fork's pull request`);
console.log(`release headings: writer and both parsers spell the same two sections`);
console.log(
    `wire contract: ${conversation ? "conversation worktree, the landing draft declares any shrink, and the push re-runs this gate from the primary checkout" : "nothing shrank undeclared against merge-base"}`,
);
console.log(
    rearmed.length > 0
        ? `git hooks: re-armed ${rearmed.join(", ")} (checked out without the executable bit, so git was skipping ${rearmed.length === 1 ? "it" : "them"}), and now every .githooks file runs`
        : `git hooks: every .githooks file is executable, so the pre-push gate actually runs`,
);
console.log(`workflow permissions: every reusable-workflow call grants what the workflow it calls asks for`);
console.log(`npm provenance: no job publishes an attested tarball from the self-hosted fleet`);
console.log(`publish triggers: no workflow waits on a tag push GITHUB_TOKEN can never deliver`);
console.log(`lockfile reachability: all ${edges.size} packages in the lockfile are depended on by something`);

const checksOnly = process.argv.includes("--checks-only");

/* 12. TEMPLATES: every .vue template in the repository parses and compiles.
 *
 * NOTHING ELSE READS THEM. `vue-tsc --noEmit` over a component whose template cannot be parsed at all exits 0
 * with no output: it type-checks the script and gives up on the rest in silence. oxlint does not read a
 * template either, and an extension is consumed as SOURCE by the web app, so its own `build` never compiles
 * one. That leaves exactly one reader in the whole pipeline: the app bundle.
 *
 * Which is where it surfaced. A sweep that straightened the typographic quotes through
 * `_extensions/knowledge` rewrote one title binding as `:title="`No note for "${x}" yet`"`, where the inner
 * `"` is what HTML reads as the end of the attribute — leaving the compiler an unterminated template literal
 * and the rest of the tag as attribute names. Every typecheck passed it, in all three verify groups, and all
 * three then died on `@intentic-app/web#build` 5,145 modules in. One character, three red groups, and the
 * cheapest reader of that line was the last thing to look at it.
 *
 * THE REAL COMPILER, not a scanner for quotes in attributes: the guard is only worth having if it fails on
 * exactly what the bundler fails on, and the way an approximation goes wrong is by staying green on the next
 * shape nobody thought of. It costs ~0.8s for ~400 templates, which is why it can sit here in front of the
 * type check rather than at the end of a build.
 *
 * IT RUNS UNDER `--checks-only` TOO, WHEN IT CAN, which is the one thing about its placement that changed.
 * The compiler comes from node_modules, so this used to sit below that line and the pre-push hook never
 * reached it — the gate that exists because of a five-hour outage was absent from the last thing standing
 * between the outage and main. A push happens from a working clone, where node_modules is present and ~0.8s
 * is nothing; the CI preflight job runs before its install, where it is not, and the three verify groups
 * compile every template minutes later regardless. So: attempt it, and when the compiler cannot be resolved,
 * SAY THAT and carry on rather than failing a check for a tool that was never promised.
 *
 * Resolved through the first workspace package that declares `vue` rather than a root devDependency — every
 * package with a template already depends on it, discovery beats another entry to keep in step, and the root's
 * manifest carries tooling, not the app's runtime. */
// From the root rather than per package: `_tools/extension-example/seed` is the tree `intentic extension
// create` copies onto someone else's machine, it belongs to no workspace package, and a template that cannot
// compile is no better there.
const templates = walk(root, VUE_FILE);
const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const uncompilable = [];
// Absent only before an install: `vue` is a real dependency of every package that renders one, so a resolution
// failure here means node_modules, not a missing declaration. That is the checks-only case, and it is not an
// error — see the paragraph above.
const compiler = (() => {
    if (templates.length === 0 || vueHost === undefined) {
        return undefined;
    }
    try {
        return createRequire(join(vueHost.dir, "package.json"))("vue/compiler-sfc");
    } catch {
        return undefined;
    }
})();
if (templates.length > 0 && vueHost === undefined) {
    // Unreachable while any package renders one: a template is compiled by the `vue` its package depends on.
    uncompilable.push(`${templates.length} templates, and no package declares vue: nothing here can compile them`);
}
if (compiler !== undefined) {
    const { parse: parseSfc, compileTemplate } = compiler;
    for (const file of templates) {
        const relative = file.slice(root.length + 1);
        // A CompilerError carries `loc`; a plain SyntaxError out of a script block does not, and both arrive here.
        const reported = (error, offset) =>
            `${relative}${error.loc === undefined ? "" : `:${error.loc.start.line + offset}:${error.loc.start.column}`}: ${error.message}`;
        const { descriptor, errors } = parseSfc(readFileSync(file, "utf8"), { filename: file });
        uncompilable.push(...errors.map((error) => reported(error, 0)));
        if (errors.length > 0 || descriptor.template === null) {
            continue;
        }
        // A template error is located within the block, so the block's own first line is what turns it into a
        // line of the file — the same offset @vitejs/plugin-vue applies when the bundler reports one.
        const offset = descriptor.template.loc.start.line - 1;
        const compiled = compileTemplate({ source: descriptor.template.content, filename: file, id: relative });
        uncompilable.push(...compiled.errors.map((error) => (typeof error === "string" ? `${relative}: ${error}` : reported(error, offset))));
    }
}
if (uncompilable.length > 0) {
    console.error(
        `A .vue template does not compile, so the web build cannot bundle it (no type check reads templates, ` +
            `which is why this says so here):\n${uncompilable.map((line) => `  - ${line}`).join("\n")}`,
    );
    process.exit(1);
}
console.log(
    compiler === undefined
        ? `vue templates: ${templates.length} not compiled (vue/compiler-sfc needs node_modules, and this ran before the install) — the verify jobs read them`
        : `vue templates: all ${templates.length} parse and compile, so the bundler has nothing left to discover`,
);

/* Everything below GENERATES into the tree and needs node_modules for more than one optional read; everything
 * above touches nothing but the executable bit invariant 7 re-arms. `--checks-only` is that line: it is what
 * the pre-push hook and the CI preflight job run. */
if (checksOnly) {
    process.exit(0);
}

/* A package needs building exactly when its `exports` hand a dependent a MODULE out of `dist/`: that `.js` is
 * what a dependent's compiler reads (through the `.d.ts` beside it), so a stale or absent dist there is a
 * phantom error in somebody else's package. The ones that export `./src/...` (the Vue libraries) are already
 * the source of truth and have nothing to emit.
 *
 * The module part is the whole test, not merely `dist/` appearing somewhere in `exports`. `_editor/share-view`
 * exports `./page` as `./dist/index.html`: a page Vite builds, resolved at runtime by `import.meta.resolve` to
 * find the asset directory, and read by no compiler anywhere. Matching on the directory alone put it in this
 * set, where `tsgo`, which has no Vue SFC support, that being what the package's own `vue-tsc` typecheck is
 * for: reported four TS2307s for imports that resolve perfectly well, and the whole gate died before a single
 * test ran. A built artifact that is not a module belongs to `build`, not here.
 *
 * `tsgo -b` orders the set itself from the project references, and is incremental: a no-op pass is ~1s. */
/* AND ONE PACKAGE IS EXEMPT, for the same Vue-SFC reason spelled out above, arriving from the other direction.
 * `@intentic/extension-ui` has no `.vue` file of its own: it is a curated re-export of `@intentic/ui`, which is
 * nothing but a component graph, so `tsgo -b` walks straight into it and reports a TS2307 for every one, on a
 * package whose own `vue-tsc` typecheck is clean. Its declarations are built by its own `build` script (which
 * runs vue-tsc, then narrows the result to the slice it re-exports), and NOTHING in this repo reads them: every
 * in-repo consumer resolves the `@intentic/src` condition to source, and the dist exists for the npm consumers
 * that are the whole point of publishing it. So there is nothing here for this pass to do, and attempting it
 * kills the gate before a test runs. */
const BUILT_BY_VUE_TSC = new Set(["_editor/extension-ui"]);
const needsDeclarations = packages.filter(
    ({ name, pkg }) => !BUILT_BY_VUE_TSC.has(name) && /"\.\/dist\/[^"]+\.js"/.test(JSON.stringify(pkg.exports ?? "")),
);

/* A package whose sources are themselves GENERATED has nothing for `tsgo -b` to read until its generator has
 * run: `_platform/prisma` is one re-export of `./generated/client.js`, which `prisma generate` writes and git
 * ignores. turbo used to cover this by way of `^build` (the package's `build` runs the generator first); this
 * prepass replaced `^build`, and on a fresh checkout it therefore reported the generated module as missing:
 * one TS2307 in the prepass, then `@intentic-app/prisma` unresolvable in every dependent, ~20 errors deep in
 * api and e2e that named nothing about the real cause. Recognized by shape (a `generate` script), not by name,
 * and run through a shell with the package's own `.bin` on PATH rather than through pnpm: pnpm's
 * `syncInjectedDepsAfterScripts` hardlinks into `node_modules` afterwards and dies EXDEV in an agent worktree,
 * which is the very thing this script exists to keep out of the path. Generation is unconditional: it is
 * ~0.8s, and a conditional pass would have to model each generator's inputs to know when it is stale.
 *
 * Generation can also change the set of files matched by the project's `include`. Native TypeScript's
 * incremental build otherwise reuses the old root list from `.tsbuildinfo`: it can resolve a newly generated
 * module through a checked-in entry point while still saying that module is not in the composite project's
 * file list (TS6307). `--clean` asks the compiler where that package keeps its own outputs and build info, so
 * the rule stays independent of a package's `.cache`/`dist` conventions; the ordinary build below remains
 * incremental for every package whose sources were not just replaced. */
const generated = needsDeclarations.filter(({ pkg }) => pkg.scripts?.generate !== undefined);
for (const { name, dir, pkg } of generated) {
    console.log(`generating: ${name}`);
    const bin = [join(dir, "node_modules/.bin"), join(root, "node_modules/.bin"), process.env.PATH].join(":");
    const generate = spawnSync(pkg.scripts.generate, { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, PATH: bin } });
    if (generate.status !== 0) {
        process.exit(generate.status ?? 1);
    }
}

const tsgo = join(root, "node_modules/.bin/tsgo");
if (generated.length > 0) {
    const clean = spawnSync(tsgo, ["-b", "--clean", ...generated.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
    if (clean.status !== 0) {
        process.exit(clean.status ?? 1);
    }
}

console.log(`declarations: building ${needsDeclarations.length} packages that dependents read from dist`);
const build = spawnSync(tsgo, ["-b", ...needsDeclarations.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}
