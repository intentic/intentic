#!/usr/bin/env node
// Push gate, from both `pnpm verify:push` and the pre-push hook. Two cheap tiers collect every finding first (the checks,
// the assertion ratchet, the manifest/lockfile lockstep, the linter, rustfmt). The suite CI's verify groups run
// (typecheck, build, test) is then REPLAYED from a verdict the land's `pnpm verify` or an earlier push check recorded
// for this tree, and otherwise left to CI: a tree nobody measured is not measured here on the pusher's clock unless
// `--suite` asks for it. Measures the working tree and every pushed commit's own tree.
//
// THE ONE THING ONLY THIS GATE CAN SEE is the tree that becomes main. A turn measures one worktree against its own HEAD
// and a nightly measures main a day later with nobody attached; the push is the only moment at which the combined tree
// exists AND somebody is standing there. That is why tidiness is judged here against the range (the checkout-gates block
// below), and it is the finding docs/audits/tidy-job.md was written from.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { isLinkedWorktree } from "../../checks/lib/repo.mjs";
import { changedPaths as treeChangedPaths, git as gitIn } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { ago, commitTree, freshVerdicts, treeHash, writeVerdict } from "../lib/tree-verdict.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";
import { testWorkers } from "./test-workers.mjs";

const root = repoRoot(import.meta.url);
const hook = process.argv.includes("--hook");
// Runs typecheck, build and test here when no verdict covers the tree; without it that is CI's to measure.
const suiteForced = process.argv.includes("--suite");

// Clears inherited GIT_* vars (e.g. GIT_DIR in a worktree), overriding `cwd: root` toward the wrong repo.
for (const variable of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_GRAFT_FILE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_INDEX_VERSION",
]) {
    delete process.env[variable];
}
// Refuses a tree measured red already, instead of letting `Push anyway` stand.
const STRICT = false;
// Lines of a failed suite's output repeated into git's error text; the terminal case streams everything instead.
const TAIL_LINES = 80;
const ZERO_SHA = /^0+$/;
const TAG_REF = /^refs\/tags\//;

// Reports to stderr, which git shows the pusher; a tier collects its findings, but the run stops between tiers.
const { say, step, fail, finish } = createSteps("verify-push", root);
// Ends the run immediately, for refusals about the push itself, not the tree (e.g. an unmeasurable range).
const refuse = (line) => {
    say(line);
    process.exit(1);
};

// Bound to this checkout, so a large diff isn't misread as a failed git call (lib/git.mjs's larger maxBuffer).
const git = (...args) => gitIn(root, ...args);

// Git's stdin line is `<local ref> <local sha> <remote ref> <remote sha>`; zero sha means deletion or new branch, tag
// refs are dropped. No stdin asks the branch's upstream; an unresolvable range widens tier 2, never narrows it.
const pushes = [];
if (hook) {
    let stdin = "";
    try {
        stdin = readFileSync(0, "utf8");
    } catch {
        // No stdin at all (run by hand): nothing is named, so everything is in scope.
    }
    const pointers = [];
    for (const line of stdin.split("\n")) {
        const [ref, local, , remote] = line.trim().split(/\s+/);
        if (local === undefined || ZERO_SHA.test(local)) {
            continue;
        }
        if (TAG_REF.test(ref)) {
            pointers.push(ref.slice("refs/tags/".length));
            continue;
        }
        pushes.push({ local, remote: remote !== undefined && !ZERO_SHA.test(remote) ? remote : undefined });
    }
    if (stdin.trim() !== "" && pushes.length === 0) {
        say(
            pointers.length > 0
                ? `only tags (${pointers.join(", ")}): a pointer move onto commits a branch push already measured, and a release runs on those`
                : "only deletions; nothing to verify",
        );
        process.exit(0);
    }
    if (pointers.length > 0) {
        say(`${pointers.join(", ")} ${pointers.length === 1 ? "is a tag and rides" : "are tags and ride"} along; what is measured is the branch`);
    }
} else {
    const head = git("rev-parse", "-q", "--verify", "HEAD")?.trim();
    if (head !== undefined) {
        pushes.push({ local: head, remote: git("rev-parse", "-q", "--verify", "@{u}")?.trim() });
    }
}

// The paths the push changes, or undefined when that cannot be known (no remote sha, a base this clone lacks).
const changedPaths = () => {
    if (pushes.length === 0) {
        return undefined;
    }
    const paths = new Set();
    for (const { local, remote } of pushes) {
        const base = remote === undefined ? undefined : git("merge-base", remote, local)?.trim();
        const listing = base === undefined ? undefined : git("diff", "--name-only", base, local);
        if (listing === undefined) {
            return undefined;
        }
        for (const path of listing.split("\n").filter(Boolean)) {
            paths.add(path);
        }
    }
    return paths;
};

// Commit ranges the push carries as `[base, head]`; omitted where a base can't be resolved, since the ratchet has
// nothing to say about an unresolvable range.
const ranges = () =>
    pushes.flatMap(({ local, remote }) => {
        const base = remote === undefined ? undefined : git("merge-base", remote, local)?.trim();
        return base === undefined || base === local ? [] : [[base, local]];
    });

// Line span of pnpm-lock.yaml's `packageManagerDependencies:` block. Judged by which lines a diff touches, never by
// their text, since the block's own shape matches every importer entry elsewhere in the file.
const blockSpan = (text) => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^ {4}packageManagerDependencies:[ \t]*$/.test(line));
    if (start === -1) {
        return undefined;
    }
    let end = lines.length;
    for (let at = start + 1; at < lines.length; at += 1) {
        if (/^ {0,4}\S/.test(lines[at])) {
            end = at;
            break;
        }
    }
    // 1-based and inclusive: the header line itself through the last line under it.
    return [start + 1, end];
};

const lockfileRewriteOnly = () => {
    // Read, not assumed missing: a deleted lockfile shouldn't crash the push instead of refusing it.
    const tree = existsSync(join(root, "pnpm-lock.yaml")) ? readFileSync(join(root, "pnpm-lock.yaml"), "utf8") : "";
    const inTree = blockSpan(tree);
    const atHead = blockSpan(git("show", "HEAD:pnpm-lock.yaml") ?? "");
    // `HEAD` rather than the index: what CI checks out is the commit, so staged-but-uncommitted counts too.
    const diff = git("diff", "-U0", "HEAD", "--", "pnpm-lock.yaml");
    if (inTree === undefined || atHead === undefined || diff === undefined) {
        return false;
    }
    const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
    // A zero-count hunk side is an insertion point (the line git names, or the one after it), not a range.
    const within = ([from, to], at, count) => (count === 0 ? at >= from - 1 && at <= to : at >= from && at + count - 1 <= to);
    return (
        hunks.length > 0 &&
        hunks.every(([, oldAt, oldCount, newAt, newCount]) => {
            const old = Number(oldAt);
            const fresh = Number(newAt);
            return (
                within(atHead, old, oldCount === undefined ? 1 : Number(oldCount)) &&
                within(inTree, fresh, newCount === undefined ? 1 : Number(newCount))
            );
        })
    );
};

// THE CHECKS, WITH TIDINESS JUDGED AGAINST THE COMMIT THIS PUSH IS BUILT ON.
//
// A `code` failure refuses outright: the tree does not work, and it does not matter who made it so. A `tidy` failure is
// a real cost with a measurement behind it (manifest.mjs splits the two by what a failure MEANS), and it used to refuse
// nowhere anybody could act — `--tidy=warn` waved every one of them through here, and nightly.yml's `tidy` job read them
// the next morning on a commit with no author attached. That job then failed on 14 of its 24 runs, 13 of them for
// `layout` or `paths`, every finding traceable to one line in one commit a day or two old (docs/audits/tidy-job.md).
//
// THIS IS THE ONLY MOMENT THAT HAS BOTH HALVES. verify-turn asks the same question of a turn, but a turn measures its own
// worktree against its own HEAD — a tree that never becomes main. What becomes main is this push, and the difference
// between the two is every other conversation's work, which is exactly where a counting rule breaks: two turns that each
// add one file to a directory of thirty are each innocent in their own worktree and over the limit together. The push is
// where they meet, and it is still early enough for the person pushing to fix it.
//
// Judged against the merge-base rather than refused wholesale, for the reason the tidy job's own comment gives: a gate
// that refuses a pusher for state nobody in this push produced teaches everyone that red means nothing. What refuses is
// the lines the range ADDED (turn-findings.mjs); what was already standing is named and charged to no one.
{
    const verdicts = checkVerdicts(root);
    if (verdicts === undefined) {
        fail("checkout gates", "could not be measured · node _tools/checks/run.mjs");
    } else {
        const unmeasured = verdicts.filter((verdict) => !verdict.measured);
        if (unmeasured.length > 0) {
            say(
                `${unmeasured.map(({ id }) => id).join(", ")}: could not measure, so nothing there is vouched for — the check needs a look, the tree is not accused`,
            );
        }
        const failed = verdicts.filter((verdict) => !verdict.ok && verdict.measured);
        const show = (mark, verdict, body) => process.stderr.write(`\n${mark} ${verdict.id} (${verdict.file})\n${body}\n`);
        const broken = failed.filter((verdict) => verdict.gate === "code");
        for (const verdict of broken) {
            show("✗", verdict, `${verdict.stderr}${verdict.stdout}`.trimEnd());
        }
        if (broken.length > 0) {
            const ids = broken.map(({ id }) => id);
            fail("checkout gates", `${ids.length} check(s) the tree fails: ${ids.join(", ")} · node _tools/checks/run.mjs --only ${ids.join(",")}`);
        }
        const untidy = failed.filter((verdict) => verdict.gate === "tidy");
        // One base for the whole question: the tidy rules read the tree, not a ref, so the oldest point this push departs
        // from is what "already standing" means. Absent an upstream there is no before, and a finding cannot be told from
        // one the tree arrived with — reported, and left to the nightly that reads the tree it lands in.
        const base = ranges()[0]?.[0];
        if (untidy.length > 0 && base === undefined) {
            for (const verdict of untidy) {
                show("?", verdict, `${verdict.stderr}${verdict.stdout}`.trimEnd());
            }
            say(`${untidy.map(({ id }) => id).join(", ")}: no upstream to measure the range against, so these are reported and not refused`);
        } else if (untidy.length > 0) {
            const judged = judgeAgainstBase(
                untidy,
                reportsAt(
                    root,
                    base,
                    untidy.map(({ id }) => id),
                ),
            );
            const mine = judged.filter(({ added }) => added.length > 0);
            const unsure = judged.filter(({ added, unsure: lines }) => added.length === 0 && lines.length > 0);
            const theirs = judged.filter(({ added, unsure: lines }) => added.length === 0 && lines.length === 0);
            if (theirs.length > 0) {
                say(
                    `${theirs.map(({ verdict }) => verdict.id).join(", ")}: already failing at ${base.slice(0, 9)} and no worse for this push, so not this push's to fix`,
                );
            }
            for (const { verdict, unsure: lines } of unsure) {
                show(
                    "?",
                    verdict,
                    `${lines.length} problem(s) ${base.slice(0, 9)} could not be asked about — reported, not laid at this push's door\n${lines.join("\n")}`,
                );
            }
            for (const { verdict, added } of mine) {
                show("✗", verdict, `${added.length} problem(s) this push introduces\n${added.join("\n")}`);
            }
            if (mine.length > 0) {
                const ids = mine.map(({ verdict }) => verdict.id);
                fail(
                    "tidiness",
                    `${ids.length} tidy check(s) this push breaks: ${ids.join(", ")} · node _tools/checks/run.mjs --only ${ids.join(",")}`,
                );
            }
        }
        if (broken.length === 0 && untidy.length === 0) {
            say(`checkout gates: ${verdicts.filter(({ ok }) => ok).length} passed`);
        }
    }
}
{
    const measured = ranges();
    if (measured.length === 0) {
        say("assertion ratchet: no upstream to measure the range against, so the test files leave unmeasured (CI measures the tree they land in)");
    }
    for (const [base, head] of measured) {
        step(`assertion ratchet (${base.slice(0, 9)}..${head.slice(0, 9)})`, process.execPath, [
            join(root, "_tools/scripts/verify/assertion-ratchet.mjs"),
            base,
            head,
        ]);
    }
}
const changed = changedPaths();
{
    const LOCKSTEP = /(^|\/)package\.json$|^pnpm-workspace\.yaml$|^pnpm-lock\.yaml$/;
    const committed = changed === undefined ? [] : [...changed].filter((path) => LOCKSTEP.test(path));
    const uncommitted = (treeChangedPaths(root) ?? []).filter((path) => LOCKSTEP.test(path));
    if (committed.length > 0 && uncommitted.length > 0) {
        // The one case nobody typed: pnpm rewrites `packageManagerDependencies` from every command it runs.
        const rewriteOnly = uncommitted.length === 1 && uncommitted[0] === "pnpm-lock.yaml" && lockfileRewriteOnly();
        fail(
            "manifest/lockfile lockstep",
            rewriteOnly
                ? `the push commits ${committed.join(", ")} while pnpm-lock.yaml is changed and uncommitted beside it — and the only thing changed in it is the ` +
                      `\`packageManagerDependencies\` block, which pnpm rewrites from every command it runs. Nobody typed that: \`git checkout -- pnpm-lock.yaml\` ` +
                      `and push again`
                : `the push commits ${committed.join(", ")} while ${uncommitted.join(", ")} ${uncommitted.length === 1 ? "is" : "are"} changed and uncommitted ` +
                      `beside it; CI's checkout gets the first without the second and fails the lockfile check (the lockfile no longer records the manifest). ` +
                      `Commit them together`,
        );
    }
}
{
    const lint = spawnSync("pnpm", ["lint"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (lint.error !== undefined) {
        say(`lint skipped: ${lint.error.message} (CI does not lint; the turn-ending check does)`);
    } else if (lint.status !== 0) {
        fail("lint", `exit ${lint.status ?? "signal"} · pnpm lint`);
    }
}

// Crates found by walking for Cargo.toml, not listed by name; a crate counts as touched when any changed path sits
// under its directory.
const CRATE_SKIP = new Set(["node_modules", "target", "dist", "generated", ".cache", ".turbo", "out-tsc", ".git"]);
const crates = (dir, depth) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (CRATE_SKIP.has(entry.name) || (entry.isDirectory() && entry.name.startsWith("."))) {
            return [];
        }
        if (entry.isDirectory()) {
            return depth < 4 ? crates(join(dir, entry.name), depth + 1) : [];
        }
        return entry.name === "Cargo.toml" ? [relative(root, dir)] : [];
    });
const touched = crates(root, 0).filter(
    (crate) => changed === undefined || [...changed].some((path) => path === crate || path.startsWith(`${crate}/`)),
);
if (touched.length > 0) {
    if (spawnSync("cargo", ["fmt", "--version"], { cwd: root, encoding: "utf8" }).status !== 0) {
        say(`rustfmt is not available here, so ic-check and desktop-check decide formatting in CI (${touched.join(", ")})`);
    } else {
        for (const crate of touched) {
            step(`cargo fmt --check (${crate})`, "cargo", ["fmt", "--manifest-path", join(crate, "Cargo.toml"), "--all", "--check"]);
        }
    }
}

// Prints everything both tiers found; a tree already refused cheaply doesn't go on to the ten-minute suite.
finish(() => "the checkout gates, the assertion ratchet, the manifest/lockfile lockstep, the linter and rustfmt");

// Tier 3: the three steps verify.yml runs.

// Reports how many uncommitted paths this measured but the push doesn't carry; CI won't see them.
const noteUncommitted = () => {
    const count = (treeChangedPaths(root) ?? []).length;
    if (count > 0) {
        say(
            `${count} uncommitted path${count === 1 ? "" : "s"} in the tree this measured ${count === 1 ? "is" : "are"} not in the push; CI checks out the commit alone`,
        );
    }
};

const suite = (buildOnly) => {
    // INDEXNOW_ENABLED=0, or the site build polls the live site. TEST_WORKERS is sized to the cgroup as the root
    // `test` script's is, since `turbo run build test` bypasses that script; the caller's own value still wins.
    const env = { ...process.env, INDEXNOW_ENABLED: "0", TEST_WORKERS: testWorkers() };
    const linked = isLinkedWorktree();
    if (linked) {
        say("a linked worktree: `build` cannot run here (EXDEV), so tests run off the prepass dist as the turn-ending check does");
    }
    // A `verify` verdict already covers typecheck and tests; this runs only the build it couldn't, or nothing at all in
    // a linked worktree.
    const commands = buildOnly
        ? linked
            ? []
            : [["pnpm turbo run build", ["turbo", "run", "build", "--continue=dependencies-successful"]]]
        : [
              ["pnpm typecheck", ["typecheck"]],
              linked
                  ? ["pnpm turbo run test --only", ["turbo", "run", "test", "--only", "--continue=dependencies-successful"]]
                  : ["pnpm turbo run build test", ["turbo", "run", "build", "test", "--continue=dependencies-successful"]],
          ];
    const started = Date.now();
    for (const [label, args] of commands) {
        say(`${label} …`);
        // Streams live in a terminal; under git (no terminal) only the captured tail becomes the pusher's error text.
        const result = spawnSync("pnpm", args, {
            cwd: root,
            env,
            shell: process.platform === "win32",
            ...(hook ? { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 } : { stdio: "inherit" }),
        });
        if (result.error !== undefined) {
            return {
                ok: false,
                why: `${label}: ${result.error.message} — nothing here could measure the tree; run the app's push check, or \`pnpm verify\`, and push again`,
            };
        }
        if (result.status !== 0) {
            const tail = hook ? `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").slice(-TAIL_LINES).join("\n") : "";
            return { ok: false, why: `${label} failed (exit ${result.status ?? "signal"})`, tail };
        }
    }
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000), linked, buildOnly };
};

const tree = treeHash(root);
// The trees a verdict may be about: the working tree (what `pnpm verify` measured after a land) and each pushed
// commit's own (what CI checks out); a clean tree makes them one.
const candidates = [tree, ...pushes.map(({ local }) => commitTree(root, local))];
const fresh = freshVerdicts(root, candidates);
const passed = fresh.find((verdict) => verdict.status === "passed");
if (passed !== undefined && passed.suite === "push") {
    say(`this tree passed the push check ${ago(passed.at)}; not measuring it twice`);
    noteUncommitted();
    process.exit(0);
}
// A `verify` verdict covers typecheck and tests; the build is the one step it could not run.
const replay = passed !== undefined && passed.suite === "verify";
if (replay) {
    say(`this tree passed \`pnpm verify\` ${ago(passed.at)}; running only the build it could not`);
}
const failedPush = fresh.find((verdict) => verdict.status === "failed" && verdict.suite === "push");
if (hook && !replay && failedPush !== undefined) {
    if (STRICT) {
        refuse(`this tree FAILED the push check ${ago(failedPush.at)}; fix it, or \`git push --no-verify\` if you must`);
    }
    say(`this tree FAILED the push check ${ago(failedPush.at)} and the push was asked for anyway; CI will say the same`);
    noteUncommitted();
    process.exit(0);
}
if (!replay && !suiteForced) {
    say(
        "no verdict covers this tree: the land's `pnpm verify` has not measured it and no push check has. CI's verify groups measure the " +
            "commit (typecheck, build, test) in minutes; to measure it here first, `pnpm verify:push --suite` or `pnpm verify`",
    );
    noteUncommitted();
    process.exit(0);
}
const result = suite(replay);
writeVerdict(root, tree, result.ok ? "passed" : "failed", "push");
noteUncommitted();
if (!result.ok) {
    if (result.tail) {
        console.error(result.tail);
    }
    refuse(`${result.why}; the push does not go`);
}
say(
    result.buildOnly
        ? `passed in ${result.seconds}s: the build, on top of the \`pnpm verify\` verdict this tree already had`
        : result.linked
          ? `passed in ${result.seconds}s: the checkout gates, typecheck and tests (build skipped in a linked worktree)`
          : `passed in ${result.seconds}s: the checkout gates, typecheck, build and tests, the same steps verify.yml runs`,
);
