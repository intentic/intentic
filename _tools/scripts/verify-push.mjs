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
 *                                            node _tools/scripts/verify-push.mjs --hook   (git's ref lines on stdin)
 *
 * WHY. Of the 100 CI pipelines on main before this was written, 55 were red, and the recent reds were not flakes:
 * type errors in @intentic/ui and @intentic/ingress, a test file that did not compile, a Rust crate rustfmt would
 * have reflowed. Every one of them had passed the push check of the day, which ran `pnpm test`, TESTS ONLY, on a
 * tree CI then type-checked first. A test file with a type error runs fine under vitest, which strips types, and
 * fails tsgo, so the gate's blind spot was the exact shape of what kept getting through. Behind it the git hook
 * ran only the invariants that need no install (~70ms), so a push from a terminal, or with the rule switched off,
 * was measured by nothing at all. And nothing anywhere ran rustfmt.
 *
 * The rule is the one prepass.mjs states for itself: a defect class visible to the 60-minute job gets a detector
 * in the seconds-long one. Here the detector is the job. verify.yml runs three steps and this runs the same three,
 * unfiltered:
 *
 *     node _tools/scripts/prepass.mjs                          ┐ `pnpm typecheck`
 *     turbo run typecheck --continue=dependencies-successful   ┘
 *     turbo run build test --continue=dependencies-successful
 *
 * Unfiltered on purpose: turbo's cache is the filter. A package whose inputs did not move replays its last result
 * in milliseconds, so a push costs what it changed, and there is no second copy of "which packages does this
 * reach" here to drift from the one CI computes (affected.mjs). `build` is in the set because a push comes from
 * the main checkout, where it works; in a LINKED WORKTREE (an agent branch pushed by hand) `pnpm build` dies
 * EXDEV, so there the third step is the turn-ending check's shape, `turbo run test --only`, and the log says so.
 * Recognized the way prepass invariant 6 recognizes it: a checkout whose git dir is not its common dir.
 *
 * TWO CHEAP TIERS FIRST, so a push that is wrong in a way readable from the checkout is refused in a second:
 *   1. the gates that read the checkout and nothing else: the prepass invariants and the control-character scan
 *      (what the hook has always run), the invariant registry's exhaustiveness and the daemon's module boundaries
 *      (verify-invariants.mjs, verify-daemon-boundaries.mjs, each milliseconds, each red on main at some point with
 *      nothing running it), the assertion ratchet over the range's test files (assertion-ratchet.mjs: a test file
 *      may get stronger by itself and weaker only with a `test!:` subject or a `Test-Note:` trailer saying why),
 *      the manifest/lockfile lockstep below, and the linter, which the turn-ending check already holds every agent
 *      edit to and which is the one step here that needs node_modules, so where pnpm is absent it says so and
 *      stands down rather than refusing a push over a linter CI does not run;
 *   2. `cargo fmt --check` on every Rust crate the push touches. ic-check and desktop-check went red on
 *      formatting alone five times in two weeks, and rustfmt is on this image and takes 0.2s. clippy stays in CI:
 *      it needs a compile, and for the desktop crate a webkit this image does not carry.
 *
 * THE MANIFEST AND THE LOCKFILE LEAVE TOGETHER. Nine `fix: lock` commits in two weeks were the same event: an
 * agent's landed work edited a package.json, the daemon's reinstall rewrote pnpm-lock.yaml beside it, and the
 * owner committed the first without the second. The working tree passes every gate here, because the suite reads
 * the tree; CI's checkout fails prepass invariant 3 in the first minute. That is the one place the gap in the
 * last paragraph of this header has a known shape, so it is refused by name: a push whose range commits any of
 * package.json, pnpm-workspace.yaml or pnpm-lock.yaml while the tree holds an uncommitted change to any of them.
 *
 * ONE MEASUREMENT PER TREE. The app's rule runs first, then the daemon pushes, and the hook fires on the same tree
 * a minute later; running the suite twice would double the wait for nothing. So a verdict is recorded against a
 * hash of the working tree it measured (`intentic-push-verified` in the git dir), and the suite is re-run only
 * for a tree that has no passing verdict. The hash is `git write-tree` over a throwaway copy of the index with
 * `add -A` applied: tracked and untracked content, ignores honoured, ~20ms. An edit anywhere the suite could see
 * invalidates it; an install under node_modules does not, which is what the TTL is for.
 *
 * A RED VERDICT THE OWNER HAS ALREADY SEEN IS LET THROUGH BY THE HOOK, and it says so. The app offers "Push
 * anyway" after a red check, and that is a person deciding with the failure in front of them; a hook that then
 * spent ten minutes re-running the suite to refuse what they just chose would only teach them `--no-verify`. What
 * the hook guarantees is that nothing leaves UNMEASURED. `STRICT` below is the one-word change to refuse instead.
 *
 * WHAT IT MEASURES IS THE WORKING TREE, and CI measures the COMMIT. They differ when the tree holds work that is
 * not in the push: landed agent work the owner has not committed yet, a lockfile an install left beside a
 * committed manifest. The suite here sees the union, so a commit that passes only because of something
 * uncommitted next to it passes here and fails there. That is the one gap this knows about and does not close,
 * and it says how big it is on every run.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
// By file, not by package name, for the reason prepass.mjs gives: the hook runs on a clone that may never have
// installed, and a bare specifier resolves through node_modules.
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);
const hook = process.argv.includes("--hook");
// Refuse a tree the app's check measured red, instead of letting the owner's "Push anyway" stand.
const STRICT = false;
// A verdict older than this is re-measured even for an identical tree: node_modules is not in the hash.
const VERDICT_TTL_MS = 12 * 60 * 60_000;
// How much of a failed suite's output is repeated into git's error text when the hook ran it (the terminal case
// streams everything; this case has no terminal, only the pusher's error message).
const TAIL_LINES = 80;
const ZERO_SHA = /^0+$/;

// stderr throughout: git shows a hook's stderr to whoever pushed, and the daemon reads the same stream.
const say = (line) => console.error(`verify-push: ${line}`);
const fail = (line) => {
    say(line);
    process.exit(1);
};
const ago = (at) => {
    const seconds = Math.round((Date.now() - at) / 1000);
    return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
};

const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return result.status === 0 ? result.stdout : undefined;
};

// One tier's command, output straight to whoever is watching. A command that could not start is as much a
// refusal as one that failed: the gate has learned nothing about the tree and says so instead of passing.
const step = (label, command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (result.error !== undefined) {
        fail(`${label}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        fail(`${label} failed; the push does not go`);
    }
};

/* ── what is leaving ─────────────────────────────────────────────────────────────────────────────────────────
 * git hands a pre-push hook one line per ref on stdin, `<local ref> <local sha> <remote ref> <remote sha>`: a
 * deletion has an all-zero local sha, a new branch an all-zero remote one. The rule has no stdin and asks the
 * branch's upstream instead. The range only SCOPES tier 2; the suite is unfiltered, and a range this cannot
 * resolve widens to "every crate", never to "none". */
const pushes = [];
if (hook) {
    let stdin = "";
    try {
        stdin = readFileSync(0, "utf8");
    } catch {
        // No stdin at all (run by hand): nothing is named, so everything is in scope.
    }
    for (const line of stdin.split("\n")) {
        const [, local, , remote] = line.trim().split(/\s+/);
        if (local !== undefined && !ZERO_SHA.test(local)) {
            pushes.push({ local, remote: remote !== undefined && !ZERO_SHA.test(remote) ? remote : undefined });
        }
    }
    if (stdin.trim() !== "" && pushes.length === 0) {
        say("only deletions; nothing to verify");
        process.exit(0);
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
step("prepass invariants", process.execPath, [join(root, "_tools/scripts/prepass.mjs"), "--checks-only"]);
step("control-character scan", process.execPath, [join(root, "_tools/scripts/control-chars.mjs")]);
step("invariant registry", process.execPath, [join(root, "_tools/scripts/verify-invariants.mjs")]);
step("daemon boundaries", process.execPath, [join(root, "_tools/scripts/verify-daemon-boundaries.mjs")]);
{
    const measured = ranges();
    if (measured.length === 0) {
        say("assertion ratchet: no upstream to measure the range against, so the test files leave unmeasured (CI measures the tree they land in)");
    }
    for (const [base, head] of measured) {
        step(`assertion ratchet (${base.slice(0, 9)}..${head.slice(0, 9)})`, process.execPath, [
            join(root, "_tools/scripts/assertion-ratchet.mjs"),
            base,
            head,
        ]);
    }
}
const changed = changedPaths();
{
    const LOCKSTEP = /(^|\/)package\.json$|^pnpm-workspace\.yaml$|^pnpm-lock\.yaml$/;
    const committed = changed === undefined ? [] : [...changed].filter((path) => LOCKSTEP.test(path));
    const uncommitted = (git("status", "--porcelain", "--untracked-files=all") ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter((path) => LOCKSTEP.test(path));
    if (committed.length > 0 && uncommitted.length > 0) {
        fail(
            `the push commits ${committed.join(", ")} while ${uncommitted.join(", ")} ${uncommitted.length === 1 ? "is" : "are"} changed and uncommitted ` +
                `beside it; CI's checkout gets the first without the second and fails prepass invariant 3 (the lockfile no longer records the manifest). ` +
                `Commit them together`,
        );
    }
}
{
    const lint = spawnSync("pnpm", ["lint"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (lint.error !== undefined) {
        say(`lint skipped: ${lint.error.message} (CI does not lint; the turn-ending check does)`);
    } else if (lint.status !== 0) {
        fail("lint failed; the push does not go");
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

/* ── tier 3: the three steps verify.yml runs ─────────────────────────────────────────────────────────────── */

// A hash of the working tree's CONTENT, tracked and untracked, ignores honoured. Undefined when git cannot
// answer (an unmerged index, a scratch dir that cannot be made), which reads as "no verdict" and re-measures.
const treeHash = () => {
    const indexPath = git("rev-parse", "--git-path", "index")?.trim();
    if (indexPath === undefined) {
        return undefined;
    }
    const scratch = mkdtempSync(join(tmpdir(), "verify-push-"));
    try {
        const copy = join(scratch, "index");
        const source = resolve(root, indexPath);
        if (existsSync(source)) {
            copyFileSync(source, copy);
        }
        const env = { ...process.env, GIT_INDEX_FILE: copy };
        if (spawnSync("git", ["add", "-A", "."], { cwd: root, env, stdio: "ignore" }).status !== 0) {
            return undefined;
        }
        const tree = spawnSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" });
        return tree.status === 0 ? tree.stdout.trim() : undefined;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

// In the git dir rather than the tree: untracked by construction, per checkout, gone with a re-clone.
const verdictPath = () => {
    const dir = git("rev-parse", "--git-dir")?.trim();
    return dir === undefined ? undefined : join(resolve(root, dir), "intentic-push-verified");
};
const readVerdict = () => {
    const path = verdictPath();
    if (path === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};
const writeVerdict = (tree, status) => {
    const path = verdictPath();
    if (path === undefined || tree === undefined) {
        return;
    }
    try {
        writeFileSync(path, `${JSON.stringify({ tree, status, at: Date.now() })}\n`);
    } catch (error) {
        say(`could not record the verdict (${error.message}); the next push will measure again`);
    }
};

// The size of the one gap this gate knows about (header, last paragraph).
const noteUncommitted = () => {
    const count = (git("status", "--porcelain", "--untracked-files=all") ?? "").split("\n").filter(Boolean).length;
    if (count > 0) {
        say(
            `${count} uncommitted path${count === 1 ? "" : "s"} in the tree this measured ${count === 1 ? "is" : "are"} not in the push; CI checks out the commit alone`,
        );
    }
};

const suite = () => {
    // INDEXNOW_ENABLED=0 for the reason ci.yml gives: the site build otherwise polls the live site for ~2 min.
    // VITEST_MAX_WORKERS is what the root `test` script sets and turbo passes through; `turbo run build test`
    // bypasses that script, so it is set here, and the caller's own value wins.
    const env = { ...process.env, INDEXNOW_ENABLED: "0", VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4" };
    const linked = git("rev-parse", "--git-dir")?.trim() !== git("rev-parse", "--git-common-dir")?.trim();
    if (linked) {
        say("a linked worktree: `build` cannot run here (EXDEV), so tests run off the prepass dist as the turn-ending check does");
    }
    const commands = [
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
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000), linked };
};

const tree = treeHash();
const verdict = readVerdict();
const fresh = verdict !== undefined && tree !== undefined && verdict.tree === tree && Date.now() - verdict.at < VERDICT_TTL_MS;
if (fresh && verdict.status === "passed") {
    say(`this exact tree passed the push check ${ago(verdict.at)}; not measuring it twice`);
    noteUncommitted();
    process.exit(0);
}
if (hook && fresh && verdict.status === "failed") {
    if (STRICT) {
        fail(`this exact tree FAILED the push check ${ago(verdict.at)}; fix it, or \`git push --no-verify\` if you must`);
    }
    say(`this exact tree FAILED the push check ${ago(verdict.at)} and the push was asked for anyway; CI will say the same`);
    noteUncommitted();
    process.exit(0);
}
if (hook) {
    say("no passing verdict for this tree; running the suite here (the app's push check would show it in a terminal)");
}
const result = suite();
writeVerdict(tree, result.ok ? "passed" : "failed");
noteUncommitted();
if (!result.ok) {
    if (result.tail) {
        console.error(result.tail);
    }
    fail(`${result.why}; the push does not go`);
}
say(
    result.linked
        ? `passed in ${result.seconds}s: prepass, typecheck and tests (build skipped in a linked worktree)`
        : `passed in ${result.seconds}s: prepass, typecheck, build and tests, the same steps verify.yml runs`,
);
