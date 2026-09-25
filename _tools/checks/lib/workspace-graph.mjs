// Workspace dependency graph from every package.json's `workspace:` specifiers, answering which packages a set of
// changed paths reaches. Shared by affected.mjs (CI, a commit range) and verify-turn.mjs (a working tree, when someone
// runs `pnpm verify:turn`), so the two agree; reads manifests directly since turbo may not be installed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Dev and peer edges count too: a devDependency can compile another package's source into its own bundle.
const WORKSPACE_DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// A package whose every export is a built asset rather than code: a page, a stylesheet. A dependent ships or serves the
// file and imports nothing from it that a compiler or a test runner reads, so a change behind it (the web editor a page
// bundles) cannot move a dependent's typecheck or suites. It does move what the dependent ships, which is why the edge
// is kept and only a test closure (`throughAssets: false`) stops at it.
const CODE_EXPORT = /\.(?:[cm]?[jt]sx?|vue)$/;
const exportTargets = (exports) =>
    typeof exports === "string" ? [exports] : exports !== null && typeof exports === "object" ? Object.values(exports).flatMap(exportTargets) : [];
const assetOnly = (pkg) => {
    const targets = exportTargets(pkg.exports);
    return targets.length > 0 && pkg.main === undefined && pkg.types === undefined && targets.every((target) => !CODE_EXPORT.test(target));
};

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

// `packages:` from pnpm-workspace.yaml, in order; a later entry wins, which is pnpm's own rule for a negation. Read by
// hand rather than with a YAML parser, since this file is on the path of checks that must run with nothing installed.
const WORKSPACE_FILE = "pnpm-workspace.yaml";
const LIST_ITEM = /^\s+-\s*["']?([^"'#\s]+)/;

const workspaceGlobs = (root) => {
    const globs = [];
    let listing = false;
    for (const line of readFileSync(join(root, WORKSPACE_FILE), "utf8").split("\n")) {
        if (/^packages:\s*$/.test(line)) {
            listing = true;
            continue;
        }
        // The next top-level key ends the list; comments and blank lines inside it do not.
        if (listing && /^\S/.test(line)) {
            break;
        }
        const item = listing ? LIST_ITEM.exec(line) : null;
        if (item !== null) {
            globs.push(item[1]);
        }
    }
    return globs;
};

// `*` spans one path segment, `**` any number: the subset the workspace file uses.
const globMatcher = (glob) =>
    new RegExp(
        `^${glob
            .split("/")
            .map((part) => (part === "**" ? "[^]*" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
            .join("/")}$`,
    );

// A repository holds manifests pnpm never links: a seed template, a test fixture, a store shell held out by a negated
// glob. Recording one as a package makes a file inside it seed a name turbo has never heard of, which fails the whole
// run; it belongs to the member that contains it instead.
const memberTest = (root) => {
    const rules = workspaceGlobs(root).map((glob) => ({ include: !glob.startsWith("!"), match: globMatcher(glob.replace(/^!/, "")) }));
    return (dir) => rules.reduce((member, rule) => (rule.match.test(dir) ? rule.include : member), false);
};

// Every workspace member's package.json, and the `workspace:` edges between them.
export const readWorkspaceGraph = (root) => {
    const isMember = memberTest(root);
    const packages = new Map(); // name -> { name, dir, deps: Set<string>, assetOnly: boolean }
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
            if (existsSync(manifest) && isMember(child)) {
                const pkg = JSON.parse(readFileSync(manifest, "utf8"));
                packages.set(pkg.name, { name: pkg.name, dir: child, deps: workspaceDeps(pkg), assetOnly: assetOnly(pkg) });
                byDir.push([child, pkg.name]);
            }
            walk(child, depth + 1);
        }
    })("", 0);
    // An empty graph means the globs were not understood, which would otherwise read as "nothing changed" and test
    // nothing at all.
    if (packages.size === 0) {
        throw new Error(`no workspace members matched the \`packages:\` globs in ${WORKSPACE_FILE}`);
    }
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
// depends on one. `global` set means a root file changed, so `affected` is every package. `throughAssets: false` is the
// closure a typecheck and a test run need: an asset-only package is affected itself but reaches no dependent, so an
// editor change stops at the share page and does not run the daemon's suites (see assetOnly above).
export const affectedBy = (graph, changed, { throughAssets = true } = {}) => {
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
        if (!throughAssets && graph.packages.get(name)?.assetOnly) {
            continue;
        }
        for (const consumer of graph.dependents.get(name) ?? []) {
            queue.push(consumer);
        }
    }
    return { global: undefined, seeds, affected };
};
