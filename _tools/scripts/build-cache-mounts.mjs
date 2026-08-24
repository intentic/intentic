#!/usr/bin/env node
/* THE GATE BEHIND THE SANDBOX IMAGE'S BUILD-CACHE CONTRACT.
 *
 *   node _tools/scripts/build-cache-mounts.mjs      # checks every sandbox image fragment, exits 1 on a breach
 *
 * WHY A GATE AND NOT A CONVENTION. An environment overlay is `FROM` the sandbox image, so publishing a new
 * sandbox image changes that image's digest and invalidates EVERY overlay layer above it. A sandbox therefore
 * re-installs its whole environment on every update, and the bill grows with each capability the owner adds —
 * one measured rebuild spent 19 minutes recompiling a CUDA llama.cpp and 14 more downloading 175MB of Debian
 * packages, none of whose recipes had changed. The layer miss itself is honest (the parent chain really did
 * change). Paying for the same bytes and the same object files again is not, and BuildKit cache mounts are how
 * a fragment stops doing it.
 *
 * That only works if EVERY fragment does it, which is why this is a check rather than advice in a README:
 * fragments are written months apart, by different people, in different repositories (a pack here, a connector
 * in an extension, a custom section written by an agent), and one that forgets the mounts silently reintroduces
 * the full download for everyone who enables it.
 *
 * The rules, and the failure each prevents:
 *
 *   1. A RUN that installs with apt MUST mount both /var/cache/apt and /var/lib/apt/lists.
 *      Without them the packages and the index are re-fetched on every rebuild.
 *   2. NOTHING may delete /var/lib/apt/lists.
 *      The classic `&& rm -rf /var/lib/apt/lists/*` is what keeps an unmounted image small, but against a cache
 *      mount it empties the cache the next build was going to read. It is also now pointless: a cache mount is
 *      not committed to the image, so the lists never reach a layer in the first place.
 *   3. A RUN that compiles with cmake MUST mount ccache AND route the compilers through it.
 *      A cache mount with no COMPILER_LAUNCHER is a mounted directory nothing writes to, which reads as
 *      covered and is the more expensive half of the bill: the CUDA pack is ~900 translation units.
 *   4. A RUN that fetches from npm MUST mount ~/.npm, and NOTHING may clear it.
 *      Same shape as apt, with the same twist: `npm cache clean --force` used to be mandatory here because
 *      cacache keeps the registry's already-gzipped tarballs, 420 MiB of them in the published image, for a
 *      cache nothing reads at runtime. A mount is never committed, so it keeps the image just as small AND
 *      keeps the tarballs for the next build; cleaning it now would only empty the mount.
 *   5. A cmake build MUST NOT use bare `-j` or `--parallel`.
 *      CMake forwards that to GNU Make as unlimited concurrency. The CUDA pack demonstrated the failure:
 *      hundreds of compiler processes exhausted a 20GB WSL guest plus 8GB swap and crashed the distro.
 *
 * Deliberately NOT checked: the core `Dockerfile`s of the platform's own services (api, web, ci-base, …). They
 * are separate images with separate bases and no overlay above them; the contract here is specifically about
 * what gets rebuilt when a SANDBOX image moves. See the build-cache header in _sandbox/sandbox/Dockerfile.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "@intentic/constants/node";

// Resolved, not counted back from this file, so moving this script does not silently point the check at the
// wrong tree — the same helper its sibling compose-image-dockerfile.mjs uses to find the packs it splices.
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

/* THE ENFORCED SURFACE: everything that ends up in a sandbox image or in an overlay on top of one. The core
 * Dockerfile and its feature packs by path (they are one image), and every `*.Dockerfile` under _extensions,
 * which is the fragment-file convention an extension's `contributes.environment.fragment` points at. Discovered
 * rather than listed, so a NEW extension's fragment is covered on the commit that adds it. */
const fragmentFiles = () => {
    const files = [join(root, "_sandbox/sandbox/Dockerfile")];
    const packs = join(root, "_sandbox/sandbox/packs");
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

/* Logical instructions, not lines: a `\`-continued RUN is one instruction, and the mount flags sit on its FIRST
 * line while the `apt-get install` this checks for is usually several lines down. Returns the joined text plus
 * the 1-based line the instruction started on, which is where a reader needs to be sent. */
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
