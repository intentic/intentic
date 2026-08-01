#!/usr/bin/env node
/* Every test file in this monorepo must sit inside some type-check program.
 *
 * THE MISS THIS EXISTS TO PREVENT. A package that emits to dist excludes `*.test.ts` from its build config, so
 * the test code stays out of the published tree. That exclusion is correct and also took the tests out of the
 * only type check the repo ran: 458 type errors had accumulated in them unseen, and the shape of those errors
 * was almost always the same — a hand-built fake that no longer matched the seam it stood in for. A daemon fake
 * was missing FOURTEEN required members of Services and still compiled, because spreading a `Partial<T>` into a
 * `T`-annotated literal tells the compiler every key might be supplied. Nothing said a word until some unrelated
 * route reached one of them and a hundred tests failed at once with "Internal server error".
 *
 * A hardcoded list of packages would repeat that miss the first time somebody adds the 43rd one, so this
 * recognizes the violation by its SHAPE: find the packages that have test files, and check each one's
 * type-check program actually admits them (AGENTS.md — "guard invariants by discovery, not enumeration").
 *
 * Run by `pnpm typecheck` and by CI, ahead of the turbo task it protects.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACES = ["_apps", "_libs", "_extensions", "_tools"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "generated", ".git"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

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
for (const workspace of WORKSPACES) {
    for (const name of readdirSync(join(root, workspace))) {
        const pkgDir = join(root, workspace, name);
        const manifest = join(pkgDir, "package.json");
        if (!existsSync(manifest)) {
            continue;
        }
        const tests = walk(pkgDir);
        if (tests.length === 0) {
            continue;
        }
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        const typecheck = pkg.scripts?.typecheck;
        if (typecheck === undefined) {
            problems.push(`${workspace}/${name}: has ${tests.length} test file(s) but no "typecheck" script — turbo skips it silently`);
            continue;
        }
        const config = join(pkgDir, configFor(typecheck));
        if (!existsSync(config)) {
            problems.push(`${workspace}/${name}: "typecheck" compiles ${configFor(typecheck)}, which does not exist`);
            continue;
        }
        const excluded = excludesOf(config).filter((pattern) => TEST_FILE.test(pattern.replace(/\*/g, "x")));
        if (excluded.length > 0) {
            problems.push(
                `${workspace}/${name}: ${configFor(typecheck)} excludes ${excluded.join(", ")} — its tests are in no type-check program. ` +
                    `Point "typecheck" at a tsconfig.test.json that re-includes them (see any emitting package).`,
            );
        }
    }
}

if (problems.length > 0) {
    console.error(`Test files outside every type-check program:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
    process.exit(1);
}
console.log("typecheck coverage: every package with tests type-checks them");
