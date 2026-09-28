#!/usr/bin/env node
// THE PUSH CHECK: what a range of commits broke that a checkout can tell in seconds. CI's `quick` job runs it on every
// push (`--base <sha>`, the commit that push is measured against), and `pnpm verify:push` runs it by hand, the branch
// against where it left its upstream. Nothing runs it on the way out: no check holds back a land, a commit or a push in
// this repository, and when main goes red the sandbox's one CI fix agent takes the failed job's log
// (_sandbox/sandbox/src/ci/main-fixer.ts).
//
// Every step runs even after one fails, so whoever reads it gets all of it at once (lib/steps.mjs), cheapest first:
// every check the manifest lists, a `tidy` finding counted only when the range added it; the assertion ratchet over the
// range's test files; the linter over the files the range changed. By hand it also asks the two questions only a working
// tree can: whether a manifest is committed without the lockfile change beside it, and whether the crates the range
// touched are formatted (in CI the checkout holds nothing uncommitted, and the crate jobs run `cargo fmt --check`).
// Exits 1 on a finding. Typecheck, build and test are not its to run: the quick job type-checks what the push changed,
// the verify groups measure the rest, and `pnpm verify` runs them all here.
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { LINTABLE } from "../../oxlint/added.mjs";
import { changedPaths as treeChangedPaths, git as gitIn } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { checkVerdicts } from "./check-snapshot.mjs";
import { rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { judgeTidy, LINT_COMMAND, runLint } from "./measure-change.mjs";

const root = repoRoot(import.meta.url);
const argv = process.argv.slice(2);
// The commit CI measures the push against. Absent, the range is the branch since it left its upstream.
const baseArg = argv.includes("--base") ? (argv[argv.indexOf("--base") + 1] ?? "") : undefined;

const { say, step, fail, finish } = createSteps("verify-push", root);

// Bound to this checkout, so a large diff isn't misread as a failed git call (lib/git.mjs's larger maxBuffer).
const git = (...args) => gitIn(root, ...args);

const head = git("rev-parse", "-q", "--verify", "HEAD")?.trim();
// Where the range starts: the commit `--base` names, or where the branch left its upstream. Undefined when neither can be
// named (a branch never pushed, a sha this clone lacks), and then each step that judges a range says it cannot.
const base = (() => {
    if (head === undefined) {
        return undefined;
    }
    if (baseArg !== undefined) {
        return git("rev-parse", "-q", "--verify", `${baseArg}^{commit}`)?.trim();
    }
    const upstream = git("rev-parse", "-q", "--verify", "@{u}")?.trim();
    return upstream === undefined ? undefined : git("merge-base", upstream, head)?.trim();
})();
if (baseArg !== undefined && base === undefined) {
    fail("range", `--base ${baseArg === "" ? "was given no commit" : `${baseArg} is not a commit this clone holds`}, so nothing about the range can be measured`);
}
// The commits the range carries, or none: a base that is the head itself carries nothing.
const range = base === undefined || base === head ? undefined : [base, head];
if (range !== undefined) {
    say(`measuring ${range[0].slice(0, 9)}..${range[1].slice(0, 9)}${baseArg === undefined ? ", the branch since it left its upstream" : ""}`);
}

// The paths the range changes, deletions included; undefined when there is no range to ask about.
const changed = (() => {
    const listing = range === undefined ? undefined : git("diff", "--name-only", "-z", ...range);
    return listing === undefined ? undefined : listing.split("\0").filter(Boolean);
})();

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
    // Read, not assumed missing: a deleted lockfile shouldn't crash the check instead of reporting it.
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

// THE CHECKS, WITH TIDINESS JUDGED AGAINST THE COMMIT THE RANGE IS BUILT ON.
//
// A `code` failure fails outright: the tree does not work, and it does not matter who made it so. A `tidy` failure is
// a real cost with a measurement behind it (manifest.mjs splits the two by what a failure MEANS), and it used to fail
// nowhere anybody could act: `--tidy=warn` waves every one of them through CI's preflight, and nightly.yml's `tidy` job
// read them the next morning on a commit with no author attached. That job then failed on 14 of its 24 runs, 13 of them
// for `layout` or `paths`, every finding traceable to one line in one commit a day or two old.
//
// WHERE THE WORK MEETS. A branch measured against its own base is a tree that never becomes main. What becomes main is
// the pushed range, and the difference between the two is every other conversation's work, which is exactly where a
// counting rule breaks: two branches that each add one file to a directory of thirty are each innocent in their own
// worktree and over the limit together. Lands meet on the main tree, and the push is where their sum is first asked this
// question, of the whole range.
//
// Judged against the base rather than failed wholesale, for the reason the tidy job's own comment gives: a gate that
// fails a push for state nobody in it produced teaches everyone that red means nothing. What fails is the lines the range
// ADDED (turn-findings.mjs); what was already standing is named and charged to no one. The judging is measure-change.mjs's
// (judgeTidy), `Allow:` trailers in the range included.
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
        // Without a base there is no before, and a finding cannot be told from one the tree arrived with: reported, and
        // left to the nightly that reads the tree it lands in.
        if (untidy.length > 0 && base === undefined) {
            for (const verdict of untidy) {
                show("?", verdict, `${verdict.stderr}${verdict.stdout}`.trimEnd());
            }
            say(`${untidy.map(({ id }) => id).join(", ")}: no base to measure the range against, so these are reported and not failed`);
        } else if (untidy.length > 0) {
            // An `Allow: <check> — <reason>` trailer in the range accepts what it adds to that check (lib/allow.mjs).
            const { mine, excused, unsure, theirs } = judgeTidy(root, base, untidy);
            if (excused.length > 0) {
                say(`${excused.map(({ verdict, reasons }) => `${verdict.id} (${reasons.join("; ")})`).join(", ")}: declared by an Allow: trailer in the range`);
            }
            if (theirs.length > 0) {
                say(
                    `${theirs.map(({ verdict }) => verdict.id).join(", ")}: already failing at ${base.slice(0, 9)} and no worse for this range, so not this range's to fix`,
                );
            }
            for (const { verdict, unsure: lines } of unsure) {
                show(
                    "?",
                    verdict,
                    `${lines.length} problem(s) ${base.slice(0, 9)} could not be asked about — reported, not laid at this range's door\n${lines.join("\n")}`,
                );
            }
            for (const { verdict, added } of mine) {
                show("✗", verdict, `${added.length} problem(s) this range introduces\n${added.join("\n")}`);
            }
            if (mine.length > 0) {
                const ids = mine.map(({ verdict }) => verdict.id);
                fail("tidiness", `${ids.length} tidy check(s) this range breaks: ${ids.join(", ")} · node _tools/checks/run.mjs --only ${ids.join(",")}`);
            }
        }
        if (broken.length === 0 && untidy.length === 0) {
            say(`checkout gates: ${verdicts.filter(({ ok }) => ok).length} passed`);
        }
    }
}

if (range === undefined) {
    say("assertion ratchet: no range to measure, so the test files leave unmeasured (CI measures the tree they land in)");
} else {
    step(`assertion ratchet (${range[0].slice(0, 9)}..${range[1].slice(0, 9)})`, process.execPath, [
        join(root, "_tools/scripts/verify/assertion-ratchet.mjs"),
        ...range,
    ]);
}

// The linter over the files the range added or changed, read one way (measure-change.mjs). A linter that could not run
// fails the step: a check that stops checking and reports success is the one this pipeline keeps producing.
{
    const files = changed?.filter((path) => LINTABLE.has(extname(path)) && existsSync(join(root, path)));
    const lint = files === undefined ? undefined : runLint(root, files);
    if (lint === undefined) {
        say("lint: no range to measure, so no file is linted (CI's quick job lints what a push changed)");
    } else if (!lint.ran) {
        fail("lint", `could not run: ${lint.why ?? "it did not start"}`, [], { spelling: LINT_COMMAND });
    } else if (lint.findings.length > 0) {
        for (const { text } of lint.findings) {
            process.stderr.write(`${text}\n`);
        }
        fail("lint", `${lint.findings.length} finding(s) on files this range changes`, lint.findings.map(({ text }) => text), { spelling: LINT_COMMAND });
    } else {
        say(`lint: ${files.length} changed file(s), no finding`);
    }
}

if (baseArg === undefined) {
    const LOCKSTEP = /(^|\/)package\.json$|^pnpm-workspace\.yaml$|^pnpm-lock\.yaml$/;
    const committed = (changed ?? []).filter((path) => LOCKSTEP.test(path));
    const uncommitted = (treeChangedPaths(root) ?? []).filter((path) => LOCKSTEP.test(path));
    if (committed.length > 0 && uncommitted.length > 0) {
        // The one case nobody typed: pnpm rewrites `packageManagerDependencies` from every command it runs.
        const rewriteOnly = uncommitted.length === 1 && uncommitted[0] === "pnpm-lock.yaml" && lockfileRewriteOnly();
        fail(
            "manifest/lockfile lockstep",
            rewriteOnly
                ? `the range commits ${committed.join(", ")} while pnpm-lock.yaml is changed and uncommitted beside it — and the only thing changed in it is the ` +
                      `\`packageManagerDependencies\` block, which pnpm rewrites from every command it runs. Nobody typed that: \`git checkout -- pnpm-lock.yaml\` ` +
                      `and check again`
                : `the range commits ${committed.join(", ")} while ${uncommitted.join(", ")} ${uncommitted.length === 1 ? "is" : "are"} changed and uncommitted ` +
                      `beside it; CI's checkout gets the first without the second and fails the lockfile check (the lockfile no longer records the manifest). ` +
                      `Commit them together`,
        );
    }

    const touched = touchedCrates(root, changed);
    if (touched.length > 0 && !rustfmtAvailable(root)) {
        say(`rustfmt is not available here, so the crate jobs decide formatting in CI (${touched.join(", ")})`);
    } else {
        for (const crate of touched) {
            step(`cargo fmt --check (${crate})`, "cargo", ["fmt", "--manifest-path", join(crate, "Cargo.toml"), "--all", "--check"]);
        }
    }
}

finish(() =>
    baseArg === undefined
        ? "the checkout gates, the assertion ratchet, the linter, the manifest/lockfile lockstep and rustfmt"
        : "the checkout gates, the assertion ratchet and the linter",
);
