#!/usr/bin/env node
// Checks that every sandbox image fragment (the core Dockerfile, its packs, any extension's *.Dockerfile) uses BuildKit
// cache mounts, since every overlay layer above the sandbox image rebuilds whenever it is published. Usage: node
// _tools/checks/build-cache-mounts.mjs.
// 1. A RUN that installs with apt must mount /var/cache/apt and /var/lib/apt/lists.
// 2. Nothing may delete /var/lib/apt/lists; a cache mount is never committed to the image anyway.
// 3. A RUN that compiles with cmake must mount ccache and route compilers through it via COMPILER_LAUNCHER.
// 4. A RUN that fetches from npm must mount ~/.npm, and nothing may clear it.
// 5. A cmake build must not use bare -j or --parallel: unbounded concurrency can exhaust the host.
// Covered too: the fragments the capability handlers carry as template literals (_sandbox/sandbox/src/capabilities/
// handlers/*.ts), which compose into an overlay exactly as a *.Dockerfile does and once shipped every rule broken.
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
// `apt install` too, as environment/apt-cache-rule.ts reads it: the same install, the same cache.
const APT_INSTALL = /\bapt(?:-get)?\s+(?:-\S+\s+)*install\b/;
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
    const handlers = join(root, "_sandbox/sandbox/src/capabilities/handlers");
    files.push(
        ...readdirSync(handlers)
            .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
            .map((entry) => join(handlers, entry)),
    );
    return files;
};

// What a file holds as Dockerfile text, each with the line it starts on. A *.Dockerfile is one piece; a handler's
// fragments are its template literals that carry a RUN. Their continuations are written `\\` in the source, which still
// ends a line with a backslash, so they read as one instruction here exactly as in the composed overlay.
const dockerfileTexts = (path, content) => {
    if (!path.endsWith(".ts")) {
        return [{ text: content, startLine: 1 }];
    }
    return [...content.matchAll(/`([^`]*)`/g)]
        .filter((match) => /^\s*RUN\s/m.test(match[1]))
        .map((match) => ({ text: match[1], startLine: content.slice(0, match.index).split("\n").length }));
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

// The rules, as data: a RUN breaks one when it does what `when` names and lacks `missing` (or carries `present`); a line
// outside a comment breaks a line rule when it carries `present`.
const RUN_RULES = [
    { when: APT_INSTALL, missing: APT_CACHE, message: "installs with apt but does not mount /var/cache/apt as a build cache" },
    { when: APT_INSTALL, missing: APT_LISTS, message: "installs with apt but does not mount /var/lib/apt/lists as a build cache" },
    { when: CMAKE_BUILD, missing: CCACHE, message: "compiles with cmake but does not mount /root/.cache/ccache as a build cache" },
    {
        when: CMAKE_BUILD,
        missing: COMPILER_LAUNCHER,
        message: "compiles with cmake but sets no -DCMAKE_<LANG>_COMPILER_LAUNCHER=ccache, so the ccache mount stays empty",
    },
    {
        when: CMAKE_BUILD,
        present: UNBOUNDED_CMAKE_PARALLELISM,
        message: "runs cmake with unbounded parallelism; give -j/--parallel an explicit CPU- and memory-bounded job count",
    },
    { when: NPM_FETCH, missing: NPM_CACHE, message: "fetches from npm but does not mount /root/.npm as a build cache" },
];
const LINE_RULES = [
    {
        present: DELETES_LISTS,
        message: "deletes /var/lib/apt/lists, which empties the cache mount the next build reads (and is a no-op now that the lists live in a mount)",
    },
    {
        present: DELETES_NPM_CACHE,
        message: "clears the npm cache, which empties the cache mount the next build reads (and is a no-op now that the cache lives in a mount)",
    },
];
const breaks = (rule, code) => rule.when.test(code) && (rule.missing === undefined ? rule.present.test(code) : !rule.missing.test(code));

// One piece of Dockerfile text, its findings reported against the file's own line numbers.
const checkText = (where, content, startLine) => {
    for (const { line, text } of instructions(content)) {
        // Comment lines inside a continued RUN body would otherwise let a rule be satisfied by prose.
        const code = text
            .split("\n")
            .filter((entry) => !entry.trim().startsWith("#"))
            .join("\n");
        if (/^\s*RUN\b/i.test(code)) {
            for (const rule of RUN_RULES.filter((candidate) => breaks(candidate, code))) {
                findings.push({ where, line: line + startLine - 1, message: rule.message });
            }
        }
    }
    for (const [index, line] of content.split("\n").entries()) {
        const broken = line.trim().startsWith("#") ? [] : LINE_RULES.filter((rule) => rule.present.test(line));
        for (const rule of broken) {
            findings.push({ where, line: index + startLine, message: rule.message });
        }
    }
};

for (const path of files) {
    const where = relative(root, path);
    for (const { text, startLine } of dockerfileTexts(path, readFileSync(path, "utf8"))) {
        checkText(where, text, startLine);
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
