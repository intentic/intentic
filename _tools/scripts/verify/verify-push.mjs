#!/usr/bin/env node
/* THE PUSH GATE: what CI's verify groups would say about this tree, said before the tree leaves the machine.
 *
 * Two callers, one verdict:
 *
 *   · the `push.starting` rule the app runs when the owner clicks Push (_sandbox/sandbox prepush/prepush.ts), in
 *     a terminal they can watch:             cd intentic && pnpm verify:push
 *     Spelled through pnpm so the heavy-command rules (.intentic/config/heavy-commands.json, `pnpm … verify`)
 *     queue it in the same pool as every other suite; the hook below cannot assume pnpm and calls node directly.
 *   · .githooks/pre-push, for every push git makes from this checkout, whoever or whatever asked for it:
 *                                            node _tools/scripts/verify/verify-push.mjs --hook   (git's ref lines on stdin)
 *
 * WHY. Of the 100 CI pipelines on main before this was written, 55 were red, and the recent reds were not flakes:
 * type errors in @intentic/ui and @intentic/ingress, a test file that did not compile, a Rust crate rustfmt would
 * have reflowed. Every one of them had passed the push check of the day, which ran `pnpm test`, TESTS ONLY, on a
 * tree CI then type-checked first. A test file with a type error runs fine under vitest, which strips types, and
 * fails tsgo, so the gate's blind spot was the exact shape of what kept getting through. Behind it the git hook
 * ran only the invariants that need no install (~70ms), so a push from a terminal, or with the rule switched off,
 * was measured by nothing at all. And nothing anywhere ran rustfmt.
 *
 * The rule is the one every check in _tools/checks states for itself: a defect class visible to the 60-minute job gets a detector
 * in the seconds-long one. Here the detector is the job. verify.yml runs three steps and this runs the same three,
 * unfiltered:
 *
 *     pnpm prepass (the checks, then the declarations emit)    ┐ `pnpm typecheck`
 *     turbo run typecheck --continue=dependencies-successful   ┘
 *     turbo run build test --continue=dependencies-successful
 *
 * Unfiltered on purpose: turbo's cache is the filter. A package whose inputs did not move replays its last result
 * in milliseconds, so a push costs what it changed, and there is no second copy of "which packages does this
 * reach" here to drift from the one CI computes (affected.mjs). `build` is in the set because a push comes from
 * the main checkout, where it works; in a LINKED WORKTREE (an agent branch pushed by hand) `pnpm build` dies
 * EXDEV, so there the third step is the turn-ending check's shape, `turbo run test --only`, and the log says so.
 * Recognized the way the contract-shrink check recognizes it: a checkout whose git dir is not its common dir.
 *
 * TWO CHEAP TIERS FIRST, so a push that is wrong in a way readable from the checkout is refused in a second:
 *   1. the gates that read the checkout and nothing else: every check the manifest lists (_tools/checks/run.mjs:
 *      the lockfile, the test programs, the workflow policy, the byte scan, the invariant registry, the daemon's
 *      module boundaries and the rest, side by side, under two seconds), the assertion ratchet over the range's
 *      test files (assertion-ratchet.mjs: a test file may get stronger by itself and weaker only with a `test!:`
 *      subject or a `Test-Note:` trailer saying why), the manifest/lockfile lockstep below, and the linter, which
 *      the turn-ending check already holds every agent edit to and which is the one step here that needs
 *      node_modules, so where pnpm is absent it says so and stands down rather than refusing a push over a
 *      linter CI does not run;
 *   2. `cargo fmt --check` on every Rust crate the push touches. ic-check and desktop-check went red on
 *      formatting alone five times in two weeks, and rustfmt is on this image and takes 0.2s. clippy stays in CI:
 *      it needs a compile, and for the desktop crate a webkit this image does not carry.
 *
 * THE MANIFEST AND THE LOCKFILE LEAVE TOGETHER. Nine `fix: lock` commits in two weeks were the same event: an
 * agent's landed work edited a package.json, the daemon's reinstall rewrote pnpm-lock.yaml beside it, and the
 * owner committed the first without the second. The working tree passes every gate here, because the suite reads
 * the tree; CI's checkout fails the lockfile check in the first minute. That is the one place the gap in the
 * last paragraph of this header has a known shape, so it is refused by name: a push whose range commits any of
 * package.json, pnpm-workspace.yaml or pnpm-lock.yaml while the tree holds an uncommitted change to any of them.
 *
 * ONE MEASUREMENT PER TREE. The app's rule runs first, then the daemon pushes, and the hook fires on the same tree
 * a minute later; running the suite twice would double the wait for nothing. So a verdict is recorded against a
 * hash of the working tree it measured (lib/tree-verdict.mjs: `intentic-push-verified` in the common git dir),
 * and the suite is re-run only for a tree that has no passing verdict. `pnpm verify` records one too, from
 * wherever it ran: the daemon runs it on the main tree after every land, so the ordinary push finds a `verify`
 * verdict for exactly this content, skips typecheck and tests, and runs only the build that `verify` cannot
 * (EXDEV in a worktree). An edit anywhere the suite could see invalidates it; an install under node_modules
 * does not, which is what the TTL is for.
 *
 * A RED VERDICT THE OWNER HAS ALREADY SEEN IS LET THROUGH BY THE HOOK, and it says so. The app offers "Push
 * anyway" after a red check, and that is a person deciding with the failure in front of them; a hook that then
 * spent ten minutes re-running the suite to refuse what they just chose would only teach them `--no-verify`. What
 * the hook guarantees is that nothing leaves UNMEASURED. `STRICT` below is the one-word change to refuse instead.
 *
 * A TAG IS A POINTER, NOT WORK. git names every ref on stdin, and a push whose refs are all tags moves a
 * pointer onto commits that are on the remote already: semantic-release pushing `v1.241.0` between prepare and
 * publish, ship-stable.sh force-pushing that tag onto `stable`, rollback-stable.sh moving it back. Measuring
 * one measures the wrong thing, and the v1.241.0 release is what that cost: the hook fired on
 * `refs/tags/v1.241.0 → refs/tags/stable`, took the OLD stable tag as the range's base — the previous release —
 * and handed the assertion ratchet every commit since it, two hundred of them, each already measured when it
 * was pushed. Two test files no single commit had weakened were weaker across that span, so the push was
 * refused, and the release stopped with its GitHub Release created, its images pushed, and `stable` still
 * naming the version before. The same shape would have run typecheck, build and tests inside the publish job.
 * So tag refs are dropped from what leaves, and a push carrying nothing else stands down. What reaches main
 * reaches it through a branch push, which is measured; a tag pushed at commits no branch carries reaches no
 * branch either, and nothing builds or ships from it.
 *
 * WHAT IT MEASURES IS THE WORKING TREE, and CI measures the COMMIT. They differ when the tree holds work that is
 * not in the push: landed agent work the owner has not committed yet, a lockfile an install left beside a
 * committed manifest. The suite here sees the union, so a commit that passes only because of something
 * uncommitted next to it passes here and fails there. That is the one gap this knows about and does not close,
 * and it says how big it is on every run.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
// By file, not by package name, for the reason _tools/checks/lib/repo.mjs gives: the hook runs on a clone that may never have
// installed, and a bare specifier resolves through node_modules.
import { repoRoot } from "../../constants/src/node.mjs";
import { changedPaths as treeChangedPaths, git as gitIn, isLinkedWorktree } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { ago, freshFor, readVerdict, treeHash, writeVerdict } from "../lib/tree-verdict.mjs";

const root = repoRoot(import.meta.url);
const hook = process.argv.includes("--hook");
// Refuse a tree the app's check measured red, instead of letting the owner's "Push anyway" stand.
const STRICT = false;
// How much of a failed suite's output is repeated into git's error text when the hook ran it (the terminal case
// streams everything; this case has no terminal, only the pusher's error message).
const TAIL_LINES = 80;
const ZERO_SHA = /^0+$/;
const TAG_REF = /^refs\/tags\//;

/* stderr throughout: git shows a hook's stderr to whoever pushed, and the daemon reads the same stream.
 *
 * THE TWO CHEAP TIERS COLLECT (lib/steps.mjs) AND THE BOUNDARY BETWEEN THEM AND THE SUITE DOES NOT, which is
 * the one place in this repository where stopping early is still the right answer. Inside a tier the steps are
 * independent readers of the same checkout and cost a second between them, so a push that is wrong in four ways
 * should be told about four rather than about the first; whether to then spend TEN MINUTES on typecheck, build
 * and tests for a tree already known to be refused is a different question, and the header's "refused in a
 * second" is the answer this gate was built to give. So: everything each tier found, then the decision. */
const { say, step, fail, finish } = createSteps("verify-push", root);
// The refusals that end the run where they stand rather than joining a digest: the ones that are about the
// PUSH rather than about the tree (an unmeasurable range, a suite that could not start, a verdict replayed).
const refuse = (line) => {
    say(line);
    process.exit(1);
};

// Bound to this checkout once, so the call sites below read as plain git. Shared rather than spelled here for
// the reason lib/git.mjs opens with: the copy this replaces had no `maxBuffer`, so a `git diff --name-only`
// over a release-sized range came back as a FAILED command, and the lockstep refusal below then saw no
// committed paths and stopped firing on exactly the largest pushes.
const git = (...args) => gitIn(root, ...args);

/* ── what is leaving ─────────────────────────────────────────────────────────────────────────────────────────
 * git hands a pre-push hook one line per ref on stdin, `<local ref> <local sha> <remote ref> <remote sha>`: a
 * deletion has an all-zero local sha, a new branch an all-zero remote one, and a tag is the pointer move the
 * header describes, dropped here rather than measured. The rule has no stdin and asks the branch's upstream
 * instead. The range only SCOPES tier 2; the suite is unfiltered, and a range this cannot resolve widens to
 * "every crate", never to "none". */
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

// The commit ranges the push carries, `[base, head]` each, or none where a base cannot be resolved (a new branch
// with no upstream, a remote sha this clone lacks). The ratchet reads committed content, so it has nothing to say
// about an unresolvable range and says so rather than guessing at one.
const ranges = () =>
    pushes.flatMap(({ local, remote }) => {
        const base = remote === undefined ? undefined : git("merge-base", remote, local)?.trim();
        return base === undefined || base === local ? [] : [[base, local]];
    });

/* ── tier 1: readable from the checkout ──────────────────────────────────────────────────────────────────── */
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs")]);
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
        fail(
            "manifest/lockfile lockstep",
            `the push commits ${committed.join(", ")} while ${uncommitted.join(", ")} ${uncommitted.length === 1 ? "is" : "are"} changed and uncommitted ` +
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

/* ── tier 2: rustfmt on the crates this push touches ─────────────────────────────────────────────────────────
 * Discovered, not listed (AGENTS.md: guard invariants by discovery): every Cargo.toml outside the trees no crate
 * lives in. A crate is touched when any changed path sits under its directory. */
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

/* Everything both cheap tiers found, and the decision the header describes: a tree refused by a reader that
 * costs a second does not go on to spend ten minutes being refused again. On a clean pair this returns. */
finish(() => "the checkout gates, the assertion ratchet, the manifest/lockfile lockstep, the linter and rustfmt");

/* ── tier 3: the three steps verify.yml runs ─────────────────────────────────────────────────────────────── */

// The size of the one gap this gate knows about (header, last paragraph).
const noteUncommitted = () => {
    const count = (treeChangedPaths(root) ?? []).length;
    if (count > 0) {
        say(
            `${count} uncommitted path${count === 1 ? "" : "s"} in the tree this measured ${count === 1 ? "is" : "are"} not in the push; CI checks out the commit alone`,
        );
    }
};

const suite = (buildOnly) => {
    // INDEXNOW_ENABLED=0 for the reason ci.yml gives: the site build otherwise polls the live site for ~2 min.
    // VITEST_MAX_WORKERS is what the root `test` script sets and turbo passes through; `turbo run build test`
    // bypasses that script, so it is set here, and the caller's own value wins.
    const env = { ...process.env, INDEXNOW_ENABLED: "0", VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4" };
    const linked = isLinkedWorktree(root);
    if (linked) {
        say("a linked worktree: `build` cannot run here (EXDEV), so tests run off the prepass dist as the turn-ending check does");
    }
    /* A `verify` verdict for this exact tree has already answered for typecheck and tests (verify.mjs); what it
     * could not run is `build`, so that is all this runs, and in a linked worktree not even that. */
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
        /* In a terminal the output IS the point and streams through. Under git there is no terminal: the output
         * becomes the pusher's error text, and the daemon caps what it reads back from git at 16 MiB, so the
         * hook keeps the stream and repeats only the tail of a failure. */
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
const verdict = readVerdict(root);
const fresh = freshFor(verdict, tree);
if (fresh && verdict.status === "passed" && verdict.suite === "push") {
    say(`this exact tree passed the push check ${ago(verdict.at)}; not measuring it twice`);
    noteUncommitted();
    process.exit(0);
}
// A `verify` verdict covers typecheck and tests; the build is the one step it could not run.
const replay = fresh && verdict.status === "passed" && verdict.suite === "verify";
if (replay) {
    say(`this exact tree passed \`pnpm verify\` ${ago(verdict.at)}; running only the build it could not`);
}
if (hook && fresh && verdict.status === "failed") {
    if (STRICT) {
        refuse(`this exact tree FAILED the push check ${ago(verdict.at)}; fix it, or \`git push --no-verify\` if you must`);
    }
    say(`this exact tree FAILED the push check ${ago(verdict.at)} and the push was asked for anyway; CI will say the same`);
    noteUncommitted();
    process.exit(0);
}
if (hook && !replay) {
    say("no passing verdict for this tree; running the suite here (the app's push check would show it in a terminal)");
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
