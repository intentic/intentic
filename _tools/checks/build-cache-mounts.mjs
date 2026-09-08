#!/usr/bin/env node
// Checks that every sandbox image fragment (the core Dockerfile, its packs, any extension's *.Dockerfile) uses BuildKit
// cache mounts, since every overlay layer above the sandbox image rebuilds whenever it is published. Usage: node
// _tools/checks/build-cache-mounts.mjs.
// 1. A RUN that installs with apt must mount /var/cache/apt and /var/lib/apt/lists.
// 2. Nothing may delete /var/lib/apt/lists; a cache mount is never committed to the image anyway.
// 3. A RUN that compiles with cmake must mount ccache and route compilers through it via COMPILER_LAUNCHER.
// 4. A RUN that fetches from npm must mount ~/.npm, and nothing may clear it.
// 5. A cmake build must not use bare -j or --parallel: unbounded concurrency can exhaust the host.
// Not checked: the platform's own service Dockerfiles (api, web, ci-base), separate images with no overlay above them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";

// Resolved via repoRoot, not counted back from this file, so moving the script cannot silently repoint it.
const root = repoRoot(import.meta.url);

const APT_CACHE = /--mount=type=cache,target=\/var\/cache\/apt\b/;
const APT_LISTS = /--mount=type=cache,target=\/var\/lib\/apt\/lists\b/;
const CCACHE = /--mount=type=cache,target=\/root\/\.cache\/ccache\b/;
const NPM_CACHE = /--mount=type=cache,target=\/root\/\.npm\b/;
const APT_INSTALL = /\bapt-get\s+(?:-\S+\s+)*install\b/;
const CMAKE_BUILD = /\bcmake\s+--build\b/;
const UNBOUNDED_CMAKE_PARALLELISM = /(?:^|\s)(?:-j|--parallel)(?=\s*(?:\\\s*\n\s*)?(?:--[a-z]|&&|;|$))/m;
const COMPILER_LAUNCHER = /-DCMAKE_(?:C|CXX|CUDA)_COMPILER_LAUNCHER=ccache\b/;
const NPM_FETCH = /\b(?:npm\s+(?:-\S+\s+)*install\b|npx\s)/;
const DELETES_LISTS = /rm\s+(?:-\S+\s+)*[^\n]*\/var\/lib\/apt\/lists/;
const DELETES_NPM_CACHE = /(?:rm\s+(?:-\S+\s+)*[^\n]*\/root\/\.npm\b|npm\s+cache\s+clean\b)/;

// Every Dockerfile fragment in a sandbox image or overlay: the core Dockerfile, its packs, and any *.Dockerfile under
// _extensions, discovered rather than listed so a new extension is covered automatically.
const fragmentFiles = () => {
    const files = [join(root, "_sandbox/sandbox/Dockerfile")];
    const packs = join(root, "_sandbox/sandbox/image-packs");
    files.push(
        ...readdirSync(packs)
            .filter((entry) => entry.endsWith(".Dockerfile"))
            .map((entry) => join(packs, entry)),
    );
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
                continue;
            }
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.name.endsWith(".Dockerfile")) {
                files.push(path);
            }
        }
    };
    const extensions = join(root, "_extensions");
    if (statSync(extensions, { throwIfNoEntry: false })?.isDirectory()) {
        walk(extensions);
    }
    return files;
};

// Logical instructions, not lines: a backslash-continued RUN is one instruction, since the mount flags sit on its first
// line while the command they cover may be several lines down.
const instructions = (content) => {
    const lines = content.split("\n");
    const found = [];
    let current;
    for (let at = 0; at < lines.length; at++) {
        const line = lines[at];
        const trimmed = line.trim();
        if (current === undefined) {
            if (trimmed === "" || trimmed.startsWith("#")) {
                continue;
            }
            current = { line: at + 1, text: line };
        } else {
            current.text += `\n${line}`;
        }
        if (!current.text.trimEnd().endsWith("\\")) {
            found.push(current);
            current = undefined;
        }
    }
    if (current !== undefined) {
        found.push(current);
    }
    return found;
};

const findings = [];
const files = fragmentFiles();

for (const path of files) {
    const where = relative(root, path);
    const content = readFileSync(path, "utf8");

    for (const { line, text } of instructions(content)) {
        // Comment lines inside a continued RUN body would otherwise let a rule be satisfied by prose.
        const code = text
            .split("\n")
            .filter((entry) => !entry.trim().startsWith("#"))
            .join("\n");
        if (!/^\s*RUN\b/i.test(code)) {
            continue;
        }
        if (APT_INSTALL.test(code)) {
            if (!APT_CACHE.test(code)) {
                findings.push({ where, line, message: "installs with apt but does not mount /var/cache/apt as a build cache" });
            }
            if (!APT_LISTS.test(code)) {
                findings.push({ where, line, message: "installs with apt but does not mount /var/lib/apt/lists as a build cache" });
            }
        }
        if (CMAKE_BUILD.test(code)) {
            if (!CCACHE.test(code)) {
                findings.push({ where, line, message: "compiles with cmake but does not mount /root/.cache/ccache as a build cache" });
            }
            if (!COMPILER_LAUNCHER.test(code)) {
                findings.push({
                    where,
                    line,
                    message: "compiles with cmake but sets no -DCMAKE_<LANG>_COMPILER_LAUNCHER=ccache, so the ccache mount stays empty",
                });
            }
            if (UNBOUNDED_CMAKE_PARALLELISM.test(code)) {
                findings.push({
                    where,
                    line,
                    message: "runs cmake with unbounded parallelism; give -j/--parallel an explicit CPU- and memory-bounded job count",
                });
            }
        }
        if (NPM_FETCH.test(code) && !NPM_CACHE.test(code)) {
            findings.push({ where, line, message: "fetches from npm but does not mount /root/.npm as a build cache" });
        }
    }

    for (const [at, line] of content.split("\n").entries()) {
        if (line.trim().startsWith("#")) {
            continue;
        }
        if (DELETES_LISTS.test(line)) {
            findings.push({
                where,
                line: at + 1,
                message:
                    "deletes /var/lib/apt/lists, which empties the cache mount the next build reads (and is a no-op now that the lists live in a mount)",
            });
        }
        if (DELETES_NPM_CACHE.test(line)) {
            findings.push({
                where,
                line: at + 1,
                message:
                    "clears the npm cache, which empties the cache mount the next build reads (and is a no-op now that the cache lives in a mount)",
            });
        }
    }
}

if (findings.length > 0) {
    for (const { where, line, message } of findings) {
        console.error(`${where}:${line}  ${message}`);
    }
    console.error(
        `\n${findings.length} breach(es) of the sandbox build-cache contract. Every overlay layer is rebuilt whenever the\n` +
            `sandbox image is published, so a fragment without these mounts re-downloads and recompiles on every update,\n` +
            `for every sandbox that enables it. The canonical shape is in _sandbox/sandbox/Dockerfile's build-cache header.`,
    );
    process.exit(1);
}

console.log(`${files.length} sandbox image fragment(s), build-cache contract held`);
