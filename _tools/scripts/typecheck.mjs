#!/usr/bin/env node
/* The type check, made runnable everywhere the code is written.
 *
 * `pnpm typecheck` runs this and then `turbo run typecheck`. Two invariants live here, and both exist because
 * the check that catches fixture drift used to run in exactly one place — CI, on main, after the merge.
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
 * 2. DECLARATIONS — every package a type check reads has current `.d.ts` before the check runs.
 *
 * turbo modelled this as `typecheck: dependsOn ["^build"]`, which is correct and unrunnable outside CI: `build`
 * goes through pnpm, pnpm's `syncInjectedDepsAfterScripts` hardlinks into `node_modules` after it, and in an
 * agent worktree `node_modules` is a different filesystem — so the compile succeeds and the run dies EXDEV
 * (exit 238). EVERY agent runs in a worktree. The gate therefore ran nowhere that anyone could act on it
 * before landing, and main spent 1h48m red across ten landed commits with nobody able to see it locally.
 *
 * `tsgo -b` writes the same declarations without pnpm in the path, so it works in a worktree and in CI alike.
 * That is the whole fix: same command, same result, both places.
 *
 * Skipping the prepass is worse than not checking at all. Run against the dist a worktree inherits — built
 * from whatever the main checkout last compiled — `_apps/sandbox` reported 19 errors, of which 16 were stale
 * declarations and 3 were real. Output like that is what teaches everyone to read a red type check as
 * "baseline failures" and land anyway.
 *
 * Both invariants are recognized by SHAPE rather than listed, because a list repeats the miss the first time
 * somebody adds the 43rd package (AGENTS.md — "guard invariants by discovery, not enumeration"). The
 * hand-written `tsconfig.libs.json` is the proof: it names 13 of the 23 packages that need building, and the
 * one it happens to omit — `@intentic/constants` — was on its own worth 3 phantom errors in the daemon.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const problems = [];
for (const { name, dir, pkg } of packages) {
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

if (problems.length > 0) {
    console.error(`Test files outside every type-check program:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
    process.exit(1);
}
console.log(`typecheck coverage: every package with tests type-checks them`);

/* A package needs building exactly when its `exports` resolve into `dist/`: that is the path a DEPENDENT's
 * compiler reads, so a stale or absent dist there is a phantom error in somebody else's package. The ones that
 * export `./src/...` (the Vue libraries) are already the source of truth and have nothing to emit.
 * `tsgo -b` orders the set itself from the project references, and is incremental — a no-op pass is ~1s. */
const needsDeclarations = packages.filter(({ pkg }) => /\.\/dist\//.test(JSON.stringify(pkg.exports ?? "")));
console.log(`declarations: building ${needsDeclarations.length} packages that dependents read from dist`);
const build = spawnSync(join(root, "node_modules/.bin/tsgo"), ["-b", ...needsDeclarations.map(({ name }) => name)], { cwd: root, stdio: "inherit" });
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}
