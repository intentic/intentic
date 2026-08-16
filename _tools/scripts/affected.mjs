#!/usr/bin/env node
/* Which parts of this repository a push actually touched — computed from the workspace dependency graph
 * rather than asserted by a regex.
 *
 *   node _tools/scripts/affected.mjs <base-sha> <head-sha>          # GitHub job-output lines on stdout
 *   node _tools/scripts/affected.mjs <base-sha> <head-sha> --explain # …and the reasoning on stderr
 *
 * WHAT THIS REPLACES, AND WHY. ci.yml's `changes` job used to answer this with five hand-written path
 * regexes, two of which rested on a claim no machine checked:
 *
 *     # The three groups NOT listed (_editor, _platform, _site) hold no dependency of any image-bound
 *     # package (checked against the four apps' workspace: deps); re-check that claim when moving a package
 *     # between groups.
 *
 * A regex that stops matching does not fail — it SKIPS, and a skipped check reports exactly like a passing
 * one. The file recorded that happening: "hand-enumerating subdirs is how iq/lsp/_extensions silently fell
 * out of the trigger last time". Across 84 packages changing daily, "re-check that claim when moving a
 * package" is a note, not a control.
 *
 * The dependency graph is already written down — in every package.json's `workspace:` specifiers — and it is
 * what turbo itself reads. So this walks that graph instead: changed files → the packages that contain them →
 * every package that transitively depends on one of those. A package added, moved between groups, or given a
 * new dependency is then correct by construction, with nothing to remember.
 *
 * NOT `turbo --affected`, which answers the same question authoritatively, for one reason: the `changes` job
 * deliberately runs BEFORE any install (it is ~23 seconds and it is a DAG root that gates the whole pipeline),
 * and turbo lives in node_modules. Putting a 2m21s-3m43s frozen-lockfile install on that root to ask a
 * question the manifests already answer is the wrong trade. This reads the same manifests turbo reads, with
 * node and git and nothing else — the same reasoning that has prepass.mjs line-scanning pnpm-lock.yaml rather
 * than importing a YAML parser it cannot have yet.
 *
 * THE REGEXES THAT REMAIN ARE THE ONES A PACKAGE GRAPH CANNOT ANSWER, and they are listed together at the
 * bottom of this file so the distinction stays visible: a Rust crate that is not a workspace package, an image
 * recipe, the shell scripts that assemble artifacts, the workflow files themselves. Those are real inputs with
 * no manifest edge. What they are NOT any more is the answer to "which packages does this reach", which is the
 * part that kept going quietly wrong.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [base, head, ...flags] = process.argv.slice(2);
const explain = flags.includes("--explain");
if (!head) {
    console.error("usage: affected.mjs <base-sha> <head-sha> [--explain]");
    process.exit(2);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const note = (line) => explain && console.error(line);

/* ── the changed paths ────────────────────────────────────────────────────────────────────────────────────
 * A first push to a branch, a force-push, or a manual dispatch has no usable base. Treat everything as
 * changed rather than silently skipping the jobs that decide whether anything is checked at all — the same
 * fallback the shell block here used to carry, and the same zero-SHA case. */
const usable = base && !/^0+$/.test(base) && (() => {
    try {
        git("cat-file", "-e", `${base}^{commit}`);
        return true;
    } catch {
        return false;
    }
})();
const changed = (usable ? git("diff", "--name-only", base, head) : git("ls-files")).split("\n").filter(Boolean);
note(usable ? `base ${base} → head ${head}: ${changed.length} changed paths` : `no usable base (${base}) — treating every tracked path as changed`);

/* ── the workspace graph ──────────────────────────────────────────────────────────────────────────────────
 * Every package.json outside node_modules, and the `workspace:` edges between them. Dev and peer edges count
 * as much as runtime ones: @intentic/share-view declares the web app as a devDependency and compiles its
 * SOURCE into its own bundle, which is a real edge that a runtime-only walk would miss. */
const packages = new Map(); // name -> { name, dir, deps: Set<string> }
const byDir = []; // [dir, name], longest dir first
const WORKSPACE_DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
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
            const deps = new Set();
            for (const field of WORKSPACE_DEP_FIELDS) {
                for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
                    if (typeof spec === "string" && spec.startsWith("workspace:")) {
                        deps.add(name);
                    }
                }
            }
            packages.set(pkg.name, { name: pkg.name, dir: child, deps });
            byDir.push([child, pkg.name]);
        }
        walk(child, depth + 1);
    }
})("", 0);
byDir.sort((a, b) => b[0].length - a[0].length);
note(`workspace: ${packages.size} packages`);

// dependency -> the packages that declare it, for propagating a change upward to its consumers.
const dependents = new Map();
for (const pkg of packages.values()) {
    for (const dep of pkg.deps) {
        (dependents.get(dep) ?? dependents.set(dep, new Set()).get(dep)).add(pkg.name);
    }
}

/* ── the affected set ─────────────────────────────────────────────────────────────────────────────────────
 * ROOT FILES INVALIDATE EVERYTHING, and they have to be named because they belong to no package: the lockfile
 * and the workspace manifest change what every install resolves, turbo.json changes every task hash, and the
 * root package.json carries the engines and packageManager pins the whole fleet runs on. */
const GLOBAL = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "package.json", "tsconfig.libs.json"]);
const globalHit = changed.find((path) => GLOBAL.has(path));

const affected = new Set();
if (globalHit) {
    note(`${globalHit} changed — every package is affected`);
    for (const name of packages.keys()) {
        affected.add(name);
    }
} else {
    const seeds = new Set();
    for (const path of changed) {
        const owner = byDir.find(([dir]) => path === dir || path.startsWith(`${dir}/`));
        if (owner) {
            seeds.add(owner[1]);
        }
    }
    note(`directly changed packages (${seeds.size}): ${[...seeds].sort().join(", ") || "none"}`);
    // Breadth-first up the reverse edges — a package is affected when anything it depends on is.
    const queue = [...seeds];
    while (queue.length > 0) {
        const name = queue.pop();
        if (affected.has(name)) {
            continue;
        }
        affected.add(name);
        for (const consumer of dependents.get(name) ?? []) {
            queue.push(consumer);
        }
    }
    note(`affected including dependents (${affected.size}): ${[...affected].sort().join(", ") || "none"}`);
}

/* ── the image payload, read from the script that builds it ───────────────────────────────────────────────
 * prepare-image-trees.sh already writes this set down once and derives its own turbo filter from it, with a
 * comment explaining that keeping a third list beside those two is how an extension joined the payload twice
 * without the filter noticing. ci.yml's `images` regex WAS that third list. Reading the two variables back is
 * what keeps this from becoming a fourth — and a shape this stops recognizing is reported as drift rather
 * than passed over in silence, the same contract prepass.mjs's lockfile scanner holds itself to. */
const payloadScript = readFileSync(join(root, "_tools/scripts/prepare-image-trees.sh"), "utf8");
const treesBlock = payloadScript.match(/^TREES="\n([\s\S]*?)^"/m);
const bundlesLine = payloadScript.match(/^BUNDLES="([^"]*)"/m);
if (!treesBlock || !bundlesLine) {
    console.error("affected.mjs: cannot read TREES/BUNDLES out of _tools/scripts/prepare-image-trees.sh — the shape changed, so the `images` trigger can no longer be derived from it");
    process.exit(1);
}
const imagePayload = new Set([
    ...treesBlock[1].split("\n").map((line) => line.split(":")[0].trim()).filter(Boolean),
    ...bundlesLine[1].split(/\s+/).filter(Boolean).map((ext) => `@intentic/ext-${ext}`),
]);
for (const name of imagePayload) {
    if (!packages.has(name)) {
        console.error(`affected.mjs: prepare-image-trees.sh names ${name}, which is not a workspace package`);
        process.exit(1);
    }
}
note(`image payload (${imagePayload.size}): ${[...imagePayload].sort().join(", ")}`);

/* ── what the graph cannot answer ─────────────────────────────────────────────────────────────────────────
 * Everything below is a real input with NO manifest edge, so it stays a path rule — and they are together
 * here rather than scattered, because the whole point of this file is that the package closure above is
 * computed and this list is the small remainder that is not.
 *
 *   ic          a Rust crate (_sandbox/ic/Cargo.toml), not a workspace package at all.
 *   shims       _site/site/public/scripts holds the connect/recreate one-liners. They are BUNDLED into the
 *               desktop installer by stage-desktop-scripts.sh — an input to the desktop build with no
 *               package edge, and deliberately narrower than "the site package changed", which would drag
 *               every marketing copy edit into a Tauri build.
 *   recipes     Dockerfiles and feature packs: the image's own contents, invisible to pnpm.
 *   assembly    the shell scripts that build, verify and publish the artifacts.
 *   workflows   the CI definition itself, which is an input to what CI produces.
 *   ci images   _tools/ci-base and _tools/ci-desktop are Dockerfiles for the containers the JOBS run in —
 *               nothing in the workspace depends on them, and their second trigger ("the tag is not in the
 *               registry at all") is a docker probe the caller runs, because it needs a credential this
 *               script has no business holding. So they are answered here as PATHS only, and ci.yml ORs each
 *               with its probe. */
const LOOSE = {
    desktop: /^(_sandbox\/ic\/|_site\/site\/public\/scripts\/|_tools\/ci-desktop\/|_tools\/scripts\/(build-desktop|build-ic|verify-desktop-bundle|verify-desktop-install|stage-desktop-scripts|desktop-artifacts)\.sh|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|nightly|release|windows-smoke)\.yml))/,
    ic: /^(_sandbox\/ic\/|_site\/site\/public\/scripts\/)/,
    images: /^(_sandbox\/sandbox\/(Dockerfile|packs\/)|_tools\/scripts\/(prepare-image-trees|publish-images|compose-image-dockerfile|merge-image-manifests|promote-image-tag)\.(sh|mjs)|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|release)\.yml))/,
    platform: /^(_tools\/scripts\/(docker-release|deploy-platform)\.sh|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|release)\.yml))/,
    "ci-base-changed": /^_tools\/ci-base\//,
    // Its FROM is ci-base's mutable `latest`, so a ci-base bump has to rebuild this image too.
    "ci-desktop-changed": /^_tools\/ci-(desktop|base)\//,
};

// The package each trigger is really about. Everything these depend on reaches them through the graph above.
const ROOTS = {
    desktop: ["@intentic/desktop-app", "@intentic/desktop-smoke", "@intentic/desktop-smoke-windows"],
    images: [...imagePayload],
    platform: ["@intentic-app/api", "@intentic-app/web"],
};
for (const [trigger, names] of Object.entries(ROOTS)) {
    for (const name of names) {
        if (!packages.has(name)) {
            console.error(`affected.mjs: the \`${trigger}\` trigger names ${name}, which is not a workspace package`);
            process.exit(1);
        }
    }
}

// Driven off LOOSE rather than a list of its own, so adding a trigger is one entry and not two.
const answers = {};
for (const trigger of Object.keys(LOOSE)) {
    const viaGraph = (ROOTS[trigger] ?? []).filter((name) => affected.has(name));
    const viaPath = changed.filter((path) => LOOSE[trigger].test(path));
    answers[trigger] = viaGraph.length > 0 || viaPath.length > 0;
    note(
        `${trigger}=${answers[trigger]}` +
            (viaGraph.length > 0 ? ` · packages: ${viaGraph.slice(0, 6).join(", ")}${viaGraph.length > 6 ? ` +${viaGraph.length - 6}` : ""}` : "") +
            (viaPath.length > 0 ? ` · paths: ${viaPath.slice(0, 4).join(", ")}${viaPath.length > 4 ? ` +${viaPath.length - 4}` : ""}` : ""),
    );
}

for (const [trigger, value] of Object.entries(answers)) {
    process.stdout.write(`${trigger}=${value}\n`);
}
