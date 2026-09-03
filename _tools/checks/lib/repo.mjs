/* WHAT EVERY CHECK READS ABOUT THE REPOSITORY, once. The workspace packages, the test files, the export maps a
 * workspace import resolves through, and a git runner. Every reader here works on a bare checkout: no
 * `node_modules`, no YAML parser, nothing installed, because the checks run before `pnpm install` in CI's
 * preflight job and from a pre-push hook on a clone that may never have installed.
 *
 * BY FILE, NOT BY PACKAGE NAME. A bare specifier resolves through `node_modules`, and that is exactly what does
 * not exist at the moments above. A relative specifier is resolved by the filesystem alone and cannot go
 * quietly wrong: move either file and the import fails loudly. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../constants/src/node.mjs";

export const root = repoRoot(import.meta.url);

// Discovered, not listed: every `_`-prefixed root directory is a package group (pnpm-workspace.yaml globs the same set).
export const WORKSPACES = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("_"))
    .map((entry) => entry.name);
export const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "generated", ".git"]);
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const VUE_FILE = /\.vue$/;

/* The workspace file's negations are part of the same discovery: a directory it excludes (the store shells:
 * installed standalone on the machine that actually builds them, a Mac with Xcode or Bubblewrap's JDK) is not
 * an importer, so the lockfile owes it nothing and its files belong to no type-check program here. Exact
 * paths only, matching how the negations are written; a glob negation would be a shape this scanner does not
 * recognize, and the package it hides would then fail the lockfile check loudly rather than pass in silence. */
export const EXCLUDED = new Set();
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

// Every workspace package, as `{ name: "_deploy/graph", dir, pkg }`, the one directory walk every check reads.
export const packages = WORKSPACES.flatMap((workspace) =>
    readdirSync(join(root, workspace)).flatMap((name) => {
        if (EXCLUDED.has(`${workspace}/${name}`)) {
            return [];
        }
        const dir = join(root, workspace, name);
        const manifest = join(dir, "package.json");
        return existsSync(manifest) ? [{ name: `${workspace}/${name}`, dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) }] : [];
    }),
);

export const byName = new Map(packages.map((entry) => [entry.pkg.name, entry]));

// One walk, any file kind: the test files the program checks read, the templates the compiler check reads.
export const walk = (dir, wanted = TEST_FILE) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (SKIP_DIRS.has(entry.name)) {
            return [];
        }
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path, wanted) : wanted.test(entry.name) ? [path] : [];
    });

// A package whose dependents read it from dist: its exports point at compiled files.
export const emitsDist = (pkg) => /"\.\/dist\/[^"]+\.js"/.test(JSON.stringify(pkg.exports ?? ""));

// tsconfigs here carry comments and trailing commas; this only needs `exclude`, so read it without a parser.
export const excludesOf = (configPath) => {
    const raw = readFileSync(configPath, "utf8");
    const match = /"exclude"\s*:\s*\[([^\]]*)\]/.exec(raw);
    return match === null ? [] : [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

// Which config `pnpm typecheck` actually compiles: `-p <path>` if the script names one, else tsconfig.json.
export const configFor = (script) => /-p\s+(\S+)/.exec(script)?.[1] ?? "tsconfig.json";

/* Where a workspace import lands in this checkout, resolved from the CHECKOUT and never through `node_modules`.
 * Every workspace package's `exports` states an `@intentic/src` condition pointing at the .ts source (it is
 * what lets vitest read a sibling's source rather than its last build), so the manifests already walked above
 * are the whole resolver: shape, not a list of packages. */
const SOURCE_CONDITION = "@intentic/src";
export const workspaceSource = (specifier) => {
    const segments = specifier.split("/");
    // A scoped name is two segments and a bare one is one; whatever follows is the export subpath.
    const depth = specifier.startsWith("@") ? 2 : 1;
    const owner = byName.get(segments.slice(0, depth).join("/"));
    const subpath = segments.length > depth ? `./${segments.slice(depth).join("/")}` : ".";
    const entry = owner?.pkg.exports?.[subpath];
    const source = entry?.import?.[SOURCE_CONDITION] ?? entry?.[SOURCE_CONDITION];
    return source === undefined ? undefined : join(owner.dir, source);
};

// Where an import lands: a relative specifier by the filesystem, a workspace one by the manifest. The repo
// writes ESM (`./testing.js` for `testing.ts`), so the extension in a relative specifier is the one the
// compiler emits, not the one on disk.
export const sourceOf = (file, specifier) => {
    if (!specifier.startsWith(".")) {
        return workspaceSource(specifier);
    }
    const path = join(dirname(file), specifier);
    return [path.replace(/\.[cm]?js$/, ".ts"), path.replace(/\.[cm]?js$/, ".tsx"), `${path}.ts`].find((candidate) => existsSync(candidate));
};

// A git question answered from the checkout, or undefined when git says no.
export const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
};

// Every tracked path, the set most byte- and text-level checks walk.
export const trackedFiles = () =>
    (git("ls-files", "-z") ?? "")
        .split("\0")
        .filter((path) => path !== "");
