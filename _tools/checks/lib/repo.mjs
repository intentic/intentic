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

/* Whether this checkout is a linked worktree rather than the primary one: a checkout whose git dir is not its
 * common dir. Every conversation runs in one, and two different things read it.
 *
 * The PUSH GATE reads it to decide whether `pnpm build` can run at all: pnpm hardlinks into `node_modules`
 * after a build, a worktree's `node_modules` is a different filesystem, and the run dies EXDEV.
 *
 * The RATCHETED CHECKS read it through `writesBaselines` below.
 *
 * `--path-format=absolute` on both, because the two answers are otherwise spelled differently by default —
 * `--git-dir` answers `.git` relative to the cwd in the primary checkout and an absolute path in a worktree —
 * so a comparison of the raw strings is right for the wrong reason and stops being right the moment either
 * call is made from a subdirectory. */
export const isLinkedWorktree = () => {
    const gitDir = git("rev-parse", "--path-format=absolute", "--git-dir")?.trim();
    const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir;
};

/* WHETHER A CHECK MAY WRITE A BASELINE BACK INTO THIS CHECKOUT, which is the same question as "can this write
 * become a commit". A ratchet the tree has beaten tightens its own baseline rather than failing (nothing here
 * fails for having improved, and a shared baseline that has to be hand-edited is everybody else's red until
 * somebody does). That repair is only worth making where it can be kept:
 *
 *   · the PRIMARY CHECKOUT, where the tightened file rides the owner's next commit. Yes.
 *   · an agent's WORKTREE, where it would land as one more line for the owner's tree to reconcile against
 *     every other turn's. No — reported instead, and the primary checkout writes it on its next run.
 *   · a CI RUNNER, where nobody commits anything and the workspace is either thrown away or force-reset by the
 *     next checkout. No: a check that dirties a tracked file there has changed nothing and left a tree that
 *     no longer matches the commit under every job that runs after it on the same workspace.
 *
 * `CI` is the variable every forge sets and the one convention there is; GitHub Actions, GitLab CI and the
 * self-hosted runners in this repository's fleet all set it to `true`. */
export const writesBaselines = () => process.env.CI === undefined && !isLinkedWorktree();

// A git question answered from the checkout, or undefined when git says no.
export const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
};

// Every tracked path, the set most byte- and text-level checks walk. Filtered to what is ON DISK: the index
// still lists a file whose deletion is unstaged, and a gate that read it would crash on the working tree the
// gates exist to judge, rather than judging it without the file.
export const trackedFiles = () =>
    (git("ls-files", "-z") ?? "")
        .split("\0")
        .filter((path) => path !== "" && existsSync(path));

/* Every path git sees and does not track and would not ignore: a file an agent's land put in the tree that
 * nobody has `git add`ed yet, a new package's whole source. The half of "what is in this directory" that
 * `trackedFiles` cannot answer, and the difference between a directory that is EMPTY of anything git would
 * ever want (build output around a package that moved away) and one that is merely not committed yet. A rule
 * that reads only the tracked set calls both a ghost, and a repair that deletes ghosts would delete the second. */
export const untrackedFiles = () =>
    (git("ls-files", "--others", "--exclude-standard", "-z") ?? "")
        .split("\0")
        .filter((path) => path !== "");
