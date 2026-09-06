#!/usr/bin/env node
/* WHAT THE DIRECTORY TREE OWES AN AGENT THAT HAS TO FIND SOMETHING IN IT.
 *
 *   node _tools/checks/layout.mjs                  # every rule
 *   node _tools/checks/layout.mjs --prune          # delete the ghost directories instead of reporting them
 *   node _tools/checks/layout.mjs --write-baseline # adopt today's counts for the two ratcheted rules
 *
 * The measurement behind each rule is in docs/audits/directory-structure-audit.md, mined from 1,862 agent
 * conversations. The short version: an agent pays for structure in listings it cannot read, in names it
 * cannot tell apart, and in paths it guesses wrong. Six rules, each one a cost that was counted:
 *
 *   1. GHOSTS. A directory with zero tracked files still shows up in `ls`, still gets listed, still gets
 *      guessed at. Seventeen of them existed the day this was written, left behind by renames — build output
 *      of packages that had already moved. Nothing in git can remove them, so the rule names the directory
 *      and the command.
 *   2. FAN-OUT. A directory of 159 files answers a listing with 4,000 characters an agent has to read before
 *      it can do anything. 29 listings of `_editor/web` came back that big in one month.
 *   3. TWINS. `agent/` beside `agents/`: 84 sessions read both, most of them by accident. A pair like that is
 *      allowed only when both names are wire groups, because then the pair is the product's own vocabulary
 *      and the wire already forces both to exist.
 *   4. DIR = NAME. "A package's directory name is its unscoped npm name" is stated in ARCHITECTURE.md and was
 *      broken by 41 of 98 packages, which is how `@intentic/issue-sdk` came to live at `_sandbox/issue-widget`
 *      and be unfindable from either name.
 *   5. BASENAME COLLISIONS. Five files called `agent.ts`, eighteen called `host.ts`. An agent that guesses a
 *      path picks the wrong one of them; a human reading a diff cannot tell which was meant.
 *   6. DEAD NAMES. `_apps/` and `_libs/` were removed on 2026-08-09 and were still being typed 89 times in the
 *      month after. A dead name inside the tree is what keeps teaching them.
 *
 * TWO OF THE SIX ARE RATCHETED (fan-out, basename collisions) because they cannot be brought to zero in one
 * change: `_tools/checks/baselines/layout.json` records today's violators, an entry may only shrink or be
 * deleted, and anything not listed fails on its first offence. The other four are absolute. */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { finish } from "./lib/report.mjs";
import { EXCLUDED, SKIP_DIRS, packages, root, trackedFiles } from "./lib/repo.mjs";

const BASELINE = join(root, "_tools/checks/baselines/layout.json");
const writeBaseline = process.argv.includes("--write-baseline");
const prune = process.argv.includes("--prune");
const MAX_FILES_PER_DIR = 30;

const tracked = trackedFiles();
// Direct files per directory, and the child directories of each: the two questions every rule below asks.
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

/* ── 1. Ghosts ─────────────────────────────────────────────────────────────────────────────────────────────
 * A directory git has never heard of, at a depth where an agent orienting itself will see it: the parts and
 * their packages, and the modules inside a package's src/.
 *
 * THE ONE PLACE THIS CANNOT JUDGE is an agent's own worktree. A worktree checks out tracked files only, and
 * the isolation layer then mounts the main checkout's node_modules/dist over the same paths — which
 * re-creates the ghost's directory here, out of mounts that cannot be removed from inside the turn (removing
 * an overlay's root is what @intentic/constants/mirror-roots exists to forbid). So a ghost whose remaining
 * content is a live mount is reported as unjudgeable rather than failed: the tree that can fix it is the one
 * without the mounts, and that is where the rule bites. */
const mountTargets = (() => {
    try {
        return readFileSync("/proc/self/mountinfo", "utf8")
            .split("\n")
            .map((line) => line.split(" ")[4])
            .filter((target) => target !== undefined);
    } catch {
        return []; // not Linux, or no procfs: every ghost is then judged, which is the stricter answer
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

const hasTracked = (dir) => tracked.some((path) => path.startsWith(`${dir}/`));

const ghostCandidates = [
    ...childDirs("").flatMap((part) => [part, ...childDirs(part)]),
    ...packages.flatMap(({ name }) => childDirs(`${name}/src`)),
];
const ghosts = [];
const mirroredGhosts = [];
for (const dir of ghostCandidates) {
    if (hasTracked(dir) || EXCLUDED.has(dir)) {
        continue;
    }
    (isMirrored(dir) ? mirroredGhosts : ghosts).push(dir);
}
// A ghost inside another ghost is one removal, not two.
const topGhosts = ghosts.filter((dir) => !ghosts.some((other) => dir.startsWith(`${other}/`)));

/* --prune: DELETE the ghosts rather than report them. Ghosts are untracked by definition, so no commit can
 * remove one — they accumulate wherever a checkout outlives a rename, which is exactly CI's persistent runner
 * workspaces (checkout there is `clean: false` so a warm node_modules survives, and a moved package's old
 * directory keeps its own node_modules/dist forever). Preflight prunes before it checks. Mirrored ghosts stay
 * untouched: their content is a mount of the main checkout, and removing a mount's root is what
 * @intentic/constants/mirror-roots exists to forbid. */
if (prune) {
    for (const dir of topGhosts) {
        rmSync(join(root, dir), { recursive: true, force: true });
    }
    console.log(
        `layout: pruned ${topGhosts.length} ghost director${topGhosts.length === 1 ? "y" : "ies"}${topGhosts.length > 0 ? `: ${topGhosts.join(", ")}` : "" 
            }${mirroredGhosts.length > 0 ? ` (${mirroredGhosts.length} left: mirror mounts of a tree this worktree cannot fix)` : ""}`,
    );
    process.exit(0);
}

/* ── 2. Fan-out ───────────────────────────────────────────────────────────────────────────────────────────*/
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

/* ── 3. Twins ─────────────────────────────────────────────────────────────────────────────────────────────
 * The wire groups are DISCOVERED from the contract files rather than listed, so this keeps working when the
 * contract package moves: a name the wire itself carries is vocabulary the tree is entitled to mirror. */
const wireGroups = new Set(
    tracked
        .filter((path) => /\/contracts\/[^/]+\.contract\.ts$/.test(path))
        .map((path) => basename(path).replace(/\.contract\.ts$/, "")),
);
// Pairs kept for a reason that is not the wire's. Each entry is a decision, not an oversight.
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

/* ── 4. Directory name = unscoped package name ────────────────────────────────────────────────────────────
 * The `ext-` prefix is the one carve-out: it carries the extension lint boundary and the extension-host's
 * builtin list, so it lives in the npm name and not in the path. */
const nameMismatches = packages.flatMap(({ name, pkg }) => {
    const unscoped = String(pkg.name).replace(/^@[^/]+\//, "");
    const expected = name.startsWith("_extensions/") ? unscoped.replace(/^ext-/, "") : unscoped;
    return basename(name) === expected ? [] : [`${name} is package ${pkg.name}: the directory should be ${dirname(name)}/${expected}`];
});

/* ── 5. Basename collisions inside one package ────────────────────────────────────────────────────────────
 * The exemptions are the names whose whole job is to be repeated: a barrel, a runtime invariant, a manifest,
 * a route or handler file named after the group it serves, a test named after its subject. */
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
        /* Case-INSENSITIVELY: a component's test and its composable's test, differing only in the first letter,
         * are two files to git on Linux and ONE file to TypeScript, which refuses the whole program over it
         * (TS1149), as does any checkout on a case-folding filesystem. A collision the compiler will not
         * accept is the strongest kind there is; grouping the chat's pickers produced exactly one. */
        const key = file.toLowerCase();
        (seen.get(key) ?? seen.set(key, []).get(key)).push(path);
    }
    const clashing = [...seen.values()].filter((paths) => paths.length > 1);
    if (clashing.length > 0) {
        collisions.set(name, clashing.length);
    }
}

/* ── 6. Dead names ────────────────────────────────────────────────────────────────────────────────────────
 * Names this repository removed. The allowlist is not taste: each entry is a place where the string means
 * something OTHER than a path in this tree — the layout of a project this repo GENERATES or documents, or a
 * fixture standing in for somebody else's monorepo. Extend the patterns at every rename in the overhaul, and
 * the allowlist only with a reason of that kind. */
const DEAD_NAMES = [
    { pattern: /(^|[^\w.-])_computers\//, why: "the part is _devices/" },
    /* `_apps/` and `_libs/` ARE ALIVE, just not here. This repo generates projects that use them (scaffold,
     * the deploy CLI's add-app), documents them (the workspace tree of a user's monorepo, iq's globs) and
     * fixtures them in three dozen tests — a hundred mentions, every one of them correct. So the two names it
     * removed from ITSELF on 2026-08-09 are caught in the one spelling that can only mean this tree: qualified
     * by the repository directory. A rule that flagged the bare name would be red forever, and a rule that is
     * red forever is a rule someone switches off. */
    { pattern: /intentic\/_apps\//, why: "this repo's own _apps/ was removed on 2026-08-09" },
    { pattern: /intentic\/_libs\//, why: "this repo's own _libs/ was removed on 2026-08-09" },
    /* The eleven packages that became the `_shared/` part: contracts and SDKs more than one part is written
     * against. Unambiguous names — no generated project has them — so they are caught bare. */
    { pattern: /_sandbox\/(sandbox-contract|sandbox-openapi|sandbox-run|extension-api|extension-manifest|connector-runtime|registry|workspace-ignore)\b/, why: "moved to _shared/" },
    { pattern: /_editor\/extension-ui\b/, why: "moved to _shared/extension-ui" },
    { pattern: /_platform\/(api-contract|capability-catalog)\b/, why: "moved to _shared/" },
    { pattern: /_sandbox\/issue-widget\b/, why: "the directory is _sandbox/issue-sdk, after its npm name" },
    /* One repository, one npm scope. The other two said which CI job ran a package and nothing else, which is
     * not what a package's NAME is for. */
    { pattern: /@intentic-app\//, why: "every package is @intentic/*" },
    { pattern: /@intentic-dev\//, why: "every package is @intentic/*" },
];
const DEAD_NAME_OK = new Map([
    // Two fixtures whose stand-in user repo is itself called "intentic", so the qualified spelling above cannot
    // tell them apart from this tree. Both are asserting on a SCAFFOLDED project's layout.
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

/* ── The two ratchets ─────────────────────────────────────────────────────────────────────────────────────*/
const asObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
if (writeBaseline) {
    writeFileSync(BASELINE, `${JSON.stringify({ fanOut: asObject(fanOut), collisions: asObject(collisions) }, null, 4)}\n`);
    console.log(`layout: baseline written, ${fanOut.size} over-full directories and ${collisions.size} packages with colliding basenames`);
    process.exit(0);
}
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { fanOut: {}, collisions: {} };

// A ratcheted rule fails two ways: a count that grew, and an entry the tree has already beaten (which has to
// be lowered in the same change, or the ratchet quietly stops holding).
const ratchet = (found, allowed, describe) => {
    const grown = [...found]
        .filter(([key, count]) => count > (allowed[key] ?? 0))
        .map(([key, count]) => `${describe(key, count)}${allowed[key] === undefined ? "" : `, the baseline allows ${allowed[key]}`}`);
    const stale = Object.entries(allowed)
        .filter(([key, count]) => (found.get(key) ?? 0) < count)
        .map(([key, count]) => `${key}: the baseline allows ${count}, the tree now has ${found.get(key) ?? 0}: lower or remove its entry in ${"_tools/checks/baselines/layout.json"}`);
    return [grown, stale];
};
const [fanOutGrown, fanOutStale] = ratchet(fanOut, baseline.fanOut ?? {}, (dir, count) => `${dir}: ${count} files`);
const [collisionsGrown, collisionsStale] = ratchet(collisions, baseline.collisions ?? {}, (pkg, count) => `${pkg}: ${count} colliding basename(s)`);

finish(
    [
        [
            "these directories hold no tracked file: they are what a rename left behind, and every `ls` still shows them\n" +
                `  remove them: rm -rf ${topGhosts.join(" ")}`,
            topGhosts,
        ],
        [
            `these directories hold more than ${MAX_FILES_PER_DIR} files, so listing one costs an agent a page it has to read before it can act\n` +
                "  split by what the files DO (see docs/audits/directory-structure-audit.md), or lower the entry in _tools/checks/baselines/layout.json",
            fanOutGrown,
        ],
        ["a directory in _tools/checks/baselines/layout.json is no longer that full: lower or remove its entry in the same change", fanOutStale],
        [
            "these sibling directories differ by one character, so neither listing nor a guessed path can tell them apart\n" +
                "  rename one, or — if both names are wire groups — the pair is vocabulary and belongs in TOLERATED_TWINS with its reason",
            twins,
        ],
        ["a package's directory name must be its npm name without the scope (ARCHITECTURE.md, Conventions)", nameMismatches],
        [
            "TOLERATED_TWINS in _tools/checks/layout.mjs names a pair that is no longer a pair: remove the entry in the\n" +
                "  same change, or the list stops describing the tree",
            [...TOLERATED_TWINS.keys()].filter((key) => !seenTwins.has(key)),
        ],
        [
            "these packages hold two files with the same name, so a guessed path lands on the wrong one\n" +
                "  rename by what each one does, or lower the entry in _tools/checks/baselines/layout.json",
            collisionsGrown,
        ],
        ["a package in _tools/checks/baselines/layout.json no longer collides that often: lower or remove its entry", collisionsStale],
        [
            "these lines name a directory this repository removed, which is where agents keep learning to type it\n" +
                "  point them at the real path (see DEAD_NAME_OK in _tools/checks/layout.mjs for the mentions that are about somebody else's tree)",
            deadNames,
        ],
    ],
    [
        `${ghostCandidates.length} directories at part, package and module level: no ghosts${ 
            mirroredGhosts.length > 0 ? ` (${mirroredGhosts.length} unjudgeable here: mirror mounts of a tree this worktree cannot fix)` : ""}`,
        `${packages.length} packages: every directory named after its package, no new over-full directory, no new colliding basename, no twin siblings outside the wire's own vocabulary`,
        `${tracked.length} tracked files: no dead directory name`,
    ],
);
