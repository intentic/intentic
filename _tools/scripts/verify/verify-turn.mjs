#!/usr/bin/env node
// `pnpm verify:turn`: an optional check a person runs by hand on a branch's own change. Nothing runs it automatically,
// no turn waits on it, and agents are not asked to run it: the check work gets is verify.mjs, on the main tree after the
// land. Scoped to what the branch touched since its main-line base, committed or not. Four independent readers, each
// judged against that base: (1) the checks, line by line (turn-findings.mjs), a new line counted whatever its gate; (2)
// the linter over the changed files; (3) the assertion ratchet over the changed test files; (4) typecheck over the
// packages the change reaches, and only the test files whose imports reach a changed file (turn-closure.mjs), one step
// at a time and sized to the memory free when it starts (test-workers.mjs). It waits for the sandbox's heavy slot
// first (heavy-slot.mjs), so two of these never fill the machine together.
// Every reader reports before the digest (lib/steps.mjs), which lists every failure together at the end of the output.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { changedPaths, changedSince, mainLineBase } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { runInHeavySlot } from "../lib/heavy-slot.mjs";
import { ago, verdictForBase } from "../lib/tree-verdict.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { weakenings } from "./assertion-ratchet.mjs";
import { againstBaseline, failedTasks, failureLines, rerunCommand, takeSummary, taskOf, unitsOf } from "./failure-units.mjs";
import { fixChecks, formatCrates, regenerateContractLock, regenerateStateShapes, rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { recordFlakes, rerunFailures, testUnitParts } from "./flakes.mjs";
import { LINTABLE } from "./land-tiers.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";
import { standaloneWorkers, typecheckConcurrency } from "./test-workers.mjs";
import { turnClosure } from "./turn-closure.mjs";

// Nothing below runs beside another heavy run: outside the sandbox's heavy slot this waits for it (heavy-slot.mjs).
runInHeavySlot("verify-turn");

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
    // A check that could not measure judged nothing, so it has no problems to attribute and fails nothing here: its tool
    // moved, which is not something this branch's diff can answer for.
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
        // with a measurement behind it, and what it must never do is charge an actor for a tree it did not make: a
        // directory somebody else filled, a baseline somebody else's deletion left stale. None of that is true of a line
        // THIS branch wrote, which is why a new line counts here whatever its gate: this is the earliest run that can
        // tell the two apart.
        //
        // NOT THE LAST ONE, THOUGH, AND THE DIFFERENCE IS THE WHOLE OF WHY THE NIGHTLY WENT RED. A branch is measured
        // here in its own worktree against its own base, a tree that never becomes main. Two branches that each add one
        // file to a directory of thirty are each green here and over the limit once they land together. The check after
        // each land (land-tiers.mjs) asks this same question of the main tree the land left, and verify-push asks it of
        // the push RANGE.
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

/* 4. the change's closure: typecheck what it reaches, test what it touched (turn-closure.mjs) */
const graph = readWorkspaceGraph(root);
const closure = changed === undefined ? undefined : turnClosure(root, graph, changed);
const tested = closure === undefined ? [] : [...closure.tests];
if (closure === undefined) {
    say("git could not list the tree's changes, so there is no closure to typecheck or test; the check after the land measures the whole tree");
} else if (closure.global !== undefined) {
    say(`${closure.global} changed, which every package depends on: typechecking all ${closure.typecheck.size}; their suites run after the land`);
} else if (closure.typecheck.size === 0) {
    say(`no workspace package holds a changed file (${changed.length} changed paths); nothing to typecheck or test`);
} else {
    const files = tested.map(([name, chosen]) => `${name} (${chosen === "all" ? "whole suite" : `${chosen.length} file${chosen.length === 1 ? "" : "s"}`})`);
    say(`typecheck: ${closure.typecheck.size} package${closure.typecheck.size === 1 ? "" : "s"} (${[...closure.typecheck].sort().join(", ")})`);
    say(`tests: ${files.length === 0 ? "no test file imports a changed file" : files.join(", ")}; the rest run after the land`);
}

// Lines of a failure list shown before the rest is counted, so the digest after it stays in a truncated tail.
const LISTED = 30;
const list = (units) => [...units.slice(0, LISTED).map((unit) => `  ${unit}`), ...(units.length > LISTED ? [`  …and ${units.length - LISTED} more`] : [])].join("\n");

// Which main-line tree a land verdict measured, for the line that says a failure was already there.
const measuredAt = ({ verdict, distance }) =>
    `main at ${(verdict.head ?? base ?? "").slice(0, 9)}${distance > 0 ? `, ${distance} commit(s) before this turn's base` : ""}, measured ${ago(verdict.at)}`;

// The failures of the turbo run that started at `since`, judged: a test failing only in company is re-run alone once
// (flakes.mjs) and logged as a flake when it passes, and what main already failed is named, never held. No whole run
// is repeated: a real failure fails twice for twice the memory, and a flaky one is what the re-run alone is for.
const judgeRun = (since, junitDir, spell) => {
    const tasks = failedTasks(takeSummary(root, since));
    const units = unitsOf(root, tasks, junitDir);
    if (units.length === 0) {
        return { ok: false, why: "failed with no task summary to read the failures from" };
    }
    const { flaky, still } = rerunFailures(root, tasks, units);
    if (flaky.length > 0) {
        recordFlakes(root, flaky);
        process.stderr.write(`\n~ ${flaky.length} failure(s) passed when re-run alone: flaky, logged, not held:\n${list(flaky)}\n`);
    }
    if (still.length === 0) {
        return { ok: true, note: "every failure passed when re-run alone: flaky, logged" };
    }
    const found = base === undefined ? undefined : verdictForBase(root, base);
    const { held, standing, unsure } = againstBaseline(still, found?.verdict);
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
        spelling: spell(failing, held),
        details: failureLines(root, held, tasks),
    };
};

// The test files a unit list names in one task, package-relative, for a re-run command that runs only those.
const failingFiles = (task, units) => [
    ...new Set(units.filter((unit) => taskOf(unit) === task.taskId).flatMap((unit) => testUnitParts(unit, task)?.file ?? [])),
];

// One step at a time, typecheck before tests: the two used to share one turbo run, each typecheck beside four test
// tasks' workers, which is how a single check came to fill a 32 GB machine.
// The emit is the one thing both read; after a failed one, typecheck would report missing modules against correct
// files, which is why this pair is a dependency and the steps above aren't.
if (closure !== undefined && closure.typecheck.size > 0) {
    if (step("emit declarations", process.execPath, [join(root, "_tools/scripts/build/emit-declarations.mjs")])) {
        if (regenerateContractLock(root, changed)) {
            say("contract.lock.json rewritten from the contract this turn changed");
        }
        if (regenerateStateShapes(root, changed)) {
            say("state-shapes.json froze a new shape of a stored document; the typecheck judges whether older ones still convert");
        }
        const filters = closure.global !== undefined ? [] : [...closure.typecheck].flatMap((name) => ["--filter", name]);
        const typecheckSince = Date.now();
        step(
            "typecheck",
            "pnpm",
            ["turbo", "run", "typecheck", "--only", "--continue=always", "--summarize", `--concurrency=${typecheckConcurrency()}`, "--output-logs=errors-only", ...filters],
            {
                shown: `pnpm turbo run typecheck --only over ${closure.typecheck.size} package${closure.typecheck.size === 1 ? "" : "s"}`,
                judge: () => judgeRun(typecheckSince, undefined, (failing) => rerunCommand(failing)),
            },
        );
        takeSummary(root, typecheckSince);
        // Bun strips types, so a suite means something on a tree that does not typecheck: the tests run either way.
        for (const [name, chosen] of tested) {
            const junitDir = mkdtempSync(join(tmpdir(), "verify-turn-junit-"));
            const files = chosen === "all" ? [] : chosen;
            const workers = Math.max(1, Math.min(Number(standaloneWorkers()), files.length === 0 ? Number.POSITIVE_INFINITY : files.length));
            const since = Date.now();
            step(`test ${name}`, "pnpm", ["turbo", "run", "test", "--only", "--summarize", "--output-logs=errors-only", "--filter", name, ...(files.length > 0 ? ["--", ...files] : [])], {
                env: { TEST_WORKERS: String(workers), INDEXNOW_ENABLED: "0", SUITES_JUNIT_DIR: junitDir },
                shown: `pnpm --filter ${name} test${files.length > 0 ? ` (${files.length} file${files.length === 1 ? "" : "s"})` : ""}`,
                judge: () =>
                    judgeRun(since, junitDir, (failing, held) =>
                        failing
                            .map((task) => `pnpm --filter ${task.name} test ${failingFiles(task, held).join(" ")}`.trim())
                            .join(" && "),
                    ),
            });
            takeSummary(root, since);
            rmSync(junitDir, { recursive: true, force: true });
        }
    } else {
        skip("typecheck and tests", "the declarations they read were not emitted");
    }
}

finish(() =>
    closure === undefined || closure.typecheck.size === 0
        ? "the checkout gates, the linter and the assertion ratchet; nothing in this turn's closure to measure"
        : `typecheck over ${closure.typecheck.size} package${closure.typecheck.size === 1 ? "" : "s"}, tests the change reaches in ${tested.length}`,
);
