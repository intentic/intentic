#!/usr/bin/env node
// Checks directory layout an agent has to navigate: ghosts (repaired, not reported), fan-out, near-duplicate sibling
// names, directory name vs npm name, basename collisions, and dead names. Fan-out and basename collisions are ratcheted
// via `_tools/checks/baselines/layout.json`, which may only shrink.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { finish } from "./lib/report.mjs";
import { EXCLUDED, packages, root, SKIP_DIRS, trackedFiles, untrackedFiles, writesBaselines } from "./lib/repo.mjs";

const BASELINE = join(root, "_tools/checks/baselines/layout.json");
const writeBaseline = process.argv.includes("--write-baseline");
const prune = process.argv.includes("--prune");
const MAX_FILES_PER_DIR = 30;

const tracked = trackedFiles();
// Direct file count and child directory set per directory; every rule below reads one of these two maps.
const filesIn = new Map();
const dirsIn = new Map();
for (const path of tracked) {
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
        if (dir === dirname(path)) {
            filesIn.set(dir, (filesIn.get(dir) ?? 0) + 1);
        }
        const parent = dirname(dir);
        (dirsIn.get(parent) ?? dirsIn.set(parent, new Set()).get(parent)).add(basename(dir));
    }
}

// A directory with no tracked file and nothing untracked-and-unignored beneath it. One whose only remaining content is
// a mount from the main checkout (an agent's worktree) is unjudgeable, not failed: it cannot remove an overlay's root.
const mountTargets = (() => {
    try {
        return readFileSync("/proc/self/mountinfo", "utf8")
            .split("\n")
            .map((line) => line.split(" ")[4])
            .filter((target) => target !== undefined);
    } catch {
        return []; // Not Linux, or no procfs: treats every ghost as judged, the stricter answer.
    }
})();
const isMirrored = (dir) => mountTargets.some((target) => target.startsWith(`${join(root, dir)}/`));

const childDirs = (dir) => {
    const full = join(root, dir);
    if (!existsSync(full)) {
        return [];
    }
    return readdirSync(full, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
        .map((entry) => (dir === "" ? entry.name : `${dir}/${entry.name}`));
};

const untracked = untrackedFiles();
const hasContent = (dir) => tracked.some((path) => path.startsWith(`${dir}/`)) || untracked.some((path) => path.startsWith(`${dir}/`));

const ghostCandidates = [
    ...childDirs("").flatMap((part) => [part, ...childDirs(part)]),
    ...packages.flatMap(({ name }) => childDirs(`${name}/src`)),
];
const ghosts = [];
const mirroredGhosts = [];
for (const dir of ghostCandidates) {
    if (hasContent(dir) || EXCLUDED.has(dir)) {
        continue;
    }
    (isMirrored(dir) ? mirroredGhosts : ghosts).push(dir);
}
// A ghost inside another ghost is one removal, not two.
const topGhosts = ghosts.filter((dir) => !ghosts.some((other) => dir.startsWith(`${other}/`)));

// Ghosts are removed, not reported: no commit can fix an untracked directory. Mirrored ghosts (worktree mounts of the
// main checkout) are left alone; `--prune` repairs and exits, for callers that run before an install.
const swept = [];
for (const dir of topGhosts) {
    rmSync(join(root, dir), { recursive: true, force: true });
    swept.push(dir);
}
if (swept.length > 0) {
    console.log(`layout: swept ${swept.length} ghost director${swept.length === 1 ? "y" : "ies"} a rename left behind: ${swept.join(", ")}`);
}
if (mirroredGhosts.length > 0) {
    console.log(`layout: ${mirroredGhosts.length} ghost director${mirroredGhosts.length === 1 ? "y is" : "ies are"} mirror mounts of a tree this worktree cannot fix; the primary checkout sweeps them`);
}
if (prune) {
    process.exit(0);
}

// Fan-out.
const srcDirs = (pkg) => {
    const out = [];
    const walk = (dir) => {
        for (const child of childDirs(dir)) {
            out.push(child);
            walk(child);
        }
    };
    if (existsSync(join(root, pkg, "src"))) {
        out.push(`${pkg}/src`);
        walk(`${pkg}/src`);
    }
    return out;
};
const fanOut = new Map();
for (const { name } of packages) {
    for (const dir of srcDirs(name)) {
        const count = filesIn.get(dir) ?? 0;
        if (count > MAX_FILES_PER_DIR) {
            fanOut.set(dir, count);
        }
    }
}

// Twins. Wire groups are discovered from contract files rather than hardcoded, so a moved contract package doesn't
// break this.
const wireGroups = new Set(
    tracked
        .filter((path) => /\/contracts\/[^/]+\.contract\.ts$/.test(path))
        .map((path) => basename(path).replace(/\.contract\.ts$/, "")),
);
// Pairs excluded for a reason other than the wire; each entry names a deliberate exception.
const TOLERATED_TWINS = new Map();
const oneApart = (a, b) => {
    if (a.length === b.length) {
        return a.split("").filter((c, i) => c !== b[i]).length === 1;
    }
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    return long.length - short.length === 1 && (long.startsWith(short) || long.endsWith(short));
};
const twins = [];
const seenTwins = new Set();
for (const [parent, children] of dirsIn) {
    const names = [...children].sort();
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            if (!oneApart(names[i], names[j])) {
                continue;
            }
            if (wireGroups.has(names[i]) && wireGroups.has(names[j])) {
                continue;
            }
            const key = `${parent}: ${names[i]}/${names[j]}`;
            seenTwins.add(key);
            if (!TOLERATED_TWINS.has(key)) {
                twins.push(key);
            }
        }
    }
}

// Directory name must equal the unscoped package name; the `ext-` prefix is a carve-out that lives in the npm name, not
// the path.
const nameMismatches = packages.flatMap(({ name, pkg }) => {
    const unscoped = String(pkg.name).replace(/^@[^/]+\//, "");
    const expected = name.startsWith("_extensions/") ? unscoped.replace(/^ext-/, "") : unscoped;
    return basename(name) === expected ? [] : [`${name} is package ${pkg.name}: the directory should be ${dirname(name)}/${expected}`];
});

// Basename collisions within one package; exemptions are names whose job is to repeat (a barrel, invariant.ts, a
// manifest, a route/handler file, a test).
const COLLISION_OK = /^(index\.ts|invariant\.ts|README\.md|package\.json|tsconfig.*\.json|vitest\.config\.ts)$|\.(routes|contract|handler|test|spec)\.[cm]?tsx?$/;
const collisions = new Map();
for (const { name } of packages) {
    const seen = new Map();
    for (const path of tracked) {
        if (!path.startsWith(`${name}/`)) {
            continue;
        }
        const file = basename(path);
        if (COLLISION_OK.test(file)) {
            continue;
        }
        // Case-insensitive: two files differing only by case are one to TypeScript (TS1149) on some filesystems.
        const key = file.toLowerCase();
        (seen.get(key) ?? seen.set(key, []).get(key)).push(path);
    }
    const clashing = [...seen.values()].filter((paths) => paths.length > 1);
    if (clashing.length > 0) {
        collisions.set(name, clashing.length);
    }
}

// Dead names this repo removed. DEAD_NAME_OK exempts places where the string names somebody else's tree (a generated or
// documented project, a fixture), not this one.
const DEAD_NAMES = [
    { pattern: /(^|[^\w.-])_computers\//, why: "the part is _devices/" },
    // `_apps/` and `_libs/` are still valid names outside this repo (generated projects, docs, fixtures), so only the
    // qualified `intentic/_apps/` spelling is flagged.
    { pattern: /intentic\/_apps\//, why: "this repo's own _apps/ was removed on 2026-08-09" },
    { pattern: /intentic\/_libs\//, why: "this repo's own _libs/ was removed on 2026-08-09" },
    // Packages that moved to `_shared/`; names are unambiguous (no generated project uses them), so matched bare.
    { pattern: /_sandbox\/(sandbox-contract|sandbox-openapi|sandbox-run|extension-api|extension-manifest|connector-runtime|registry|workspace-ignore)\b/, why: "moved to _shared/" },
    { pattern: /_editor\/extension-ui\b/, why: "moved to _shared/extension-ui" },
    { pattern: /_platform\/(api-contract|capability-catalog)\b/, why: "moved to _shared/" },
    { pattern: /_sandbox\/issue-widget\b/, why: "the directory is _sandbox/issue-sdk, after its npm name" },
    // One npm scope for the whole repo; the other two only ever named a CI job, not a package.
    { pattern: /@intentic-app\//, why: "every package is @intentic/*" },
    { pattern: /@intentic-dev\//, why: "every package is @intentic/*" },
];
const DEAD_NAME_OK = new Map([
    // Fixtures whose stand-in repo is also named intentic, indistinguishable by the qualified pattern.
    ["_sandbox/sandbox/src/panels/panel-upstream.test.ts", "fixture: a workspace repo named intentic with an _apps/ instance"],
    ["_extensions/documentation/src/brief.test.ts", "fixture: a workspace repo named intentic with a _libs/ package"],
    ["_tools/nav/baselines/", "recorded measurements of a tree that had those names"],
    ["_tools/checks/layout.mjs", "this file: the patterns above are the rule"],
    ["docs/audits/", "an audit describes the tree as it was"],
]);
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue|json|jsonc|json5|md|ya?ml|sh|bash|toml|astro|css|html|txt|Dockerfile)$|(^|\/)(Dockerfile|[A-Z]+)$/;
const deadNames = [];
for (const path of tracked) {
    if (!TEXT.test(path) || [...DEAD_NAME_OK.keys()].some((prefix) => path.startsWith(prefix))) {
        continue;
    }
    let lines;
    try {
        lines = readFileSync(join(root, path), "utf8").split("\n");
    } catch {
        continue; // a symlink to nowhere, or a path removed since `ls-files` answered
    }
    for (const [at, line] of lines.entries()) {
        const dead = DEAD_NAMES.find(({ pattern }) => pattern.test(line));
        if (dead !== undefined) {
            deadNames.push(`${path}:${at + 1}  ${dead.why}: ${line.trim().slice(0, 100)}`);
        }
    }
}

// The two ratchets.
const asObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
if (writeBaseline) {
    writeFileSync(BASELINE, `${JSON.stringify({ fanOut: asObject(fanOut), collisions: asObject(collisions) }, null, 4)}\n`);
    console.log(`layout: baseline written, ${fanOut.size} over-full directories and ${collisions.size} packages with colliding basenames`);
    process.exit(0);
}
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { fanOut: {}, collisions: {} };

// A ratcheted rule fails only on growth; an entry the tree has beaten is tightened to what it now has (or dropped, at
// zero) instead of failing.
const ratchet = (found, allowed, describe) => {
    const grown = [...found]
        .filter(([key, count]) => count > (allowed[key] ?? 0))
        .map(([key, count]) => `${describe(key, count)}${allowed[key] === undefined ? "" : `, the baseline allows ${allowed[key]}`}`);
    const tightened = [];
    const next = { ...allowed };
    for (const [key, count] of Object.entries(allowed)) {
        const now = found.get(key) ?? 0;
        if (now < count) {
            tightened.push(`${key}: ${count} → ${now}`);
            if (now === 0) {
                delete next[key];
            } else {
                next[key] = now;
            }
        }
    }
    return [grown, tightened, next];
};
const [fanOutGrown, fanOutTightened, fanOutNext] = ratchet(fanOut, baseline.fanOut ?? {}, (dir, count) => `${dir}: ${count} files`);
const [collisionsGrown, collisionsTightened, collisionsNext] = ratchet(collisions, baseline.collisions ?? {}, (pkg, count) => `${pkg}: ${count} colliding basename(s)`);
const tightened = [...fanOutTightened, ...collisionsTightened];
if (tightened.length > 0) {
    if (writesBaselines()) {
        writeFileSync(BASELINE, `${JSON.stringify({ fanOut: asObject(new Map(Object.entries(fanOutNext))), collisions: asObject(new Map(Object.entries(collisionsNext))) }, null, 4)}\n`);
        console.log(`layout: tightened _tools/checks/baselines/layout.json to what the tree has (${tightened.join(", ")}); it rides the next commit`);
    } else {
        console.log(`layout: the tree beats its baseline (${tightened.join(", ")}); the checkout that commits tightens _tools/checks/baselines/layout.json on its next run`);
    }
}
const twinsRetired = [...TOLERATED_TWINS.keys()].filter((key) => !seenTwins.has(key));
if (twinsRetired.length > 0) {
    console.log(`layout: TOLERATED_TWINS names ${twinsRetired.join(", ")}, no longer a pair: drop the entry when you next edit _tools/checks/layout.mjs`);
}

finish(
    [
        [
            `these directories hold more than ${MAX_FILES_PER_DIR} files, so listing one costs an agent a page it has to read before it can act\n` +
                "  split by what the files DO (see docs/audits/directory-structure-audit.md), or lower the entry in _tools/checks/baselines/layout.json",
            fanOutGrown,
        ],
        [
            "these sibling directories differ by one character, so neither listing nor a guessed path can tell them apart\n" +
                "  rename one, or — if both names are wire groups — the pair is vocabulary and belongs in TOLERATED_TWINS with its reason",
            twins,
        ],
        ["a package's directory name must be its npm name without the scope (ARCHITECTURE.md, Conventions)", nameMismatches],
        [
            "these packages hold two files with the same name, so a guessed path lands on the wrong one\n" +
                "  rename by what each one does, or lower the entry in _tools/checks/baselines/layout.json",
            collisionsGrown,
        ],
        [
            "these lines name a directory this repository removed, which is where agents keep learning to type it\n" +
                "  point them at the real path (see DEAD_NAME_OK in _tools/checks/layout.mjs for the mentions that are about somebody else's tree)",
            deadNames,
        ],
    ],
    [
        `${ghostCandidates.length} directories at part, package and module level: no ghosts${swept.length > 0 ? ` (${swept.length} swept)` : ""}${
            mirroredGhosts.length > 0 ? ` (${mirroredGhosts.length} unjudgeable here: mirror mounts of a tree this worktree cannot fix)` : ""}`,
        `${packages.length} packages: every directory named after its package, no new over-full directory, no new colliding basename, no twin siblings outside the wire's own vocabulary`,
        `${tracked.length} tracked files: no dead directory name`,
    ],
);
