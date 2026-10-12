// What ignored-imports.mjs reads a file for: every relative import that reaches no tracked file and lands on a path
// .gitignore swallows. Kept apart from the check so its suite can run it against a throwaway repository.
//
// Resolution is the repo's own, by shape and without node_modules: the exact path; the TypeScript spelling of a source
// by its compiled name (`./x.js` for x.ts); an extensionless specifier as Vite and bun read it; a bundler query
// (`?raw`, `?url`) dropped. Only `./` and `../` specifiers: a package name resolves through a manifest, which the
// lockfile and the type checker already hold to account.
import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { importsOf } from "./imports.mjs";

export const SOURCE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|vue)$/;

// Git could not answer, which is a check that did not look rather than a tree that is wrong.
export class GitRefused extends Error {}

// `?raw`, `?url`, `?worker`, `#hash`: a different view of the same file, not a different file.
const QUERY = /[?#].*$/;
// A compiled name stands for the source the compiler emits it from.
const SOURCE_OF_COMPILED = new Map([
    [".js", [".ts", ".tsx", ".mts"]],
    [".jsx", [".tsx"]],
    [".mjs", [".mts"]],
    [".cjs", [".cts"]],
]);
const IMPLIED = [".ts", ".tsx", ".mts", ".js", ".mjs", ".vue"];
// A static import's specifier sits on a line that opens the statement or closes its clause. One quoted mid-line is a
// fixture a test feeds to a parser (`["a.ts", 'import { b } from "../b";']`), naming a file in a tree that does not exist.
const STATEMENT_LINE = /^\s*(?:(?:import|export|from)\b|\})/;
// A specifier ending in one of these names its file; anything else (`./x`, `./x.config`) has one implied.
const NAMED = /\.(?:[cm]?[jt]sx?|vue|json|css|scss|svg|png|jpe?g|gif|webp|woff2?|txt|md|html|wasm|ya?ml|sh)$/;

/** The repo-relative paths `specifier` may mean from `file`, most literal first; empty for one that leaves the checkout. */
export const candidatesOf = (file, specifier) => {
    const bare = specifier.replace(QUERY, "");
    const directory = bare.endsWith("/");
    const path = posix.normalize(posix.join(posix.dirname(file), bare)).replace(/\/$/, "");
    if (path === ".." || path.startsWith("../")) {
        return [];
    }
    const index = IMPLIED.map((extension) => `${path}/index${extension}`);
    if (directory) {
        return index;
    }
    if (NAMED.test(path)) {
        const extension = posix.extname(path);
        const stem = path.slice(0, -extension.length);
        return [path, ...(SOURCE_OF_COMPILED.get(extension) ?? []).map((source) => `${stem}${source}`)];
    }
    return [path, ...IMPLIED.map((extension) => `${path}${extension}`), ...index];
};

/** Every tracked path, as the index git is pointed at lists it (GIT_INDEX_FILE included: inherited through `env`). */
export const trackedIn = (root, env = process.env) => {
    const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) {
        throw new GitRefused(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
    }
    return listed.stdout.split("\0").filter((path) => path !== "");
};

/**
 * Which of `paths` git ignores, each with the rule that does it (`.gitignore:9 **\/dist-*`), in one `git check-ignore`
 * for the whole set. It answers for paths that do not exist, which is the case that matters: on a fresh clone the file
 * an import names is absent precisely because the rule kept it out.
 */
export const ignoredAmong = (root, paths, env = process.env) => {
    const ignored = new Map();
    if (paths.length === 0) {
        return ignored;
    }
    const asked = spawnSync("git", ["check-ignore", "--stdin", "-z", "-v"], {
        cwd: root,
        env,
        input: `${paths.join("\0")}\0`,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    // 0: some are ignored, 1: none are; anything else is git refusing, which is not an answer.
    if (asked.status !== 0 && asked.status !== 1) {
        throw new GitRefused(`git check-ignore failed in ${root}: ${asked.stderr.trim()}`);
    }
    const fields = asked.stdout.split("\0");
    for (let at = 0; at + 3 < fields.length; at += 4) {
        const [source, line, pattern, path] = fields.slice(at, at + 4);
        // `-v` also names a `!` rule a path matched, and matching one is what keeps a path in.
        if (!pattern.startsWith("!")) {
            ignored.set(path, `${source}:${line} ${pattern}`);
        }
    }
    return ignored;
};

/**
 * Every relative import in `subjects` that no tracked file answers and only ignored paths do, as
 * `{ file, line, specifier, target, rule }`. `tracked` is the whole listing, whatever the subjects: a scoped run judges
 * a few files' imports, but what they reach is anywhere in the tree.
 *
 * Which candidate an import means is read off the disk where it can be: a file there that git does not ignore will land
 * with the next commit (`./x.js` for a new x.ts, while a stale x.js beside it is ignored output), so only an import
 * whose every file on disk is ignored is a finding. With none on disk, which is a fresh clone of the commit that broke,
 * it is a finding when every path it could mean is ignored: `**\/dist-*` swallows a dist-prefixed .mjs and its .mts alike.
 */
export const ignoredImports = ({ root, subjects, tracked, read, exists, env = process.env }) => {
    const unanswered = [];
    for (const file of subjects) {
        const text = read(file);
        const lines = text.split("\n");
        for (const { specifier, dynamic, line } of importsOf(text)) {
            if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
                continue;
            }
            if (!dynamic && !STATEMENT_LINE.test(lines[line - 1])) {
                continue;
            }
            const candidates = candidatesOf(file, specifier);
            if (candidates.length > 0 && !candidates.some((candidate) => tracked.has(candidate))) {
                unanswered.push({ file, line, specifier, candidates });
            }
        }
    }
    const ignored = ignoredAmong(root, [...new Set(unanswered.flatMap(({ candidates }) => candidates))], env);
    return unanswered.flatMap(({ file, line, specifier, candidates }) => {
        const onDisk = candidates.filter(exists);
        const meant = onDisk.length > 0 ? onDisk : candidates;
        return meant.every((candidate) => ignored.has(candidate)) ? [{ file, line, specifier, target: meant[0], rule: ignored.get(meant[0]) }] : [];
    });
};
