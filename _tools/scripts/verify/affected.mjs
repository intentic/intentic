#!/usr/bin/env node
// Computes which packages a push touched by walking the workspace dependency graph (`workspace:` specifiers), not by
// regex, so a moved or newly-dependent package is affected by construction. Not `turbo --affected`: this runs before
// install, and turbo lives in node_modules. The regexes below only cover what the graph can't answer.
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

// No usable base (first push, force-push, manual dispatch): treat every tracked path as changed rather than skip the
// jobs that decide what gets checked.
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

// Reads TREES/BUNDLES back from prepare-image-trees.sh instead of keeping a third copy; an unrecognized shape is
// reported, not silently skipped.
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

// ic two Rust crates (_sandbox/ic, _devices/win-launcher), not workspace packages.
// shims _site/site/public/scripts holds the connect/recreate one-liners bundled into the installer.
// recipes Dockerfiles and feature packs: the image's own contents, invisible to pnpm.
// assembly the shell scripts that build, verify and publish the artifacts.
// workflows the CI definition itself, an input to what CI produces.
// ci images _tools/ci-base and _tools/ci-desktop are Dockerfiles for the job containers; the second trigger is a docker
// probe the caller runs.
// Scripts matched by family directory (`_tools/scripts/desktop/`, etc.), not by name, so a new file in a family needs
// no new entry. `build-ic.sh` and `desktop-artifacts.sh` are named directly: genuinely shared across families.
const LOOSE = {
    desktop:
        /^(_sandbox\/ic\/|_site\/site\/public\/scripts\/|_tools\/ci-desktop\/|_tools\/scripts\/(desktop\/|build\/build-ic\.sh|lib\/desktop-artifacts\.sh)|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|nightly|release|windows-smoke)\.yml))/,
    ic: /^(_sandbox\/ic\/|_devices\/win-launcher\/|_site\/site\/public\/scripts\/)/,
    images: /^(_sandbox\/sandbox\/(Dockerfile|packs\/)|_tools\/scripts\/image\/|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|release)\.yml))/,
    platform: /^(_tools\/scripts\/platform\/|\.github\/(actions\/pnpm-setup\/|workflows\/(ci|release)\.yml))/,
    "ci-base-changed": /^_tools\/ci-base\//,
    // ci-desktop's FROM is ci-base's mutable `latest`; a ci-base change forces a rebuild here too.
    "ci-desktop-changed": /^_tools\/ci-(desktop|base)\//,
};

// Asserts each named script path still exists: a prefix that stops matching doesn't fail, it silently skips the job it
// triggers, so a rename or move fails here instead.
const NAMED_SCRIPT_PATHS = ["_tools/scripts/desktop", "_tools/scripts/image", "_tools/scripts/platform", "_tools/scripts/build/build-ic.sh", "_tools/scripts/lib/desktop-artifacts.sh"];
for (const named of NAMED_SCRIPT_PATHS) {
    if (!existsSync(join(root, named))) {
        console.error(`affected.mjs: a trigger names ${named}, which is not in this checkout — the job behind it would silently stop running`);
        process.exit(1);
    }
}
// Root package each trigger is about; the graph above reaches everything that depends on it.
const ROOTS = {
    desktop: ["@intentic/desktop-app", "@intentic/desktop-smoke", "@intentic/desktop-smoke-windows"],
    images: [...imagePayload],
    // Grouped under one trigger because one pipeline builds and ships them together, not by naming convention.
    platform: ["@intentic/api", "@intentic/web", "@intentic/ingress"],
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
