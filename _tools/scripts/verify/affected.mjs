#!/usr/bin/env node
/* Which parts of this repository a push actually touched: computed from the workspace dependency graph
 * rather than asserted by a regex.
 *
 *   node _tools/scripts/verify/affected.mjs <base-sha> <head-sha>          # GitHub job-output lines on stdout
 *   node _tools/scripts/verify/affected.mjs <base-sha> <head-sha> --explain # …and the reasoning on stderr
 *
 * WHAT THIS REPLACES, AND WHY. ci.yml's `changes` job used to answer this with five hand-written path
 * regexes, two of which rested on a claim no machine checked. A regex that stops matching does not fail: it
 * SKIPS, and a skipped check reports exactly like a passing one. Across 84 packages changing daily, "re-check
 * that claim when moving a package" is a note, not a control.
 *
 * The dependency graph is already written down, in every package.json's `workspace:` specifiers, and it is
 * what turbo itself reads. So this walks that graph instead (_tools/checks/lib/workspace-graph.mjs, the same
 * walk the turn-ending check uses over the working tree): changed files → the packages that contain them →
 * every package that transitively depends on one of those. A package added, moved between groups, or given a
 * new dependency is then correct by construction, with nothing to remember.
 *
 * NOT `turbo --affected`, which answers the same question authoritatively, for one reason: the `changes` job
 * deliberately runs BEFORE any install (it is ~23 seconds and it is a DAG root that gates the whole pipeline),
 * and turbo lives in node_modules. This reads the same manifests turbo reads, with node and git and nothing else.
 *
 * THE REGEXES THAT REMAIN ARE THE ONES A PACKAGE GRAPH CANNOT ANSWER, listed together at the bottom of this
 * file so the distinction stays visible: a Rust crate that is not a workspace package, an image recipe, the
 * shell scripts that assemble artifacts, the workflow files themselves. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { affectedBy, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";

const root = repoRoot(import.meta.url);
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
 * changed rather than silently skipping the jobs that decide whether anything is checked at all. */
const usable =
    base &&
    !/^0+$/.test(base) &&
    (() => {
        try {
            git("cat-file", "-e", `${base}^{commit}`);
            return true;
        } catch {
            return false;
        }
    })();
const changed = (usable ? git("diff", "--name-only", base, head) : git("ls-files")).split("\n").filter(Boolean);
note(usable ? `base ${base} → head ${head}: ${changed.length} changed paths` : `no usable base (${base}), treating every tracked path as changed`);

const graph = readWorkspaceGraph(root);
note(`workspace: ${graph.packages.size} packages`);
const { global, seeds, affected } = affectedBy(graph, changed);
if (global !== undefined) {
    note(`${global} changed: every package is affected`);
} else {
    note(`directly changed packages (${seeds.size}): ${[...seeds].sort().join(", ") || "none"}`);
    note(`affected including dependents (${affected.size}): ${[...affected].sort().join(", ") || "none"}`);
}

/* ── the image payload, read from the script that builds it ───────────────────────────────────────────────
 * prepare-image-trees.sh already writes this set down once and derives its own turbo filter from it. Reading
 * the two variables back is what keeps this from becoming a third list, and a shape this stops recognizing is
 * reported as drift rather than passed over in silence. */
const payloadScript = readFileSync(join(root, "_tools/scripts/image/prepare-image-trees.sh"), "utf8");
const treesBlock = payloadScript.match(/^TREES="\n([\s\S]*?)^"/m);
const bundlesLine = payloadScript.match(/^BUNDLES="([^"]*)"/m);
if (!treesBlock || !bundlesLine) {
    console.error(
        "affected.mjs: cannot read TREES/BUNDLES out of _tools/scripts/image/prepare-image-trees.sh, the shape changed, so the `images` trigger can no longer be derived from it",
    );
    process.exit(1);
}
const imagePayload = new Set([
    ...treesBlock[1]
        .split("\n")
        .map((line) => line.split(":")[0].trim())
        .filter(Boolean),
    ...bundlesLine[1]
        .split(/\s+/)
        .filter(Boolean)
        .map((ext) => `@intentic/ext-${ext}`),
]);
for (const name of imagePayload) {
    if (!graph.packages.has(name)) {
        console.error(`affected.mjs: prepare-image-trees.sh names ${name}, which is not a workspace package`);
        process.exit(1);
    }
}
note(`image payload (${imagePayload.size}): ${[...imagePayload].sort().join(", ")}`);

/* ── what the graph cannot answer ─────────────────────────────────────────────────────────────────────────
 *   ic          two Rust crates (_sandbox/ic, _devices/win-launcher), neither a workspace package at all.
 *   shims       _site/site/public/scripts holds the connect/recreate one-liners, bundled into the installer.
 *   recipes     Dockerfiles and feature packs: the image's own contents, invisible to pnpm.
 *   assembly    the shell scripts that build, verify and publish the artifacts.
 *   workflows   the CI definition itself, which is an input to what CI produces.
 *   ci images   _tools/ci-base and _tools/ci-desktop are Dockerfiles for the containers the JOBS run in; their
 *               second trigger ("the tag is not in the registry at all") is a docker probe the caller runs. */
/* THE MAINTAINER SCRIPTS ARE NAMED BY THEIR FAMILY DIRECTORY, not one by one. `_tools/scripts` is grouped by
 * what each script serves (`desktop/`, `image/`, `platform/`, …), so "did this push touch the desktop
 * assembly" is a directory prefix rather than a list of six file names that goes stale the day a seventh is
 * added — which is the same failure mode, one level down, that this whole file exists to remove. The two
 * exceptions are named because they are genuinely shared: `build/build-ic.sh` builds the CLI the installers
 * bundle, and `lib/desktop-artifacts.sh` decides what those artifacts are called. */
const LOOSE = {
    desktop:
        /^(_sandbox\/ic\/|_site\/site\/public\/scripts\/|_tools\/ci-desktop\/|_tools\/scripts\/(desktop\/|build\/build-ic\.sh|lib\/desktop-artifacts\.sh)|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|nightly|release|windows-smoke)\.yml))/,
    ic: /^(_sandbox\/ic\/|_devices\/win-launcher\/|_site\/site\/public\/scripts\/)/,
    images: /^(_sandbox\/sandbox\/(Dockerfile|packs\/)|_tools\/scripts\/image\/|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|release)\.yml))/,
    platform: /^(_tools\/scripts\/platform\/|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|release)\.yml))/,
    "ci-base-changed": /^_tools\/ci-base\//,
    // Its FROM is ci-base's mutable `latest`, so a ci-base bump has to rebuild this image too.
    "ci-desktop-changed": /^_tools\/ci-(desktop|base)\//,
};

/* AND THE DIRECTORIES THOSE NAME HAVE TO EXIST. A prefix that stops matching does not fail, it SKIPS, and a
 * skipped job reports exactly like a passing one — the argument at the top of this file, applied to the one
 * part of it a package graph cannot check. So each script path a trigger names is asserted on disk: renaming a
 * family, or moving a named file out of one, fails HERE rather than quietly switching a CI job off. */
const NAMED_SCRIPT_PATHS = ["_tools/scripts/desktop", "_tools/scripts/image", "_tools/scripts/platform", "_tools/scripts/build/build-ic.sh", "_tools/scripts/lib/desktop-artifacts.sh"];
for (const named of NAMED_SCRIPT_PATHS) {
    if (!existsSync(join(root, named))) {
        console.error(`affected.mjs: a trigger names ${named}, which is not in this checkout — the job behind it would silently stop running`);
        process.exit(1);
    }
}
// The package each trigger is really about. Everything these depend on reaches them through the graph above.
const ROOTS = {
    desktop: ["@intentic/desktop-app", "@intentic/desktop-smoke", "@intentic/desktop-smoke-windows"],
    images: [...imagePayload],
    // The edge rides this trigger even though it is `@intentic/`-namespaced rather than `@intentic-app/`: what
    // groups these three is that one pipeline builds and rolls them together, not what they are called.
    platform: ["@intentic-app/api", "@intentic-app/web", "@intentic/ingress"],
};
for (const [trigger, names] of Object.entries(ROOTS)) {
    for (const name of names) {
        if (!graph.packages.has(name)) {
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
        `${trigger}=${answers[trigger]}${
            viaGraph.length > 0 ? ` · packages: ${viaGraph.slice(0, 6).join(", ")}${viaGraph.length > 6 ? ` +${viaGraph.length - 6}` : ""}` : ""
        }${viaPath.length > 0 ? ` · paths: ${viaPath.slice(0, 4).join(", ")}${viaPath.length > 4 ? ` +${viaPath.length - 4}` : ""}` : ""}`,
    );
}
for (const [trigger, value] of Object.entries(answers)) {
    process.stdout.write(`${trigger}=${value}\n`);
}
