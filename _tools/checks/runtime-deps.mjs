#!/usr/bin/env node
// What leaves the repository runs from a production install: the image's trees are `pnpm deploy --prod`
// (prepare-image-trees.sh), and a published package is `npm install`ed, and neither carries a devDependency. A value
// import of one passes the build, the type check and every suite, all of which run in the development install, and
// fails the first time the shipped program loads it. On 2026-10-06 the daemon imported `ssh2`, declared only as a
// devDependency, and a sandbox rebuilt from that checkout crashed on every boot while its state pre-flight failed on the
// same import. So in every package a shipped unit carries that runs its own compiled output, a value import of a package
// names one of its production dependencies. A bundled package (vite, a build script) inlines what it imports, so it may
// import a devDependency; a type-only import erases.
import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { publishSet } from "../scripts/lib/packages.mjs";
import { allowedAt } from "./lib/allow.mjs";
import { importsOf } from "./lib/imports.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { configFor, excludesOf, git, root, subjectFiles, subjectScope, TEST_FILE } from "./lib/repo.mjs";
import { readWorkspaceGraph } from "./lib/workspace-graph.mjs";

const CHECK = "runtime-deps";
const PRODUCTION = ["dependencies", "optionalDependencies", "peerDependencies"];

const graph = readWorkspaceGraph(root);
const memberAt = new Map([...graph.packages.values()].map((member) => [member.dir, member]));
const manifestOf = (member) => JSON.parse(readFileSync(join(root, member.dir, "package.json"), "utf8"));

/* ---- what ships, and how it gets there ------------------------------------------------------------------- */

const units = new Map(); // package name -> where it ships
const ship = (name, where) => {
    if (name === undefined || !graph.packages.has(name)) {
        cannotMeasure(`${CHECK}: a list of what ships names a package that is not a workspace member (${where}); the list moved and this check needs updating`);
    }
    units.set(name, [...new Set([...(units.get(name) ?? []), where])]);
};
const image = readFileSync(join(root, "_tools/scripts/image/prepare-image-trees.sh"), "utf8");
const trees = /^TREES="([^"]*)"/m.exec(image)?.[1] ?? cannotMeasure(`${CHECK}: could not read TREES in prepare-image-trees.sh; its shape changed and this check needs updating`);
for (const entry of trees.split(/\s+/).filter((word) => word !== "")) {
    ship(entry.split(":")[0], "the sandbox image");
}
for (const dir of publishSet() ?? cannotMeasure(`${CHECK}: could not read PUB out of _tools/scripts/lib/packages.sh`)) {
    ship(memberAt.get(dir)?.name, "npm");
}

// A shipped package carries its production workspace dependencies into the same install, so they ship with it.
const shipped = new Map(); // package name -> the unit and the path that carries it
const carry = (name, via) => {
    if (shipped.has(name) || !graph.packages.has(name)) {
        return;
    }
    shipped.set(name, via);
    const manifest = manifestOf(graph.packages.get(name));
    for (const field of PRODUCTION) {
        for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
            if (String(spec).startsWith("workspace:")) {
                carry(dependency, { ...via, path: `${via.path} > ${dependency}` });
            }
        }
    }
};
for (const [name, where] of units) {
    carry(name, { where: where.join(" and "), path: name });
}

/* ---- the files each one runs, and what they import ------------------------------------------------------- */

// A bundler inlines its imports; only a package that runs what tsc emits (or its source as it is) resolves them where it
// ships. The emitting config is the build's first command's.
const BUNDLED = /\b(?:vite|esbuild|rollup|tsup|webpack|bun build)\b|\bnode\s/;
const runsOwnOutput = (build) => build === undefined || (/^(?:tsgo|tsc)\b/.test(build) && !BUNDLED.test(build));
const TEST_SUPPORT = /(?:^|\/)testing\.ts$|\.testing\.ts$/;
const SCRIPT = /\.(?:[cm]?[jt]s|vue)$/;
const BUILTIN = /^(?:node|bun|virtual):/;
const packageName = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

const scope = subjectScope();
const findings = [];
let packagesRead = 0;
let filesRead = 0;
for (const [name, via] of shipped) {
    const member = graph.packages.get(name);
    const manifest = manifestOf(member);
    const build = manifest.scripts?.build;
    if (!runsOwnOutput(build)) {
        continue;
    }
    const production = new Set(PRODUCTION.flatMap((field) => Object.keys(manifest[field] ?? {})));
    const devOnly = new Set(Object.keys(manifest.devDependencies ?? {}).filter((dependency) => !production.has(dependency)));
    if (devOnly.size === 0) {
        continue;
    }
    const config = join(root, member.dir, configFor(build?.split("&&")[0] ?? ""));
    const excluded = existsSync(config) ? excludesOf(config).map((glob) => glob.replace(/^\.\//, "")) : [];
    // A manifest in scope is a change to what every file of its package may import, so it brings them all.
    const listed =
        scope?.has(`${member.dir}/package.json`) === true
            ? (git("ls-files", "-z", `${member.dir}/src`) ?? "").split("\0").filter((path) => path !== "" && existsSync(join(root, path)))
            : subjectFiles(`${member.dir}/src`);
    packagesRead += 1;
    for (const path of listed) {
        const local = path.slice(member.dir.length + 1);
        if (!SCRIPT.test(path) || path.endsWith(".d.ts") || TEST_FILE.test(path) || TEST_SUPPORT.test(path) || excluded.some((glob) => matchesGlob(local, glob))) {
            continue;
        }
        filesRead += 1;
        const text = readFileSync(join(root, path), "utf8");
        const lines = text.split("\n");
        for (const { specifier, typeOnly, line } of importsOf(text)) {
            const dependency = packageName(specifier);
            if (typeOnly || BUILTIN.test(specifier) || !devOnly.has(dependency) || allowedAt(lines, line, CHECK)) {
                continue;
            }
            findings.push(`${path}:${line}  ${specifier}: ${name} declares ${dependency} only as a devDependency, and ${name} ships in ${via.where} (${via.path})`);
        }
    }
}

finish(
    [
        [
            `A package that ships imports a devDependency, which its production install does not carry: it builds and passes every test here, and fails the moment the shipped program loads it. Move the package to "dependencies", import only its types (\`import type\`), or, if that file never runs where it ships, say why with // allow(${CHECK}): <reason>`,
            findings,
        ],
    ],
    [`${CHECK}: ${filesRead} files in ${packagesRead} shipped packages with devDependencies read, every value import names a production dependency`],
);
