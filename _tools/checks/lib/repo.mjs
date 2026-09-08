// Repository readers used by every check: workspace packages, test files, export-map resolution, a git runner. All work
// on a bare checkout (no node_modules, no YAML parser), since checks run before `pnpm install`. Resolves imports by
// file, not package name, so a moved file fails loudly rather than silently.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../constants/src/node.mjs";

export const root = repoRoot(import.meta.url);

// Discovered: every `_`-prefixed root directory is a package group, matching pnpm-workspace.yaml's globs.
export const WORKSPACES = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("_"))
    .map((entry) => entry.name);
export const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "generated", ".git"]);
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const VUE_FILE = /\.vue$/;

// Directories pnpm-workspace.yaml negates: not importers, so the lockfile and per-package type-check owe them nothing.
// Matches exact paths only, as the negations are written; a glob negation here would go unrecognized.
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

// Every workspace package, as `{ name, dir, pkg }`; the one directory walk every check reads.
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

// One walk for any file kind matched by `wanted` — test files, or a compiler check's templates.
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

// Resolves a workspace import to its .ts source in this checkout, never through node_modules, via each package's
// `exports`'s `@intentic/src` condition.
const SOURCE_CONDITION = "@intentic/src";
export const workspaceSource = (specifier) => {
    const segments = specifier.split("/");
    // A scoped name is two segments, a bare one is one; what follows is the export subpath.
    const depth = specifier.startsWith("@") ? 2 : 1;
    const owner = byName.get(segments.slice(0, depth).join("/"));
    const subpath = segments.length > depth ? `./${segments.slice(depth).join("/")}` : ".";
    const entry = owner?.pkg.exports?.[subpath];
    const source = entry?.import?.[SOURCE_CONDITION] ?? entry?.[SOURCE_CONDITION];
    return source === undefined ? undefined : join(owner.dir, source);
};

// Resolves an import: a relative specifier via the filesystem, a workspace one via the manifest. The repo writes ESM
// (`./testing.js` for testing.ts), so a relative specifier's extension is the compiled one, not the on-disk one.
export const sourceOf = (file, specifier) => {
    if (!specifier.startsWith(".")) {
        return workspaceSource(specifier);
    }
    const path = join(dirname(file), specifier);
    return [path.replace(/\.[cm]?js$/, ".ts"), path.replace(/\.[cm]?js$/, ".tsx"), `${path}.ts`].find((candidate) => existsSync(candidate));
};

// Whether this checkout is a linked worktree (git dir differs from common dir): `pnpm build`'s node_modules hardlinking
// dies EXDEV there. `--path-format=absolute` keeps the comparison valid regardless of cwd.
export const isLinkedWorktree = () => {
    const gitDir = git("rev-parse", "--path-format=absolute", "--git-dir")?.trim();
    const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir;
};

// Whether a check may write a baseline back: only in the primary checkout, where it rides the owner's next commit. Not
// in a worktree or CI runner (`CI` is set by every forge), where the write cannot become a commit and is reported
// instead.
export const writesBaselines = () => process.env.CI === undefined && !isLinkedWorktree();

// A git question answered from the checkout, or undefined when git says no.
export const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
};

// Every tracked path that still exists on disk; the index can list a file whose deletion is unstaged.
export const trackedFiles = () =>
    (git("ls-files", "-z") ?? "")
        .split("\0")
        .filter((path) => path !== "" && existsSync(path));

// Every path git sees, untracked and not ignored: a land's brand-new package before `git add`. Lets a ghost
// (all-ignored or empty) be told apart from a directory merely not yet committed.
export const untrackedFiles = () =>
    (git("ls-files", "--others", "--exclude-standard", "-z") ?? "")
        .split("\0")
        .filter((path) => path !== "");
