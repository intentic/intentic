// Repository readers used by every check: workspace packages, test files, export-map resolution, a git runner. All work
// on a bare checkout (no node_modules, no YAML parser), since checks run before `pnpm install`. Resolves imports by
// file, not package name, so a moved file fails loudly rather than silently.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../constants/src/node.mjs";
import { cannotMeasure } from "./report.mjs";
import { readWorkspaceGraph } from "./workspace-graph.mjs";

export const root = repoRoot(import.meta.url);

// Discovered: every `_`-prefixed root directory is a package group, matching pnpm-workspace.yaml's globs.
export const WORKSPACES = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("_"))
    .map((entry) => entry.name);
export const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "generated", ".git", "target"]);
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
// A copy of a conditions tree (JSON, as package.json holds it) with every target's `*` replaced by what it matched.
const substituted = (node, matched) => JSON.parse(JSON.stringify(node).replaceAll("*", JSON.stringify(matched).slice(1, -1)));
// The `exports` entry for one subpath as Node picks it: the exact key, else the `*` pattern with the longest head.
export const exportEntry = (exports, subpath) => {
    if (exports?.[subpath] !== undefined) {
        return exports[subpath];
    }
    const [pattern, head, tail] =
        Object.keys(exports ?? {})
            .filter((key) => key.includes("*"))
            .map((key) => [key, key.slice(0, key.indexOf("*")), key.slice(key.indexOf("*") + 1)])
            .filter(([, start, end]) => subpath.startsWith(start) && subpath.endsWith(end) && subpath.length >= start.length + end.length)
            .toSorted(([, a], [, b]) => b.length - a.length)[0] ?? [];
    return pattern === undefined ? undefined : substituted(exports[pattern], subpath.slice(head.length, subpath.length - tail.length));
};
export const workspaceSource = (specifier) => {
    const segments = specifier.split("/");
    // A scoped name is two segments, a bare one is one; what follows is the export subpath.
    const depth = specifier.startsWith("@") ? 2 : 1;
    const owner = byName.get(segments.slice(0, depth).join("/"));
    const subpath = segments.length > depth ? `./${segments.slice(depth).join("/")}` : ".";
    const entry = exportEntry(owner?.pkg.exports, subpath);
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

// `specifier` resolved from the package at `dir`, or undefined when it is not installed there (a check run before
// `pnpm install`). Installed and failing to load is a broken install, which no check can measure past.
export const installedModule = (dir, specifier) => {
    try {
        return createRequire(join(dir, "package.json"))(specifier);
    } catch (error) {
        if (error.code === "MODULE_NOT_FOUND") {
            return undefined;
        }
        return cannotMeasure(`${specifier} is installed under ${dir} but did not load (${error.message}): the install is broken, so nothing that needs it was read`);
    }
};

// Whether this checkout is a linked worktree (git dir differs from common dir): `pnpm build`'s node_modules hardlinking
// dies EXDEV there. `--path-format=absolute` keeps the comparison valid regardless of cwd.
export const isLinkedWorktree = () => {
    const gitDir = git("rev-parse", "--path-format=absolute", "--git-dir")?.trim();
    const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir;
};

const asked = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
};

// A pathspec that names a path and nothing more (no glob, no magic, no `.`, `..` or trailing slash): it matches that
// file and everything under it, which the whole listing answers without git.
const PLAIN_PATH = /^(?![-.:/])(?!.*(?:\/\/|\/\.{1,2}(?:\/|$)|\/$))[^*?[\]\\]+$/;

// The answers given so far, kept only once `rememberGit()` asks: one process judging one edit with every scoped
// check (run.mjs --paths) asks each listing once per check, and the extension checks list about a hundred manifests
// one at a time. Off by default, since a check that changes the tree (a `--fix`) must not read its old listing back.
let remembered;
export const rememberGit = () => {
    remembered ??= new Map();
};

// git's own reading of a pathspec with no magic (no `:(…)`, no GIT_*_PATHSPECS in the environment), as a test of one
// listed path, for the shapes the checks ask: a path, which matches itself and everything under it, and a pattern whose
// only wildcard is `*`, which git matches with wildmatch and no WM_PATHNAME, so any run of `*` crosses `/` and a `**/`
// is no shell globstar (`**/*.vue` lists no top-level `a.vue`). Undefined for every other shape (`?`, a class, an
// escape), which git is asked. repo.integration.test.mjs holds each shape to git's own answer.
const SPEC_ENV = ["GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_LITERAL_PATHSPECS", "GIT_ICASE_PATHSPECS"];
export const pathspecTest = (spec) => {
    if (PLAIN_PATH.test(spec)) {
        return (path) => path === spec || path.startsWith(`${spec}/`);
    }
    if (spec === "" || spec.startsWith(":") || /[?[\\]/u.test(spec) || SPEC_ENV.some((name) => process.env[name] !== undefined)) {
        return undefined;
    }
    const pattern = new RegExp(`^${spec.split("*").map((part) => part.replace(/[.+^${}()|[\]]/gu, "\\$&")).join(".*")}$`, "su");
    return (path) => pattern.test(path);
};

// The whole index listing as paths, split once for every listing answered from it.
let whole;
const wholeListing = () => {
    if (whole === undefined) {
        const listed = git("ls-files", "-z");
        whole = listed === undefined ? null : { paths: listed.split("\0").filter((path) => path !== ""), set: undefined };
        if (whole !== null) {
            whole.set = new Set(whole.paths);
        }
    }
    return whole ?? undefined;
};

// `git ls-files -z <specs>` answered from the whole listing, in its order, or undefined when a spec is one git must read.
const listedFromWhole = (specs) => {
    const tests = specs.map(pathspecTest);
    if (tests.some((test) => test === undefined)) {
        return undefined;
    }
    const listing = wholeListing();
    if (listing === undefined) {
        return undefined;
    }
    // A plain spec naming a listed file matches that file alone: a file has nothing under it.
    if (specs.length === 1 && PLAIN_PATH.test(specs[0]) && listing.set.has(specs[0])) {
        return `${specs[0]}\0`;
    }
    return listing.paths
        .filter((path) => tests.some((test) => test(path)))
        .map((path) => `${path}\0`)
        .join("");
};

// A git question answered from the checkout, or undefined when git says no.
export const git = (...args) => {
    if (remembered === undefined) {
        return asked(args);
    }
    const key = args.join("\0");
    if (!remembered.has(key)) {
        const [verb, flag, ...specs] = args;
        const listing = verb === "ls-files" && flag === "-z" && specs.length > 0 ? listedFromWhole(specs) : undefined;
        remembered.set(key, listing ?? asked(args));
    }
    return remembered.get(key);
};

// Every tracked path that still exists on disk; the index can list a file whose deletion is unstaged.
// Kept beside the listings it is read from once `rememberGit()` asks: every check of an edit that lists the tree
// would otherwise stat its fourteen thousand files again.
let tracked;
export const trackedFiles = () => {
    if (remembered !== undefined && tracked !== undefined) {
        return [...tracked];
    }
    const listed = git("ls-files", "-z");
    // An empty list reads every directory as a ghost, and layout.mjs removes ghosts.
    if (listed === undefined) {
        throw new Error(`git ls-files failed in ${root}: a check cannot judge a tree it cannot list`);
    }
    const present = listed.split("\0").filter((path) => path !== "" && existsSync(join(root, path)));
    if (remembered !== undefined) {
        tracked = present;
    }
    return [...present];
};

// The workspace's members and their edges (workspace-graph.mjs), read once per process once `rememberGit()` asks, as
// the listings are: three checks of every edit walk the tree for it.
let graph;
export const workspaceGraph = () => (remembered === undefined ? readWorkspaceGraph(root) : (graph ??= readWorkspaceGraph(root)));

/* SCOPE: the files this run is asked to judge, which is not the same question as what it may read. */

// `--paths a,b,c` on a check's own argv, repo-relative. Undefined means the whole tree, which is every caller but the
// per-edit one. A check declares `scoped` in the manifest only if narrowing its SUBJECTS cannot change its verdict on
// them — a rule that counts a directory or resolves a link across the tree is not scopable and says so by omission.
export const subjectScope = () => {
    const at = process.argv.indexOf("--paths");
    if (at === -1) {
        return undefined;
    }
    const paths = (process.argv[at + 1] ?? "").split(",").filter((path) => path !== "");
    // An explicit `--paths` naming nothing judges nothing; widening it to the tree would make a per-edit run measure
    // the whole repository and report somebody else's line as this edit's.
    //
    // Absolute in, repo-relative out, because the caller that matters does not know this root: the per-edit moment
    // substitutes `{file}` with the absolute path of the file just written (rules/file-edited.ts), and git lists
    // repo-relative ones. Comparing those two spellings matches nothing and reports a clean file, which is the failure
    // mode that looks exactly like success.
    return new Set(paths.map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)));
};

// Tracked files this run may judge: every one git lists under `patterns`, narrowed to the scope when there is one. The
// scope filters rather than replaces the listing, so a path that is untracked, ignored or deleted is still not a
// subject just because a caller named it.
export const subjectFiles = (...patterns) => {
    const scope = subjectScope();
    const listed = git("ls-files", "-z", ...patterns);
    // An empty list is a check that read nothing and vouches for everything.
    if (listed === undefined) {
        throw new Error(`git ls-files failed in ${root}: a check cannot judge a tree it cannot list`);
    }
    return listed.split("\0").filter((path) => path !== "" && (scope === undefined || scope.has(path)) && existsSync(join(root, path)));
};

// What nav's `listTracked(root)` answers (every present path, tracked or untracked and not ignored), from the listings
// kept once `rememberGit()` asks, so code-shape's own listing costs no git run and no second stat of the tree.
// Undefined otherwise, which leaves nav to list it.
export const presentFiles = () =>
    remembered === undefined ? undefined : [...new Set([...untrackedFiles().filter((path) => existsSync(join(root, path))), ...trackedFiles()])];

// Every path git sees, untracked and not ignored: a land's brand-new package before `git add`. Lets a ghost
// (all-ignored or empty) be told apart from a directory merely not yet committed.
export const untrackedFiles = () => {
    const listed = git("ls-files", "--others", "--exclude-standard", "-z");
    // An empty list reads a directory of uncommitted work as a ghost, and layout.mjs removes ghosts.
    if (listed === undefined) {
        throw new Error(`git ls-files --others failed in ${root}: a check cannot tell new work from a ghost without it`);
    }
    return listed.split("\0").filter((path) => path !== "");
};
