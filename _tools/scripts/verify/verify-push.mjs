#!/usr/bin/env node
// Push check, from both `pnpm verify:push` and the pre-push hook. Two cheap tiers collect every finding first (the checks,
// the assertion ratchet, the manifest/lockfile lockstep, the linter, rustfmt). The suite CI's verify groups run
// (typecheck, build, test) is then REPLAYED from a verdict the land's `pnpm verify` or an earlier push check recorded
// for this tree, and otherwise left to CI: a tree nobody measured is not measured here on the pusher's clock unless
// `--suite` asks for it. Measures the working tree and every pushed commit's own tree.
//
// THE HOOK IS ADVISORY (`--advisory`, which .githooks/pre-push passes): no check blocks a land, a commit or a push. The
// two cheap tiers report what they find to whoever pushes, the suite is never run on their clock, and the push goes
// either way; the land's own check already measured the tree, and CI measures the commit. `pnpm verify:push` by hand
// still exits non-zero on a finding, for a person or a script that asks for a verdict.
//
// WHAT THIS CHECK SEES is the pushed range: every commit that becomes main, whoever made it. The check after each land
// sees the main tree one land at a time, `pnpm verify:turn` sees one worktree against its own base, and a nightly
// measures main a day later with nobody attached. That is why tidiness is judged here against the range (the
// checkout-gates block below).
//
// WHAT IT LEAVES BEHIND. The push goes either way, so what the hook found cannot live only in the terminal git printed it
// to, which nobody reads once the push is through. Before the digest it writes a report into the git common dir
// (push-report.mjs): the findings the pushed range brought in, each with the pushed commit that touched the path it names
// where it names one, and a measurement of every check and the linter. The sandbox files it once the push has reached the remote, and the
// editor's Main line shows each finding as "Left at push" until a later measurement stops printing it or somebody
// dismisses it. Written for a clean push too, whose measurement is what clears the findings of earlier ones; a run by hand
// pushes nothing, so it writes the measurement alone.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { isLinkedWorktree } from "../../checks/lib/repo.mjs";
import { changedPaths as treeChangedPaths, git as gitIn } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { ago, commitTree, freshVerdicts, treeHash, writeVerdict } from "../lib/tree-verdict.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { brokenFindings, lintOutcome, measureEntry, pushEntry, stepFindings, tidyFindings, writeReport } from "./push-report.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";
import { testConcurrency, testWorkers } from "./test-workers.mjs";

const root = repoRoot(import.meta.url);
const hook = process.argv.includes("--hook");
// Reports and never refuses: the hook's mode (see the header).
const advisory = process.argv.includes("--advisory");
// Runs typecheck, build and test here when no verdict covers the tree; without it that is CI's to measure.
const suiteForced = process.argv.includes("--suite");
// Git hands the hook `<remote name> <url>` after the flags; the name is what the report says the push went to.
const remoteName = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

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
const { say, step, fail, failing, failedSteps, finish } = createSteps("verify-push", root, { advisory });
// Ends the run immediately, for refusals about the push itself, not the tree (e.g. an unmeasurable range); advisory, it
// is said and the push goes on.
const refuse = (line) => {
    say(line);
    process.exit(advisory ? 0 : 1);
};

// Bound to this checkout, so a large diff isn't misread as a failed git call (lib/git.mjs's larger maxBuffer).
const git = (...args) => gitIn(root, ...args);

// Git's stdin line is `<local ref> <local sha> <remote ref> <remote sha>`; zero sha means deletion or new branch, tag
// refs are dropped. No stdin asks the branch's upstream; an unresolvable range widens tier 2, never narrows it. Each push
// is `{ ref, local, remote, base }`: the ref it updates on the remote, the two shas, and their merge-base when this clone
// can tell.
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
        const [localRef, local, remoteRef, remote] = line.trim().split(/\s+/);
        if (local === undefined || ZERO_SHA.test(local)) {
            continue;
        }
        if (TAG_REF.test(localRef)) {
            pointers.push(localRef.slice("refs/tags/".length));
            continue;
        }
        pushes.push({ ref: remoteRef ?? localRef, local, remote: remote !== undefined && !ZERO_SHA.test(remote) ? remote : undefined });
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
        // Where a plain `git push` would send it: the upstream's own name for the branch, else the branch's.
        const branch = git("symbolic-ref", "-q", "HEAD")?.trim();
        const upstream = branch === undefined ? undefined : git("for-each-ref", "--format=%(upstream:remoteref)", branch)?.trim();
        pushes.push({
            ref: upstream !== undefined && upstream !== "" ? upstream : (branch ?? "HEAD"),
            local: head,
            remote: git("rev-parse", "-q", "--verify", "@{u}")?.trim(),
        });
    }
}
for (const push of pushes) {
    push.base = push.remote === undefined ? undefined : git("merge-base", push.remote, push.local)?.trim();
}

// The paths the push changes, or undefined when that cannot be known (no remote sha, a base this clone lacks).
const changedPaths = () => {
    if (pushes.length === 0) {
        return undefined;
    }
    const paths = new Set();
    for (const { local, base } of pushes) {
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
const ranges = () => pushes.flatMap(({ local, base }) => (base === undefined || base === local ? [] : [[base, local]]));

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
// `layout` or `paths`, every finding traceable to one line in one commit a day or two old.
//
// WHERE THE WORK MEETS. verify-turn, run by hand, asks the same question of a branch, but it measures its own worktree
// against its own base, a tree that never becomes main. What becomes main is this push, and the difference between the
// two is every other conversation's work, which is exactly where a counting rule breaks: two branches that each add one
// file to a directory of thirty are each innocent in their own worktree and over the limit together. Lands meet first on
// the main tree, where the check after each land asks this question of what that land added (land-tiers.mjs); the push
// asks it of the whole range, while the person pushing is still there to fix it.
//
// Judged against the merge-base rather than refused wholesale, for the reason the tidy job's own comment gives: a gate
// that refuses a pusher for state nobody in this push produced teaches everyone that red means nothing. What refuses is
// the lines the range ADDED (turn-findings.mjs); what was already standing is named and charged to no one.
//
// What is KEPT for later (push-report.mjs) is the same share: every line a broken check prints, and of the tidy ones
// only what this push added. Already failing at the base, or not askable there, is shown here and recorded nowhere.
const verdicts = checkVerdicts(root);
// The findings this push is answerable for, as the report records them; the steps' own join them before it is written.
const findings = [];
{
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
            findings.push(...brokenFindings(verdict));
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
            findings.push(...tidyFindings(mine));
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
// Streamed to the pusher as it runs; only its exit is kept, as the report's measurement of the linter.
const linted = spawnSync("pnpm", ["lint"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
const lint = lintOutcome(linted);
if (linted.error !== undefined) {
    say(`lint skipped: ${linted.error.message} (CI does not lint; each edit's own lint and the check after each land do)`);
} else if (linted.status !== 0) {
    fail("lint", `exit ${linted.status ?? "signal"}`, [], { spelling: "pnpm lint" });
}

const touched = touchedCrates(root, changed === undefined ? undefined : [...changed]);
if (touched.length > 0) {
    if (!rustfmtAvailable(root)) {
        say(`rustfmt is not available here, so ic-check and desktop-check decide formatting in CI (${touched.join(", ")})`);
    } else {
        for (const crate of touched) {
            step(`cargo fmt --check (${crate})`, "cargo", ["fmt", "--manifest-path", join(crate, "Cargo.toml"), "--all", "--check"]);
        }
    }
}

// KEPT FOR LATER, before the digest: finish() may end the process when run by hand. Only the hook keeps findings, since
// only there did something go: a run by hand pushed nothing, so it keeps its measurement alone, which still clears what
// earlier pushes left and is fixed since. A hook run naming no push (tags, deletions) has left already.
const kept = (() => {
    if (!hook) {
        const written = writeReport(root, measureEntry(verdicts, lint));
        return written.ok ? undefined : { ...written, findings: 0 };
    }
    if (pushes.length === 0) {
        return undefined;
    }
    try {
        const entry = pushEntry(root, {
            remote: remoteName,
            pushes: pushes.map(({ ref, local, base }) => ({ ref, head: local, base })),
            findings: [...findings, ...stepFindings(failedSteps())],
            verdicts,
            lint,
        });
        return { ...writeReport(root, entry), findings: entry.findings.length };
    } catch (error) {
        // Handled by saying it: a push is never held back, nor its exit changed, by its own bookkeeping going wrong.
        return { ok: false, why: error instanceof Error ? error.message : String(error), findings: 0 };
    }
})();
if (kept?.ok === false && !failing()) {
    say(`this measurement could not be kept for later: ${kept.why}`);
}
// The digest's last line, where the pusher looks: where the findings went, or that they went nowhere. Undefined leaves
// the default, for a run that kept nothing (no push named) or failed without a finding of its own to keep.
const closing = () => {
    if (kept === undefined) {
        return undefined;
    }
    if (!kept.ok) {
        return `${advisory ? "reported, not refused, and " : ""}could not be kept for later: ${kept.why}`;
    }
    const one = kept.findings === 1;
    return kept.findings === 0
        ? undefined
        : `${kept.findings} finding${one ? "" : "s"} left for later: ${one ? "it waits" : "they wait"} in the Main line (Left at push) until a later ` +
              `check stops finding ${one ? "it" : "them"} or ${one ? "it is" : "they are"} dismissed`;
};

// Prints everything both tiers found; a tree already refused cheaply doesn't go on to the ten-minute suite.
finish(() => "the checkout gates, the assertion ratchet, the manifest/lockfile lockstep, the linter and rustfmt", { closing: closing() });

// The hook stops here, whatever was found: the suite is the land check's and CI's to run, never the pusher's to wait on.
if (advisory) {
    const known = freshVerdicts(root, [treeHash(root)]).find((verdict) => verdict.suite === "verify");
    say(
        known === undefined
            ? "typecheck, build and tests are not run at a push: the check after each land measures the tree, and CI measures the commit"
            : `this tree ${known.status === "passed" ? "passed" : "FAILED"} \`pnpm verify\` after its land ${ago(known.at)}; CI measures the commit either way`,
    );
    process.exit(0);
}

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
    // INDEXNOW_ENABLED=0, or the site build polls the live site. TEST_WORKERS and the task count are sized to the free
    // memory (test-workers.mjs), since `turbo run build test` bypasses the root `test` script; a caller's own value wins.
    const env = { ...process.env, INDEXNOW_ENABLED: "0", TEST_WORKERS: testWorkers() };
    const linked = isLinkedWorktree();
    if (linked) {
        say("a linked worktree: `build` cannot run here (EXDEV), so tests run off the prepass dist");
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
                  ? ["pnpm turbo run test --only", ["turbo", "run", "test", "--only", "--continue=dependencies-successful", `--concurrency=${testConcurrency()}`]]
                  : ["pnpm turbo run build test", ["turbo", "run", "build", "test", "--continue=dependencies-successful", `--concurrency=${testConcurrency()}`]],
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
const failedVerify = fresh.find((verdict) => verdict.status === "failed" && verdict.suite === "verify");
if (!replay && failedVerify !== undefined) {
    say(
        `this tree FAILED \`pnpm verify\` ${ago(failedVerify.at)}${(failedVerify.failedTasks ?? []).length > 0 ? ` in ${failedVerify.failedTasks.join(", ")}` : ""}; CI's verify groups will fail the same`,
    );
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
