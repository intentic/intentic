#!/usr/bin/env node
// Which packages' `dist/` is older than their source, or missing: `node _tools/scripts/build/dist-staleness.mjs
// [--for <package dir or name>]`. A dist is gitignored and built by hand or by a land, so a checkout that moved on
// (a pull, a land, a new worktree overlaying main's mirrors) keeps the declarations of an older main. The type checker then
// reports `has no exported member`, `TS6305` or `Cannot find module '@intentic/…'` against code that is fine, and that
// was the most common false lead across a week of agents' debugging sessions (about twenty of seventy). This answers in
// well under a second from file times alone, so `suites` can ask it before every run (`--for` narrows it to the
// packages one package reads, its workspace dependencies all the way down), and says the command that rebuilds them.
// Exits 1 when something is stale, 0 otherwise.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packages, root, SKIP_DIRS, TEST_FILE } from "../../checks/lib/repo.mjs";

export const REBUILD = "node _tools/scripts/build/emit-declarations.mjs";
// The one package emit-declarations leaves to its own build (vue-tsc), and the command for it.
const OWN_BUILD = new Map([["_shared/extension-ui", "pnpm --filter @intentic/extension-ui build"]]);
// A package a type checker reads from dist: its exports (or `types`) name declarations there. One whose dist is a bundle
// with no declarations (a widget built by vite) types nothing for its dependents, so its age misleads no one.
const readsDeclarations = (pkg) => /"\.\/dist\/[^"]+\.d\.[cm]?ts"/u.test(JSON.stringify([pkg.exports, pkg.types, pkg.typings]));
// What compiles into dist: a test file never does.
const SOURCE = /\.(?:[cm]?ts|tsx|vue)$/u;

// The newest file under `dir` that `wanted` accepts, as `{ path, mtimeMs }`, or undefined for none (or no directory).
const newest = (dir, wanted) => {
    let found;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        // allow(silent-catch): a directory that is not there holds nothing, which is what the caller asks
        return undefined;
    }
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) && entry.name !== "generated") {
            continue;
        }
        const path = join(dir, entry.name);
        const candidate = entry.isDirectory() ? newest(path, wanted) : wanted(entry.name) ? { path, mtimeMs: statSync(path).mtimeMs } : undefined;
        if (candidate !== undefined && candidate.mtimeMs > (found?.mtimeMs ?? 0)) {
            found = candidate;
        }
    }
    return found;
};

const isSource = (name) => SOURCE.test(name) && !TEST_FILE.test(name) && !name.endsWith(".d.ts");

// The workspace packages `start` reads, its own dependencies and theirs, by manifest; `start` itself included.
const dependencyClosure = (start, all) => {
    const byName = new Map(all.map((entry) => [entry.pkg.name, entry]));
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
        const { pkg } = queue.pop();
        for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) {
            const dep = byName.get(name);
            if (dep !== undefined && !seen.has(dep)) {
                seen.add(dep);
                queue.push(dep);
            }
        }
    }
    return [...seen];
};

// Whether git says the source really changed since `since` (ms): a commit touching it, or work not yet committed. A
// checkout rewrites every file it restores, so a newer file time alone can be a restore of the same text; git is asked
// only for a package the file times already flag, so the common answer costs no process. No git answers yes.
const changedSince = (dir, since) => {
    const git = (args) => spawnSync("git", ["-C", dir, ...args, "--", "src"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const log = git(["log", "-1", "--format=%H", `--since=${new Date(since).toISOString()}`]);
    const status = git(["status", "--porcelain"]);
    if (log.status !== 0 || status.status !== 0) {
        return true;
    }
    return log.stdout.trim() !== "" || status.stdout.trim() !== "";
};

/** The packages read from dist whose dist is missing or older than a source file, each with why. `forPackage` (a
 *  directory or a package name) narrows the answer to what that package reads. */
export const staleDist = ({ forPackage, all = packages, changed = changedSince } = {}) => {
    const start = forPackage === undefined ? undefined : all.find(({ dir, pkg }) => resolve(forPackage) === dir || pkg.name === forPackage);
    const scope = start === undefined ? all : dependencyClosure(start, all);
    return scope
        .filter(({ pkg }) => readsDeclarations(pkg))
        .flatMap(({ name, dir, pkg }) => {
            const source = newest(join(dir, "src"), isSource);
            if (source === undefined) {
                return [];
            }
            const built = newest(join(dir, "dist"), () => true);
            if (built === undefined) {
                return [{ name: pkg.name, dir: name, why: "has no dist", rebuild: OWN_BUILD.get(name) ?? REBUILD }];
            }
            if (source.mtimeMs <= built.mtimeMs || !changed(dir, built.mtimeMs)) {
                return [];
            }
            const hours = (source.mtimeMs - built.mtimeMs) / 3_600_000;
            const age = hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.max(1, Math.round(hours * 60))} min`;
            return [{ name: pkg.name, dir: name, why: `dist is ${age} older than ${relative(dir, source.path)}`, rebuild: OWN_BUILD.get(name) ?? REBUILD }];
        });
};

const rebuilds = (stale) => [...new Set(stale.map(({ rebuild }) => rebuild))];

/** One line for a run's preflight, or undefined when nothing it reads is stale. */
export const staleDistWarning = (stale) =>
    stale.length === 0
        ? undefined
        : `stale dist: ${stale.map(({ name, why }) => `${name} ${why}`).join("; ")}. An error about one of them ("has no exported member", TS6305, "Cannot find module '@intentic/…'") is that, not your code; rebuild from ${root}: ${rebuilds(stale).join(" && ")}`;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const at = process.argv.indexOf("--for");
    const forPackage = at === -1 ? undefined : process.argv[at + 1];
    const stale = staleDist({ forPackage });
    if (stale.length === 0) {
        console.log(`dist: current for every package ${forPackage === undefined ? "read from dist" : `${forPackage} reads`}`);
        process.exit(0);
    }
    for (const { dir, why } of stale) {
        console.log(`${dir}: ${why}`);
    }
    console.log(`rebuild: cd ${root} && ${rebuilds(stale).join(" && ")}`);
    process.exit(1);
}
