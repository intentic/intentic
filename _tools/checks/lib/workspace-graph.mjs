// Workspace dependency graph from every package.json's `workspace:` specifiers, answering which packages a set of
// changed paths reaches. Shared by affected.mjs (CI, a commit range) and verify-turn.mjs (a working tree), so the two
// agree; reads manifests directly since turbo may not be installed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Dev and peer edges count too: a devDependency can compile another package's source into its own bundle.
const WORKSPACE_DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Root files with no owning package; a change to any of them invalidates every package in the graph.
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
    // dependency -> packages that declare it, so a change propagates upward to consumers.
    const dependents = new Map();
    for (const pkg of packages.values()) {
        for (const dep of pkg.deps) {
            (dependents.get(dep) ?? dependents.set(dep, new Set()).get(dep)).add(pkg.name);
        }
    }
    return { packages, byDir, dependents };
};

// The packages a set of changed paths reaches: those containing a changed file, plus everything that transitively
// depends on one. `global` set means a root file changed, so `affected` is every package.
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
