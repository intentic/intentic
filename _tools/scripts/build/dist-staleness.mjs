#!/usr/bin/env node
// Which workspace packages a package reads from `dist/` hold a dist older than their own source. Such a dist fails
// imports ("has no exported member", "Cannot find module") and type checks in ways that read as the code's fault, so
// `suites` says so before it runs, and an agent's command output points here (agent-output-notices.ts).
//
//   node _tools/scripts/build/dist-staleness.mjs [--for <package dir or @intentic/name>]
//
// Without --for, every package that emits a dist is checked. Exits 1 when one is stale, after naming the rebuild.
// NOTE: the root .gitignore hides `dist-*` and un-hides this file by name; a rename needs that line moved with it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { byName, emitsDist, packages, root, SKIP_DIRS } from "../../checks/lib/repo.mjs";

export const REBUILD = "node _tools/scripts/build/emit-declarations.mjs";

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|json)$/;

// The newest modification time under a directory, or undefined for one that is absent or empty.
const newestUnder = (dir, wanted) => {
    if (!existsSync(dir)) {
        return undefined;
    }
    let newest;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                const below = newestUnder(join(dir, entry.name), wanted);
                newest = below === undefined || (newest !== undefined && newest >= below) ? newest : below;
            }
        } else if (entry.isFile() && wanted.test(entry.name)) {
            const mtime = statSync(join(dir, entry.name)).mtimeMs;
            newest = newest !== undefined && newest >= mtime ? newest : mtime;
        }
    }
    return newest;
};

// The newest file of a dist: a build rewrites what changed, so this is when the dist last caught up with its source.
const builtAt = (dist) => newestUnder(dist, /\.(?:[cm]?js|d\.[cm]?ts)$/);

const workspaceDeps = (pkg) =>
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
        .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
        .map(([name]) => name);

// The package named by a directory (its own or one inside it) or by its `@intentic/…` name.
const packageFor = (target) => {
    if (byName.has(target)) {
        return byName.get(target);
    }
    const dir = resolve(target);
    return packages
        .filter((entry) => dir === entry.dir || dir.startsWith(`${entry.dir}/`))
        .toSorted((a, b) => b.dir.length - a.dir.length)[0];
};

// Every workspace package `forPackage` reads, transitively, and itself too with `withSelf` (a package's own tests read
// its source, so `suites` leaves it out); all of them without one.
const scope = (forPackage, withSelf) => {
    if (forPackage === undefined) {
        return packages;
    }
    const start = packageFor(forPackage);
    if (start === undefined) {
        return [];
    }
    const seen = new Set();
    const queue = withSelf ? [start.pkg.name] : workspaceDeps(start.pkg);
    while (queue.length > 0) {
        const name = queue.shift();
        const entry = byName.get(name);
        if (entry === undefined || seen.has(name)) {
            continue;
        }
        seen.add(name);
        queue.push(...workspaceDeps(entry.pkg));
    }
    return [...seen].map((name) => byName.get(name));
};

// The packages in scope that emit a dist older than their source, or with no dist at all yet.
export const staleDist = ({ forPackage, withSelf = false } = {}) =>
    scope(forPackage, withSelf).flatMap(({ name, dir, pkg }) => {
        if (!emitsDist(pkg)) {
            return [];
        }
        const source = newestUnder(join(dir, "src"), SOURCE);
        if (source === undefined) {
            return [];
        }
        const built = builtAt(join(dir, "dist"));
        return built === undefined || built < source ? [{ name: pkg.name ?? name, dir: relative(root, dir), builtAt: built, sourceAt: source }] : [];
    });

// One line naming what is stale and the command that rebuilds it; undefined when nothing is.
export const staleDistWarning = (stale) => {
    if (stale.length === 0) {
        return undefined;
    }
    const shown = stale.slice(0, 5).map((entry) => entry.name);
    const more = stale.length > shown.length ? ` and ${stale.length - shown.length} more` : "";
    const verb = stale.length === 1 ? "has a dist" : "have a dist";
    return (
        `${shown.join(", ")}${more} ${verb} older than its source, so imports and type checks may fail in ways that ` +
        `are not the code's fault. Rebuild with \`${REBUILD}\`.`
    );
};

if (import.meta.url === `file://${process.argv[1]}`) {
    const at = process.argv.indexOf("--for");
    const forPackage = at === -1 ? undefined : process.argv[at + 1];
    if (forPackage !== undefined && packageFor(forPackage) === undefined) {
        console.error(`dist-staleness: no workspace package is ${forPackage}`);
        process.exit(2);
    }
    const stale = staleDist({ forPackage, withSelf: true });
    for (const entry of stale) {
        const when = entry.builtAt === undefined ? "never built" : `built ${new Date(entry.builtAt).toISOString()}`;
        console.log(`${entry.name} (${entry.dir}): ${when}, source changed ${new Date(entry.sourceAt).toISOString()}`);
    }
    const warning = staleDistWarning(stale);
    console.log(warning ?? `dist-staleness: every dist ${forPackage === undefined ? "" : `${forPackage} reads `}is current`);
    process.exit(warning === undefined ? 0 : 1);
}
