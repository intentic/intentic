#!/usr/bin/env node
// `pnpm verify:turn`: what a turn can answer for at Stop, scoped to what it touched since its main-line base, committed
// on the branch or not (the full repository runs after the land, in verify.mjs). Four independent readers, each judged
// against that base: (1) the checks, line by line (turn-findings.mjs), a new line refused whatever its gate; (2) the
// linter over the changed files; (3) the assertion ratchet over the changed test files; (4) typecheck+test over the
// affected closure (lib/workspace-graph.mjs), re-run once before a failure is charged.
// Every reader reports before the digest (lib/steps.mjs): the Stop sends a model back at most twice (MAX_FOLLOW_UPS,
// sandbox/src/rules/turn-ending.ts), and quotes only the last ~4,000 bytes, which the digest is sized to fit.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affectedBy, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { changedPaths, changedSince, mainLineBase } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { ago, verdictForBase } from "../lib/tree-verdict.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { weakenings } from "./assertion-ratchet.mjs";
import { againstBaseline, failedTasks, failureLines, rerunCommand, takeSummary, taskOf, unitsOf } from "./failure-units.mjs";
import { fixChecks, formatCrates, regenerateContractLock, rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { recordFlakes, rerunFailures } from "./flakes.mjs";
import { LINTABLE } from "./land-tiers.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";
import { testWorkers } from "./test-workers.mjs";

const root = repoRoot(import.meta.url);
const { say, step, skip, fail, finish } = createSteps("verify:turn", root);
// Past this many changed paths the turn is not a delta any more (a rename, a generated bundle, a land in the
// primary checkout), and a command line naming each of them is worse than the one that names none.
const LINT_FILE_CEILING = 200;
// One oxlint `unix` diagnostic, `path:line:col: message [Severity/rule]`.
const LINT_FINDING = /^(\S.*?):\d+:\d+: .* \[\w+\/.+\]$/;

// The main-line commit this turn builds on; its work is everything since, committed on the branch or not.
const base = mainLineBase(root);
const turnPaths = () => (base === undefined ? changedPaths(root) : changedSince(root, base));

/* 0. what a machine decides is written before anything is judged */
const formatted = rustfmtAvailable(root) ? formatCrates(root, touchedCrates(root, turnPaths() ?? [])) : [];
if (formatted.length > 0) {
    say(`formatted before judging: ${formatted.join(", ")} (cargo fmt)`);
}

/* 1. the checks, judged against the main-line base */
say("checkout gates …");
let verdicts = checkVerdicts(root);
const fixedChecks = verdicts === undefined ? [] : fixChecks(root, verdicts);
if (fixedChecks.length > 0) {
    say(`${fixedChecks.join(", ")} fixed the tree themselves before it was judged`);
    verdicts = checkVerdicts(root);
}
if (verdicts === undefined) {
    fail("checkout gates", "could not be measured · node _tools/checks/run.mjs --tidy=warn");
} else {
    // A check that could not measure judged nothing, so it has no problems to attribute and must never hold a turn: its
    // tool moved, which is not something this turn's diff can answer for and not something a model should be sent back
    // to fix at random.
    const unmeasured = verdicts.filter((verdict) => !verdict.measured);
    if (unmeasured.length > 0) {
        say(
            `${unmeasured.map(({ id }) => id).join(", ")}: could not measure, so nothing here is vouched for — the check needs a look, the tree is not accused`,
        );
    }
    const failed = verdicts.filter((verdict) => !verdict.ok && verdict.measured);
    if (failed.length === 0) {
        say(`checkout gates: ${verdicts.filter(({ ok }) => ok).length} passed`);
    } else {
        // THE ONE QUESTION THIS SECTION ASKS: which of these lines were not here before. A `tidy` rule is a real cost
        // with a measurement behind it, and what it must never do is refuse an actor for a tree it did not make — a
        // directory somebody else filled, a baseline somebody else's deletion left stale. None of that is true of a line
        // THIS turn wrote, which is why the refusal belongs here: it is the earliest gate that can tell the two apart,
        // and the only one still holding the model that wrote the line.
        //
        // NOT THE LAST ONE, THOUGH, AND THE DIFFERENCE IS THE WHOLE OF WHY THE NIGHTLY WENT RED. A turn measures its own
        // worktree against its own HEAD — a tree that never becomes main. Two turns that each add one file to a
        // directory of thirty are each green here and over the limit once they land together. verify-push asks this same
        // question of the push RANGE, which is the first tree that does become main, and docs/audits/tidy-job.md is the
        // measurement that put it there.
        const before = reportsAt(
            root,
            base ?? "HEAD",
            failed.map(({ id }) => id),
        );
        const judged = judgeAgainstBase(failed, before);
        const mine = judged.filter(({ added }) => added.length > 0);
        const unsure = judged.filter(({ added, unsure: lines }) => added.length === 0 && lines.length > 0);
        const theirs = judged.filter(({ added, unsure: lines }) => added.length === 0 && lines.length === 0);
        if (theirs.length > 0) {
            say(
                `${theirs.map(({ verdict }) => verdict.id).join(", ")}: failing at this turn's base too and no worse for it, so not this turn's to fix — the land measures the tree it leaves behind`,
            );
        }
        // Reported in full and charged to nobody: the snapshot could not put these checks where the live run stands, so
        // whether a line is new is a question nothing here can answer. Printed rather than counted, because somebody has
        // to be told what was found even when there is no one to hold to it.
        for (const { verdict, unsure: lines } of unsure) {
            process.stderr.write(
                `\n? ${verdict.id} (${verdict.file}), ${lines.length} problem${lines.length === 1 ? "" : "s"} the base could not be asked about — reported, not laid at this turn's door\n${lines.join("\n")}\n`,
            );
        }
        for (const { verdict, added } of mine) {
            process.stderr.write(
                `\n✗ ${verdict.id} (${verdict.file}), ${added.length} problem${added.length === 1 ? "" : "s"} this turn introduced\n${added.join("\n")}\n`,
            );
        }
        if (mine.length > 0) {
            const ids = mine.map(({ verdict }) => verdict.id);
            fail("checkout gates", `${ids.length} check(s) this turn broke: ${ids.join(", ")} · node _tools/checks/run.mjs --only ${ids.join(",")}`);
        }
    }
}

/* 2. the linter, over the changed files */
// Staged, unstaged and untracked alike, a rename by its new name (lib/git.mjs). `undefined` (git couldn't answer)
// widens this and the closure below to everything, rather than narrowing to nothing.
const changed = turnPaths();
const lintable = (changed ?? []).filter((path) => LINTABLE.test(path) && existsSync(join(root, path)));
if (changed === undefined || lintable.length > LINT_FILE_CEILING) {
    say(
        changed === undefined
            ? "git could not list the tree's changes, so the linter reads the whole repository"
            : `${lintable.length} changed files to lint, past the ${LINT_FILE_CEILING} this names one by one: linting the whole repository instead`,
    );
    step("lint", "pnpm", ["lint"]);
} else if (lintable.length === 0) {
    say("lint: no changed file the linter reads");
} else {
    // Run directly rather than through `step`, since the answer needs reading: oxlint applies `ignorePatterns` to the
    // paths it's handed, and exits 1 with "No files found to lint" when all of them are ignored, the one non-zero exit
    // here that means success.
    const label = `lint (${lintable.length} changed file${lintable.length === 1 ? "" : "s"})`;
    const lint = spawnSync("pnpm", ["lint", "--format=unix", ...lintable], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === "win32",
    });
    const output = `${lint.stdout ?? ""}${lint.stderr ?? ""}`;
    if (lint.error !== undefined) {
        say(`lint skipped: ${lint.error.message}`);
    } else if (/No files found to lint/.test(output)) {
        say(`lint: all ${lintable.length} of this turn's files are ones the linter's config ignores`);
    } else if (lint.status !== 0) {
        process.stderr.write(output);
        const findings = output.split("\n").filter((line) => LINT_FINDING.test(line));
        const files = [...new Set(findings.map((line) => LINT_FINDING.exec(line)[1]))];
        fail(label, `exit ${lint.status ?? "signal"} · pnpm lint ${(files.length > 0 ? files : lintable).join(" ")}`, findings);
    } else {
        say(`${label}: clean`);
    }
}

/* 3. the assertion ratchet */
if (base === undefined) {
    say("assertion ratchet: no main-line base to measure the changed test files against");
} else {
    const measured = weakenings(root, base);
    if (measured === undefined) {
        fail("assertion ratchet", `git could not list the test files changed since ${base.slice(0, 9)}, so none was measured`);
    } else if (measured.findings.length === 0) {
        say("assertion ratchet: no test file got weaker");
    } else if (measured.declared) {
        say(`assertion ratchet: ${measured.findings.length} test file(s) got weaker, declared by a \`test!:\` subject or \`Test-Note:\` trailer in the turn's commits`);
    } else {
        fail(
            "assertion ratchet",
            "a test file got weaker than on the main line: restore the assertions (update the expected value, not the matcher), or commit the weakening with a `Test-Note: <why>` trailer and end your final message with the same line",
            measured.findings,
        );
    }
}

/* 4. the affected closure */
const graph = readWorkspaceGraph(root);
const { global, seeds, affected } = affectedBy(graph, changed ?? [...graph.packages.values()].map(({ dir }) => dir));
if (global !== undefined) {
    say(`${global} changed, which every package depends on: measuring all ${affected.size}`);
} else if (affected.size === 0) {
    say(`no workspace package holds a changed file (${(changed ?? []).length} changed paths); nothing to type-check or test`);
} else {
    say(`${seeds.size} changed package${seeds.size === 1 ? "" : "s"}, ${affected.size} in the closure: ${[...affected].sort().join(", ")}`);
}

// Lines of a failure list shown before the rest is counted, so the digest after it survives the Stop's output tail.
const LISTED = 30;
const list = (units) => [...units.slice(0, LISTED).map((unit) => `  ${unit}`), ...(units.length > LISTED ? [`  …and ${units.length - LISTED} more`] : [])].join("\n");

// Which main-line tree a land verdict measured, for the line that says a failure was already there.
const measuredAt = ({ verdict, distance }) =>
    `main at ${(verdict.head ?? base ?? "").slice(0, 9)}${distance > 0 ? `, ${distance} commit(s) before this turn's base` : ""}, measured ${ago(verdict.at)}`;

// Failures that pass when re-run alone are logged as flakes and dropped from the verdict.
const withoutFlakes = (tasks, units) => {
    const { flaky, still } = rerunFailures(root, tasks, units);
    if (flaky.length > 0) {
        recordFlakes(root, flaky);
        process.stderr.write(`\n~ ${flaky.length} failure(s) passed when re-run alone: flaky, logged, not held:\n${list(flaky)}\n`);
    }
    return still;
};

// The closure's failures against the land verdict for this turn's base: what main already failed is named, never held.
const judgeClosure = (tasks, units) => {
    if (units.length === 0) {
        return { ok: false, why: "failed with no task summary to read the failures from" };
    }
    const current = withoutFlakes(tasks, units);
    if (current.length === 0) {
        return { ok: true, note: "every failure passed when re-run alone: flaky, logged" };
    }
    const found = base === undefined ? undefined : verdictForBase(root, base);
    const { held, standing, unsure } = againstBaseline(current, found?.verdict);
    if (standing.length > 0) {
        process.stderr.write(`\n= ${standing.length} failure(s) already red on ${measuredAt(found)}, not this turn's to fix:\n${list(standing)}\n`);
    }
    if (unsure.length > 0) {
        process.stderr.write(`\n? ${unsure.length} failure(s) in a task that verdict cut short, reported and not held:\n${list(unsure)}\n`);
    }
    if (held.length === 0) {
        return { ok: true, note: `every failure was already red on ${measuredAt(found)}; nothing this turn introduced` };
    }
    const failing = tasks.filter(({ taskId }) => held.some((unit) => taskOf(unit) === taskId));
    return {
        ok: false,
        why: found === undefined ? `${held.length} failure(s); no land verdict covers this turn's base, so every one counts` : `${held.length} failure(s) this turn introduced`,
        spelling: rerunCommand(failing),
        details: [`failing tasks: ${failing.map(({ taskId }) => taskId).join(", ")}`, ...failureLines(root, held, tasks)],
    };
};

// The failed tasks of the turbo run that started at `at` (epoch ms), and their units.
const measure = (at, junitDir) => {
    const tasks = failedTasks(takeSummary(root, at));
    return { tasks, units: unitsOf(root, tasks, junitDir) };
};

// A failed closure runs once more before it is judged; turbo replays cached passes, so only the failed tasks execute.
const judgeAfterRerun = (args, env, since, junitDir) => {
    const first = measure(since, junitDir);
    const found = base === undefined ? undefined : verdictForBase(root, base);
    if (first.units.length > 0 && againstBaseline(first.units, found?.verdict).held.length === 0) {
        return judgeClosure(first.tasks, first.units);
    }
    const failed = first.tasks.map(({ taskId }) => taskId).join(", ") || "the run";
    say(`typecheck and test: ${failed} failed; running it once more`);
    const again = Date.now();
    const rerun = spawnSync("pnpm", [...args, "--output-logs=errors-only"], {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: { ...process.env, ...env },
    });
    const second = measure(again, junitDir);
    if (rerun.status === 0) {
        recordFlakes(root, first.units);
        return { ok: true, note: `${failed} failed, then passed on a re-run: flaky, logged` };
    }
    if (second.units.length === 0) {
        return judgeClosure(first.tasks, first.units);
    }
    const cleared = first.units.filter((unit) => !second.units.includes(unit));
    if (cleared.length > 0) {
        recordFlakes(root, cleared);
        process.stderr.write(`\n~ ${cleared.length} failure(s) passed on the re-run: flaky, logged, not held:\n${list(cleared)}\n`);
    }
    return judgeClosure(second.tasks, second.units);
};

// The emit is the one thing the closure's check reads; after a failed one, typecheck would report missing modules
// against correct files, which is why this pair is a dependency and the two steps above aren't.
if (affected.size > 0) {
    if (step("emit declarations", process.execPath, [join(root, "_tools/scripts/build/emit-declarations.mjs")])) {
        if (regenerateContractLock(root, changed)) {
            say("contract.lock.json rewritten from the contract this turn changed");
        }
        const filters = global !== undefined ? [] : [...affected].flatMap((name) => ["--filter", name]);
        const junitDir = mkdtempSync(join(tmpdir(), "verify-turn-junit-"));
        const args = ["turbo", "run", "typecheck", "test", "--only", "--continue=dependencies-successful", "--summarize", ...filters];
        const env = { TEST_WORKERS: testWorkers(), INDEXNOW_ENABLED: "0", SUITES_JUNIT_DIR: junitDir };
        const since = Date.now();
        step("typecheck and test", "pnpm", args, {
            env,
            shown: `pnpm turbo run typecheck test --only over the ${affected.size}-package closure`,
            judge: () => judgeAfterRerun(args, env, since, junitDir),
        });
        takeSummary(root, since);
        rmSync(junitDir, { recursive: true, force: true });
    } else {
        skip("typecheck and test", "the declarations it reads were not emitted");
    }
}

finish(() =>
    affected.size === 0
        ? "the checkout gates, the linter and the assertion ratchet; nothing in this turn's closure to measure"
        : `the turn's closure: ${affected.size} package${affected.size === 1 ? "" : "s"}`,
);
