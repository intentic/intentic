/* THE WORKSPACE DEPENDENCY GRAPH, read from every package.json's `workspace:` specifiers, and the one question
 * everything asks of it: which packages does a set of changed paths reach?
 *
 * Shared by CI's `changes` job (affected.mjs, over a commit range) and the turn-ending check (verify-turn.mjs,
 * over the working tree), so the two cannot disagree about what "affected" means. Both run where turbo may
 * not be installed, which is why this reads the manifests turbo reads rather than asking turbo. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Dev and peer edges count as much as runtime ones: @intentic/share-view declares the web app as a devDependency
// and compiles its SOURCE into its own bundle, which is a real edge that a runtime-only walk would miss.
const WORKSPACE_DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/* ROOT FILES INVALIDATE EVERYTHING, and they have to be named because they belong to no package: the lockfile
 * and the workspace manifest change what every install resolves, turbo.json changes every task hash, and the
 * root package.json carries the engines and packageManager pins the whole fleet runs on. */
export const GLOBAL = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "package.json", "tsconfig.libs.json"]);

const workspaceDeps = (pkg) => {
    const deps = new Set();
    for (const field of WORKSPACE_DEP_FIELDS) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
            if (typeof spec === "string" && spec.startsWith("workspace:")) {
                deps.add(name);
            }
        }
    }
    return deps;
};

// Every package.json outside node_modules, and the `workspace:` edges between them.
export const readWorkspaceGraph = (root) => {
    const packages = new Map(); // name -> { name, dir, deps: Set<string> }
    const byDir = []; // [dir, name], longest dir first
    (function walk(dir, depth) {
        if (depth > 4) {
            return;
        }
        for (const entry of readdirSync(join(root, dir || "."), { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
                continue;
            }
            const child = dir ? `${dir}/${entry.name}` : entry.name;
            const manifest = join(root, child, "package.json");
            if (existsSync(manifest)) {
                const pkg = JSON.parse(readFileSync(manifest, "utf8"));
                packages.set(pkg.name, { name: pkg.name, dir: child, deps: workspaceDeps(pkg) });
                byDir.push([child, pkg.name]);
            }
            walk(child, depth + 1);
        }
    })("", 0);
    byDir.sort((a, b) => b[0].length - a[0].length);
    // dependency -> the packages that declare it, for propagating a change upward to its consumers.
    const dependents = new Map();
    for (const pkg of packages.values()) {
        for (const dep of pkg.deps) {
            (dependents.get(dep) ?? dependents.set(dep, new Set()).get(dep)).add(pkg.name);
        }
    }
    return { packages, byDir, dependents };
};

/* The packages a set of changed paths reaches: the ones containing a changed file, then everything that
 * transitively depends on one of those. `global` says a root file moved, in which case `affected` is every
 * package and the caller should not bother filtering. */
export const affectedBy = (graph, changed) => {
    const globalHit = changed.find((path) => GLOBAL.has(path));
    if (globalHit !== undefined) {
        return { global: globalHit, seeds: new Set(), affected: new Set(graph.packages.keys()) };
    }
    const seeds = new Set();
    for (const path of changed) {
        const owner = graph.byDir.find(([dir]) => path === dir || path.startsWith(`${dir}/`));
        if (owner) {
            seeds.add(owner[1]);
        }
    }
    // Breadth-first up the reverse edges: a package is affected when anything it depends on is.
    const affected = new Set();
    const queue = [...seeds];
    while (queue.length > 0) {
        const name = queue.pop();
        if (affected.has(name)) {
            continue;
        }
        affected.add(name);
        for (const consumer of graph.dependents.get(name) ?? []) {
            queue.push(consumer);
        }
    }
    return { global: undefined, seeds, affected };
};
