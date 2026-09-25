// What `pnpm verify:turn` measures of a branch, sized to the change rather than to the repository.
//
// TYPECHECK the packages the change reaches: the ones holding a changed file and every package that depends on one,
// since a type is how a change breaks a consumer it never ran. An asset-only package (a built page, a stylesheet) stops
// that walk (workspace-graph.mjs `throughAssets`): nothing downstream compiles against it.
//
// TEST only the suites of the packages holding a changed file, and of those only the test files whose relative value
// imports reach a changed file. A dependent's suites, and the rest of a changed package's, are what the check after the land
// runs on the main tree (verify.mjs); running them here made a one-line change run most of the repository's suites.
// A change to what every suite of a package loads (its manifest, bunfig.toml, a preload, a tsconfig) runs that
// package's whole suite, since no import edge names it.
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { importsOf } from "../../checks/lib/imports.mjs";
import { affectedBy } from "../../checks/lib/workspace-graph.mjs";

const SOURCE = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}";
const IGNORED = ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "**/.cache/**"];
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Resolution order for an extensionless or `.js`-spelled relative specifier, as bun and tsc resolve this repo's source.
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".vue", ".js", ".mjs", ".cjs", ".jsx", ".json"];
// Files every suite of a package loads without importing them.
const SUITE_WIDE = /(?:^|\/)(?:package\.json|bunfig\.toml|tsconfig[^/]*\.json|[^/]*\.setup\.[cm]?[jt]s|[^/]*preload[^/]*\.[cm]?[jt]s)$/;

const isFile = (path) => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

// The package-relative file a relative specifier names, or undefined when it leaves the package or names nothing here.
export const resolveRelative = (dir, fromFile, specifier) => {
    const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier.split("?")[0]));
    if (target.startsWith("..")) {
        return undefined;
    }
    const stem = target.replace(/\.[cm]?jsx?$/, "");
    const candidates = [target, ...EXTENSIONS.map((ext) => `${stem}${ext}`), ...EXTENSIONS.map((ext) => `${target}/index${ext}`)];
    return candidates.find((candidate) => isFile(join(dir, candidate)));
};

// Test files of the package in `dir` whose relative imports reach one of `changed` (package-relative paths).
export const relatedTests = (dir, changed) => {
    const files = globSync(SOURCE, { cwd: dir, exclude: IGNORED });
    const importers = new Map(); // file -> files that import it
    for (const file of files) {
        let text;
        try {
            text = readFileSync(join(dir, file), "utf8");
        } catch {
            continue;
        }
        // A type-only import erases before a suite runs, so it carries no behaviour; the typecheck judges what it names.
        for (const { specifier, typeOnly } of importsOf(text)) {
            if (typeOnly || !specifier.startsWith(".")) {
                continue;
            }
            const imported = resolveRelative(dir, file, specifier);
            if (imported !== undefined) {
                (importers.get(imported) ?? importers.set(imported, new Set()).get(imported)).add(file);
            }
        }
    }
    const reached = new Set();
    const queue = [...changed];
    while (queue.length > 0) {
        const file = queue.pop();
        if (reached.has(file)) {
            continue;
        }
        reached.add(file);
        queue.push(...(importers.get(file) ?? []));
    }
    return [...reached].filter((file) => TEST_FILE.test(file) && existsSync(join(dir, file))).sort();
};

// `{ global, typecheck: Set<name>, tests: Map<name, "all" | string[]> }` for a list of repo-relative changed paths.
export const turnClosure = (root, graph, changed) => {
    const { global, seeds, affected } = affectedBy(graph, changed, { throughAssets: false });
    const tests = new Map();
    if (global !== undefined) {
        return { global, typecheck: affected, tests };
    }
    for (const name of seeds) {
        const { dir } = graph.packages.get(name);
        const inside = changed.filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1));
        if (inside.some((path) => SUITE_WIDE.test(path))) {
            tests.set(name, "all");
            continue;
        }
        const files = relatedTests(join(root, dir), inside);
        if (files.length > 0) {
            tests.set(name, files);
        }
    }
    return { global, typecheck: affected, tests };
};

