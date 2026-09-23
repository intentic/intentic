#!/usr/bin/env node
// Nothing in `_shared/` depends on another part (_shared/README.md): no `workspace:` dependency in a `_shared/*` manifest
// and no import in its files, type-only included, that lands in a member outside `_shared/` and the `_tools/` foundation.
// EXCEPTIONS holds each standing break with the reason it stands; keeping or cutting one is the owner's decision.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { importsOf } from "./lib/imports.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, subjectScope } from "./lib/repo.mjs";
import { readWorkspaceGraph } from "./lib/workspace-graph.mjs";

// "<package in _shared/> -> <package outside it>": why the edge stands.
const EXCEPTIONS = new Map([
    [
        "@intentic/api-contract -> @intentic/resources",
        "src/schemas.ts types a plan's resources with `ResourceType`, the deploy tool's own vocabulary, which _shared/README.md keeps in _deploy/ because three of its four dependents are deploy-internal; the manifest declares it as a runtime dependency for a type-only import. Needs an owner decision: move the type below both, or accept the edge.",
    ],
    [
        "@intentic/extension-ui -> @intentic/ui",
        "The extension UI kit is a curated slice of the app's design system: src/ re-exports _editor/ui, scripts/build.mjs compiles it from there, and the host's import map supplies the shell's own instances at runtime (extension-ui/README.md). Needs an owner decision: move the slice into _shared/, or accept the edge.",
    ],
]);

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/;
const MANIFEST = /^_shared\/[^/]+\/package\.json$/;
const subjects = subjectFiles("_shared/**").filter((path) => CODE.test(path) || MANIFEST.test(path));
if (subjects.length === 0) {
    finish([], ["shared-boundary: nothing under _shared/ to judge"]);
    process.exit(0);
}

const graph = readWorkspaceGraph(root);
const ownerOf = (path) => graph.byDir.find(([dir]) => path === dir || path.startsWith(`${dir}/`))?.[1];

// `_tools/` holds what every part needs (_tools/README.md), so `_shared/` may stand on it, but only on a member that
// itself stays inside the two: a harness that reaches the platform would be a way round the rule.
const inside = new Set([...graph.packages.values()].filter(({ dir }) => /^_(shared|tools)\//.test(dir)).map(({ name }) => name));
for (let leaving = [undefined]; leaving.length > 0;) {
    leaving = [...inside].filter((name) => {
        const { dir, deps } = graph.packages.get(name);
        return dir.startsWith("_tools/") && [...deps].some((dep) => !inside.has(dep));
    });
    for (const name of leaving) {
        inside.delete(name);
    }
}

// The member an import lands in, or the part it lands in when no member owns the path; undefined when it lands nowhere
// this rule is about (a third-party package, a root file, a path outside the checkout).
const targetOf = (path, specifier) => {
    if (!specifier.startsWith(".")) {
        const name = specifier
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/");
        return graph.packages.has(name) ? name : undefined;
    }
    const landed = posix.normalize(posix.join(posix.dirname(path), specifier));
    const part = /^(_[^/]+)\//.exec(landed)?.[1];
    return ownerOf(landed) ?? (part === "_shared" || part === "_tools" ? undefined : part);
};

const described = (target) => (graph.packages.has(target) ? `${target} (${graph.packages.get(target).dir})` : `${target}/`);
const findings = [];
const judgeImports = (path) => {
    const from = ownerOf(path) ?? "_shared";
    for (const { specifier, typeOnly, line } of importsOf(readFileSync(join(root, path), "utf8"))) {
        const target = targetOf(path, specifier);
        if (target !== undefined && target !== from && !inside.has(target)) {
            findings.push({
                pair: `${from} -> ${target}`,
                line: `${path}:${line} ${from} imports ${typeOnly ? "types from " : ""}${described(target)}`,
            });
        }
    }
};
const judgeManifest = (path) => {
    const from = ownerOf(path.slice(0, -"/package.json".length));
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    for (const dep of [...graph.packages.get(from).deps].filter((name) => !inside.has(name)).sort()) {
        const at = lines.findIndex((text) => text.includes(`"${dep}"`)) + 1;
        findings.push({ pair: `${from} -> ${dep}`, line: `${path}:${at} ${from} declares ${described(dep)}` });
    }
};
for (const path of subjects) {
    (MANIFEST.test(path) ? judgeManifest : judgeImports)(path);
}

// A scoped run read a few files, so an exception it saw nothing of is not evidence the break was mended.
const standing = new Set(findings.map(({ pair }) => pair));
for (const pair of subjectScope() === undefined ? EXCEPTIONS.keys() : []) {
    if (!standing.has(pair)) {
        console.log(
            `shared-boundary: EXCEPTIONS names ${pair}, which no longer stands: drop it when you next edit _tools/checks/shared-boundary.mjs`,
        );
    }
}

const members = [...graph.packages.values()].filter(({ dir }) => dir.startsWith("_shared/")).length;
finish(
    [
        [
            "A package in _shared/ depends on another part (_shared/README.md): move what it needs into _shared/, turn the edge around, or record the decision in EXCEPTIONS (_tools/checks/shared-boundary.mjs) with its reason",
            findings.filter(({ pair }) => !EXCEPTIONS.has(pair)).map(({ line }) => line),
        ],
    ],
    [
        `shared-boundary: ${subjects.length} files of ${members} packages in _shared/ read, nothing depends on a part outside _shared/ and the _tools/ foundation beyond ${EXCEPTIONS.size} standing exceptions`,
    ],
);
