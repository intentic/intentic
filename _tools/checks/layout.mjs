#!/usr/bin/env node
// Checks directory layout an agent has to navigate: ghosts (repaired, not reported), fan-out, near-duplicate sibling
// names, directory name vs npm name, basename collisions, and dead names. Fan-out and basename collisions are ratcheted
// via `_tools/checks/baselines/layout-{fan-out,collisions}.json`, which may only shrink.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ADOPTING, allowOne, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { EXCLUDED, packages, root, SKIP_DIRS, trackedFiles, untrackedFiles } from "./lib/repo.mjs";

// One directory a change grew on purpose, recorded at what it holds; `` when the flag names nothing, which is an error.
const allow = process.argv.includes("--allow") ? (process.argv[process.argv.indexOf("--allow") + 1] ?? "") : undefined;
const prune = process.argv.includes("--prune");
const MAX_FILES_PER_DIR = 30;

// AN INDEX, NOT A PAGE. The fan-out rule measures SCROLLING: thirty modules whose roles you cannot guess is a listing a
// reader has to read before it can act. These directories hold one file per member of a set named somewhere else, and
// the file NAME is the whole address — an agent that wants the secrets contract opens `secrets.contract.ts` and never
// lists the directory. Their size tracks how many surfaces the product has, not what a reader pays for one.
//
// Recorded by NAME rather than by a number, because a number here is a treadmill nobody can get off. These three sat in
// the fan-out baseline and tripped the nightly tidy job on nine of its last eleven layout failures, always by one or two
// files, always for a surface somebody legitimately added: `schemas` was split from 52 entries to 41 across four commits
// in eleven days (bf01472822, 32e3663459, a7dff2bb68) and was back over on the twelfth. Splitting an index by domain
// invents a taxonomy the wire does not have, and the next contract lands at the top level anyway.
//
// An entry is retired the moment its directory drops under the limit, and refused outright if the directory is gone, so
// a rename cannot leave an exemption standing over nothing.
const INDEX_DIRS = new Map([
    ["_shared/sandbox-contract/src/contracts", "one *.contract.ts per wire group; the group list IS this directory"],
    ["_shared/sandbox-contract/src/schemas", "one module per wire group, named after it"],
    [
        "_sandbox/sandbox/src/capabilities/handlers",
        "one *.handler.ts per CapabilityKind; registry.ts is the total map, so a missing one is a compile error",
    ],
]);

// A file nobody reads to find their way around: an image, a font, a media clip. Both rules below exempt these, for one
// reason stated once — the cost they are about is a READING cost. Thirty modules in a directory is a page an agent
// scrolls before it can act; thirty PNGs is a directory nobody opens, that no search returns, and whose names are often
// a set joined ACROSS directories (`assets/product/x.png` beside `assets/product-light/x.png`), so renaming one to
// thin the count breaks the pairing the directory exists to express.
const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav)$/i;

const tracked = trackedFiles();
// Direct file count and child directory set per directory; every rule below reads one of these two maps. `filesIn`
// counts only what a reader reads — it feeds the fan-out rule and nothing else.
const filesIn = new Map();
const dirsIn = new Map();
for (const path of tracked) {
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
        if (dir === dirname(path) && !ASSET.test(path)) {
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

const ghostCandidates = [...childDirs("").flatMap((part) => [part, ...childDirs(part)]), ...packages.flatMap(({ name }) => childDirs(`${name}/src`))];
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
    console.log(
        `layout: ${mirroredGhosts.length} ghost director${mirroredGhosts.length === 1 ? "y is" : "ies are"} mirror mounts of a tree this worktree cannot fix; the primary checkout sweeps them`,
    );
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
        if (count > MAX_FILES_PER_DIR && !INDEX_DIRS.has(dir)) {
            fanOut.set(dir, count);
        }
    }
}
// An exemption that has stopped paying for itself. Gone is a failure (the entry now covers nothing, and would go on
// covering nothing silently through the rename that replaces it); merely under the limit is a notice, since a directory
// that has shrunk may well grow back before anyone edits this file.
const indexGone = [...INDEX_DIRS.keys()].filter((dir) => !existsSync(join(root, dir))).map((dir) => `${dir}: no such directory`);
const indexRetired = [...INDEX_DIRS.keys()].filter((dir) => existsSync(join(root, dir)) && (filesIn.get(dir) ?? 0) <= MAX_FILES_PER_DIR);

// Twins. Wire groups are discovered from contract files rather than hardcoded, so a moved contract package doesn't
// break this.
const wireGroups = new Set(
    tracked.filter((path) => /\/contracts\/[^/]+\.contract\.ts$/.test(path)).map((path) => basename(path).replace(/\.contract\.ts$/, "")),
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
const COLLISION_OK =
    /^(index\.ts|invariant\.ts|README\.md|package\.json|tsconfig.*\.json|bunfig\.toml)$|\.(routes|contract|handler|test|spec)\.[cm]?tsx?$/;
const collisions = new Map();
for (const { name } of packages) {
    const seen = new Map();
    for (const path of tracked) {
        if (!path.startsWith(`${name}/`)) {
            continue;
        }
        const file = basename(path);
        if (COLLISION_OK.test(file) || ASSET.test(file)) {
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
    {
        pattern:
            /_sandbox\/(sandbox-contract|sandbox-openapi|sandbox-run|extension-api|extension-manifest|connector-runtime|registry|workspace-ignore)\b/,
        why: "moved to _shared/",
    },
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
    ["_tools/nav/baselines/", "recorded measurements of a tree that had those names"],
    ["_tools/checks/layout.mjs", "this file: the patterns above are the rule"],
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
const RATCHETS = { fanOut: "layout-fan-out", collisions: "layout-collisions" };
if (allow !== undefined) {
    const found = fanOut.has(allow) ? "fanOut" : collisions.has(allow) ? "collisions" : undefined;
    if (found === undefined) {
        console.error(
            allow === "" || allow.startsWith("--")
                ? `layout: --allow needs the directory or package to record, e.g. --allow ${[...fanOut.keys(), ...collisions.keys()][0] ?? "_part/package/src/dir"}`
                : `layout: ${allow} is not over any limit, so there is nothing to record`,
        );
        process.exit(2);
    }
    const count = (found === "fanOut" ? fanOut : collisions).get(allow);
    allowOne(RATCHETS[found], allow, count);
    console.log(
        `layout: recorded ${allow} at ${count}; the entry rides your next commit, and the ratchet lowers it again on its own once the tree beats it`,
    );
    process.exit(0);
}
const overLimit = (name, found, describe) =>
    ratchet("layout", name, found).grown.map(({ key, count, allowed }) => `${describe(key, count)}${allowed === 0 ? "" : `, the baseline allows ${allowed}`}`);
const fanOutGrown = overLimit(RATCHETS.fanOut, fanOut, (dir, count) => `${dir}: ${count} files`);
const collisionsGrown = overLimit(RATCHETS.collisions, collisions, (pkg, count) => `${pkg}: ${count} colliding basename(s)`);
if (ADOPTING) {
    process.exit(0);
}
const twinsRetired = [...TOLERATED_TWINS.keys()].filter((key) => !seenTwins.has(key));
if (twinsRetired.length > 0) {
    console.log(
        `layout: TOLERATED_TWINS names ${twinsRetired.join(", ")}, no longer a pair: drop the entry when you next edit _tools/checks/layout.mjs`,
    );
}
if (indexRetired.length > 0) {
    console.log(
        `layout: INDEX_DIRS names ${indexRetired.join(", ")}, now under the limit on its own: drop the entry when you next edit _tools/checks/layout.mjs`,
    );
}

finish(
    [
        [
            `these directories hold more than ${MAX_FILES_PER_DIR} files a reader reads, so listing one costs an agent a page before it can act\n` +
                "  split by what the files DO, or, if splitting is the wrong answer here,\n" +
                "  record it: node _tools/checks/layout.mjs --allow <dir>",
            fanOutGrown,
        ],
        [
            "these sibling directories differ by one character, so neither listing nor a guessed path can tell them apart\n" +
                "  rename one, or — if both names are wire groups — the pair is vocabulary and belongs in TOLERATED_TWINS with its reason",
            twins,
        ],
        ["a package's directory name must be its npm name without the scope (docs/architecture/conventions.md)", nameMismatches],
        [
            "these packages hold two files with the same name, so a guessed path lands on the wrong one\n" +
                "  rename by what each one does, or, if both names are right, record it: node _tools/checks/layout.mjs --allow <package>",
            collisionsGrown,
        ],
        [
            "these lines name a directory this repository removed, which is where agents keep learning to type it\n" +
                "  point them at the real path (see DEAD_NAME_OK in _tools/checks/layout.mjs for the mentions that are about somebody else's tree)",
            deadNames,
        ],
        [
            "INDEX_DIRS exempts a directory that is not there, so the rule it relaxes is relaxed over nothing\n" +
                "  point the entry at the directory's new name, or drop it, in _tools/checks/layout.mjs",
            indexGone,
        ],
    ],
    [
        `${ghostCandidates.length} directories at part, package and module level: no ghosts${swept.length > 0 ? ` (${swept.length} swept)` : ""}${
            mirroredGhosts.length > 0 ? ` (${mirroredGhosts.length} unjudgeable here: mirror mounts of a tree this worktree cannot fix)` : ""
        }`,
        `${packages.length} packages: every directory named after its package, no new over-full directory, no new colliding basename, no twin siblings outside the wire's own vocabulary`,
        `${INDEX_DIRS.size} index directories exempt from fan-out by name, every one of them present and still over the limit`,
        `${tracked.length} tracked files: no dead directory name`,
    ],
);
