#!/usr/bin/env node
// Flaky test cases leave the gate's verdict for a while, in CI only. Between 2026-10-23 and 11-05, 134 of 222 main
// pipelines failed and 136 of the 255 distinct failing tests failed in exactly one run: a test that fails once and then
// passes with nothing changed says the box was busy, not that the code broke. Six runner processes share one box
// (docs/ops/ci-runner.md).
//
// A test case is LISTED when, in a gate job (verify.yml):
//   - it failed and then passed when re-run alone (flakes.mjs's re-run, the one `pnpm verify` uses by hand), or
//   - it failed on main and passed on a later main run with nothing it is built from changed: its package's tracked
//     files, its dependencies' build hashes and the external dependency hash, all read from turbo's run summary.
// While listed, the gate does not count its failure: the job still runs it (bun can skip a case only by a name pattern
// that applies to every file at once, which would skip same-named tests elsewhere), but a failure of nothing else
// passes the job. Every gate run names every listed test as a warning annotation and in the step summary.
//
// It never hides a regression for long: an entry expires after QUARANTINE_DAYS and is back in the verdict; nightly.yml
// re-runs every listed test alone each night, releases one that passed RELEASE_NIGHTS nights in a row, and evicts one
// that fails alone at once (a failure alone is not load; it is the code). Only test cases are listed, never a file or a
// package: at most PER_FILE cases of one file, at most MAX_ENTRIES in all, and a failure no test owns (an error between
// tests) is re-run but never listed.
//
// The list lives in the fleet's shared cache (/ci-cache, which every self-hosted job mounts), not in the repository:
// listing a test needs no commit, so a flake never costs a push, and the list is the fleet's state like the turbo cache
// beside it. Only main's pushes write it (QUARANTINE_RECORD=1); a pull request reads it and adds nothing.
//
// Usage: quarantine.mjs gate --graph <success|failure>   (verify.yml, after the turbo graph)
//        quarantine.mjs nightly                           (nightly.yml)
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";
import { SUITE_KINDS } from "../../constants/src/test-suites.mjs";
import { failedTasks, junitCases, junitFile, newestSummary, unitsOf } from "./failure-units.mjs";
import { rerunFailures, testUnitParts } from "./flakes.mjs";

export const DEFAULT_FILE = "/ci-cache/quarantine/tests.json";
const DAY_MS = 86_400_000;

// Two weeks: the window the evidence above covers, and long enough that a test flaking once a week is seen again
// before it comes back, short enough that a test listed by mistake is back in the verdict within one sprint.
export const QUARANTINE_DAYS = 14;
// A nightly pass is one sample. A test that fails alone half the time still passes one night in two, but three nights
// in a row only one time in eight. More nights buy little: a released test that flakes again is re-run alone and
// re-listed by the next gate job without failing it.
export const RELEASE_NIGHTS = 3;
// More flakes than this at once says the box is overloaded, not that 50 tests are flaky; past it a flake still passes
// its re-run, but is not listed, and the summary says the list is full.
export const MAX_ENTRIES = 50;
// More cases of one file than this is the file failing, which is not a test case's flake.
export const PER_FILE = 3;
// A failing job with failures in more files than this is a break, not a flake: re-running them would cost minutes and
// clear nothing. 96 of the 107 gate jobs that failed a test between 10-23 and 11-05 failed in five files or fewer.
export const MAX_RERUN_FILES = 5;
// GitHub keeps 10 warning annotations per step; the summary lists the rest.
export const ANNOTATIONS = 10;

export const emptyStore = () => ({ entries: [], pending: [] });

// A failure unit read into the fields an entry keeps, or undefined for anything that is not one test case.
export const caseOf = (unit, task) => {
    const parts = testUnitParts(unit, task);
    return parts === undefined || parts.unhandled
        ? undefined
        : { unit, task: task.taskId, name: task.name, directory: task.directory ?? "", file: parts.file, test: parts.name };
};

// Entries past their expiry, and pending failures as old, dropped.
export const expire = (store, now) => {
    const expired = store.entries.filter((entry) => entry.expires <= now);
    return {
        store: {
            entries: store.entries.filter((entry) => entry.expires > now),
            pending: store.pending.filter((pending) => pending.at > now - QUARANTINE_DAYS * DAY_MS),
        },
        expired,
    };
};

export const isListed = (store, unit) => store.entries.some((entry) => entry.unit === unit);

// Adds `cases` to the list, refusing one already there, one past the file's or the list's cap.
export const admit = (store, cases, { now, run, reason }) => {
    const entries = [...store.entries];
    const admitted = [];
    const refused = [];
    for (const found of cases) {
        if (entries.some((entry) => entry.unit === found.unit)) {
            continue;
        }
        if (entries.filter((entry) => entry.task === found.task && entry.file === found.file).length >= PER_FILE) {
            refused.push({ ...found, why: `${PER_FILE} cases of its file are already listed` });
        } else if (entries.length >= MAX_ENTRIES) {
            refused.push({ ...found, why: `the list is full (${MAX_ENTRIES})` });
        } else {
            const entry = { ...found, since: now, expires: now + QUARANTINE_DAYS * DAY_MS, reason, run, nights: 0 };
            entries.push(entry);
            admitted.push(entry);
        }
    }
    return { store: { ...store, entries }, admitted, refused };
};

// Remembers main's real failures with what they were built from, replacing an older record of the same case.
export const notePending = (store, cases, { now, run, fingerprintOf }) => {
    const units = new Set(cases.map(({ unit }) => unit));
    return {
        ...store,
        pending: [
            ...store.pending.filter((pending) => !units.has(pending.unit)),
            ...cases.map((found) => ({ ...found, fingerprint: fingerprintOf(found.task), at: now, run })),
        ],
    };
};

// A pending failure that passed now: listed when nothing it is built from changed since, forgotten when something did
// (the change may be its fix). One that did not run now waits.
export const settlePending = (store, passed, { now, run, fingerprintOf }) => {
    const later = store.pending.filter((pending) => passed.has(pending.unit) && fingerprintOf(pending.task) === pending.fingerprint);
    const { store: listed, admitted, refused } = admit(store, later, { now, run, reason: "failed on main, passed later unchanged" });
    return { store: { ...listed, pending: listed.pending.filter((pending) => !passed.has(pending.unit)) }, admitted, refused };
};

// One night's lone re-runs, `results` a Map from unit to whether it passed: a pass counts towards release, a failure
// evicts, a test that did not run is left as it was.
export const night = (store, results) => {
    const released = [];
    const evicted = [];
    const entries = store.entries.flatMap((entry) => {
        if (!results.has(entry.unit)) {
            return [entry];
        }
        if (!results.get(entry.unit)) {
            evicted.push(entry);
            return [];
        }
        const next = { ...entry, nights: entry.nights + 1 };
        if (next.nights >= RELEASE_NIGHTS) {
            released.push(next);
            return [];
        }
        return [next];
    });
    return { store: { ...store, entries }, released, evicted };
};

// What one gate job's failures come to: `tolerated` listed cases, `rerun` the units to re-run alone, `hard` the rest
// (a typecheck, a build, a task nothing could be read out of), and whether a re-run is worth it at all.
export const triage = (store, tasks, units) => {
    const byTask = new Map(tasks.map((task) => [task.taskId, task]));
    const tolerated = [];
    const rerun = [];
    const hard = [];
    for (const unit of units) {
        const task = byTask.get(unit.split(" ", 1)[0]);
        const parts = testUnitParts(unit, task);
        if (parts === undefined) {
            hard.push(unit);
        } else if (!parts.unhandled && isListed(store, unit)) {
            tolerated.push(unit);
        } else {
            rerun.push({ unit, file: `${task.taskId} ${parts.file}` });
        }
    }
    const files = new Set(rerun.map(({ file }) => file)).size;
    return { tolerated, rerun: rerun.map(({ unit }) => unit), hard, worthRerun: files > 0 && files <= MAX_RERUN_FILES };
};

// A gate job's verdict from its failed tasks' units: it passes when every failure is a listed case or passed when re-run
// alone, and never on a failed graph nothing could be read out of (no summary, no failed task). `rerun` is
// flakes.mjs's rerunFailures for this checkout.
export const judgeGate = ({ store, graphFailed, summary, tasks, units, rerun }) => {
    if (!graphFailed) {
        return { ok: true, tolerated: [], flakyCases: [], fileFlakes: [], stillCases: [], counted: [], forgiven: [] };
    }
    const byTask = new Map(tasks.map((task) => [task.taskId, task]));
    const triaged = triage(store, tasks, units);
    const { flaky, still } = triaged.worthRerun ? rerun(triaged.rerun) : { flaky: [], still: triaged.rerun };
    const asCase = (unit) => caseOf(unit, byTask.get(unit.split(" ", 1)[0]));
    return {
        ok: summary !== undefined && tasks.length > 0 && triaged.hard.length === 0 && still.length === 0,
        tolerated: triaged.tolerated,
        flakyCases: flaky.map(asCase).filter((found) => found !== undefined),
        fileFlakes: flaky.filter((unit) => asCase(unit) === undefined),
        stillCases: still.map(asCase).filter((found) => found !== undefined),
        counted: [...triaged.hard, ...still],
        forgiven: [...triaged.tolerated, ...flaky],
    };
};

// What a test task is built from, from turbo's run summary: its own package's inputs, its dependencies' hashes and the
// external dependency hash. The same on two runs means nothing it imports changed; global inputs (CI's env, the root
// config) are left out on purpose, since a change there is not a change to the test or the code it runs.
export const fingerprints = (summary) => {
    const byId = new Map((summary?.tasks ?? []).map((task) => [task.taskId, task]));
    return (taskId) => {
        const task = byId.get(taskId);
        if (task === undefined) {
            return undefined;
        }
        const deps = (task.dependencies ?? []).map((id) => `${id}=${byId.get(id)?.hash ?? "?"}`).sort();
        return createHash("sha256")
            .update(JSON.stringify({ inputs: task.inputs ?? {}, deps, external: task.hashOfExternalDependencies ?? "" }))
            .digest("hex")
            .slice(0, 16);
    };
};

// Every test case that ran and passed in this job, as units, read from the JUnit reports of the test tasks that ran.
export const passedUnits = (summary, junitDir, read) => {
    const passed = new Set();
    for (const task of summary?.tasks ?? []) {
        if (task.task !== "test" || task.cache?.status === "HIT" || junitDir === undefined) {
            continue;
        }
        for (const kind of SUITE_KINDS) {
            for (const { file, name, failed, skipped } of junitCases(read(junitFile(junitDir, task.package, kind)))) {
                if (!failed && !skipped) {
                    passed.add(`${task.taskId} ${posix.join(task.directory ?? "", file)} › ${name}`);
                }
            }
        }
    }
    return passed;
};

const readOr = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a report a task never wrote (it failed before bun ran) holds no case
        return "";
    }
};

const parsedOr = (text) => {
    try {
        return JSON.parse(text) ?? undefined;
    } catch {
        // allow(silent-catch): a summary turbo did not finish writing is no summary, and a failed graph without one fails
        return undefined;
    }
};

export const readStore = (path) => {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const records = (list) =>
            Array.isArray(list)
                ? list.filter((record) => (record?.unit ?? "") !== "").map((record) => ({ ...record, unit: String(record.unit) }))
                : [];
        return { entries: records(parsed?.entries), pending: records(parsed?.pending) };
    } catch {
        // allow(silent-catch): no list yet (the first run on a fleet) or one cut short is an empty list, never a failed gate
        return emptyStore();
    }
};

// Six runner processes and two gate jobs a push write this file: a lock directory (mkdir is atomic) held for the
// read-change-write, and a rename so a reader never sees half a file. A lock older than a minute is a job that died
// holding it.
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const withStore = (path, change) => {
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            mkdirSync(lock);
            break;
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw error;
            }
            const age = (() => {
                try {
                    return Date.now() - statSync(lock).mtimeMs;
                } catch {
                    // allow(silent-catch): the holder let go between the mkdir and this look; the next mkdir takes it
                    return 0;
                }
            })();
            if (age > LOCK_STALE_MS || Date.now() > deadline) {
                rmSync(lock, { recursive: true, force: true });
                continue;
            }
            pause(200);
        }
    }
    try {
        const result = change(readStore(path));
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(result.store, null, 1)}\n`);
        renameSync(temporary, path);
        return result;
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
};

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const escapeData = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// `::warning` lines naming each listed test, up to GitHub's per-step limit.
export const annotations = (entries, limit = ANNOTATIONS) => {
    const shown = entries
        .slice(0, limit)
        .map(
            (entry) =>
                `::warning file=${posix.join(entry.directory, entry.file)},title=quarantined test::${escapeData(`${entry.test} (${entry.name}) is quarantined until ${day(entry.expires)}: ${entry.reason}. Its failures do not fail the gate; nightly.yml re-runs it alone.`)}`,
        );
    return entries.length > limit ? [...shown, `::warning title=quarantined tests::${entries.length - limit} more in the step summary`] : shown;
};

// The step summary every gate run writes, so the list stays visible whether or not anything failed.
export const gateSummary = ({ store, tolerated, admitted, refused, expired, fileFlakes, passed }) => {
    const lines = [`### Quarantined tests: ${store.entries.length} of at most ${MAX_ENTRIES}`, ""];
    if (store.entries.length > 0) {
        lines.push("| test | file | listed | expires | nights passed | why | this run |", "| --- | --- | --- | --- | --- | --- | --- |");
        for (const entry of store.entries) {
            const here = tolerated.includes(entry.unit) ? "failed, not counted" : passed.has(entry.unit) ? "passed" : "not run";
            lines.push(
                `| ${entry.test.replaceAll("|", "\\|")} | \`${posix.join(entry.directory, entry.file)}\` | ${day(entry.since)} | ${day(entry.expires)} | ${entry.nights}/${RELEASE_NIGHTS} | ${entry.reason} | ${here} |`,
            );
        }
        lines.push("");
    }
    const list = (title, units) => (units.length === 0 ? [] : [`**${title}**`, "", ...units.map((unit) => `- ${unit}`), ""]);
    lines.push(
        ...list(
            "Listed by this run",
            admitted.map(({ unit }) => unit),
        ),
        ...list(
            "Flaky but not listed",
            refused.map(({ unit, why }) => `${unit}: ${why}`),
        ),
        ...list("Failed between tests, then passed alone (never listed)", fileFlakes),
        ...list(
            "Expired, back in the verdict",
            expired.map(({ unit }) => unit),
        ),
    );
    return lines.join("\n");
};

const writeSummary = (text) => {
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    } else {
        console.log(text);
    }
};

const runId = () => (process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` : "local");

// verify.yml's step after the graph: decides the job from its failures and keeps the list.
const gate = (argv) => {
    const root = repoRoot(import.meta.url);
    const path = process.env.QUARANTINE_FILE || DEFAULT_FILE;
    const record = process.env.QUARANTINE_RECORD === "1";
    const junitDir = process.env.SUITES_JUNIT_DIR || undefined;
    const graphFailed = argv[argv.indexOf("--graph") + 1] === "failure";
    const now = Date.now();
    const run = runId();
    const summaryPath = newestSummary(join(root, ".turbo/runs"));
    const summary = summaryPath === undefined ? undefined : parsedOr(readOr(summaryPath));
    const fingerprintOf = fingerprints(summary);
    const { store: current, expired } = expire(readStore(path), now);

    const tasks = graphFailed ? failedTasks(summary) : [];
    const judged = judgeGate({
        store: current,
        graphFailed,
        summary,
        tasks,
        units: unitsOf(root, tasks, junitDir),
        rerun: (units) => rerunFailures(root, tasks, units),
    });
    const { ok, tolerated, flakyCases, fileFlakes, stillCases } = judged;
    for (const unit of judged.counted) {
        console.log(`counted: ${unit}`);
    }
    for (const unit of judged.forgiven) {
        console.log(`not counted: ${unit}`);
    }

    const passed = passedUnits(summary, junitDir, readOr);
    let outcome;
    if (record) {
        outcome = withStore(path, (read) => {
            const fresh = expire(read, now).store;
            const flakes = admit(fresh, flakyCases, { now, run, reason: "failed, then passed alone" });
            const later = settlePending(notePending(flakes.store, stillCases, { now, run, fingerprintOf }), passed, { now, run, fingerprintOf });
            return { store: later.store, admitted: [...flakes.admitted, ...later.admitted], refused: [...flakes.refused, ...later.refused] };
        });
    } else {
        outcome = { store: current, admitted: [], refused: flakyCases.map((found) => ({ ...found, why: "only main's pushes write the list" })) };
    }

    for (const line of annotations(outcome.store.entries)) {
        console.log(line);
    }
    writeSummary(gateSummary({ store: outcome.store, tolerated, admitted: outcome.admitted, refused: outcome.refused, expired, fileFlakes, passed }));
    if (graphFailed && ok) {
        console.log(`::notice title=gate passed on re-run::every failure was a quarantined test or passed when re-run alone`);
    }
    return ok ? 0 : 1;
};

// nightly.yml: every listed test re-run alone, its dependencies built first.
const nightly = () => {
    const root = repoRoot(import.meta.url);
    const path = process.env.QUARANTINE_FILE || DEFAULT_FILE;
    const { entries } = expire(readStore(path), Date.now()).store;
    if (entries.length === 0) {
        writeSummary("### Quarantined tests\n\nNone listed.\n");
        return 0;
    }
    const packages = [...new Set(entries.map((entry) => entry.name))];
    const built = spawnSync(
        "pnpm",
        ["turbo", "run", "build", ...packages.map((name) => `--filter=${name}^...`), "--continue=dependencies-successful"],
        {
            cwd: root,
            stdio: "inherit",
        },
    );
    if (built.status !== 0) {
        console.log("::warning title=quarantine nightly::a dependency failed to build; its tests' nights are not counted");
    }
    const tasks = [
        ...new Map(entries.map((entry) => [entry.task, { taskId: entry.task, name: entry.name, task: "test", directory: entry.directory }])).values(),
    ];
    const { flaky: passedAlone } = rerunFailures(
        root,
        tasks,
        entries.map((entry) => entry.unit),
    );
    const results = new Map(entries.map((entry) => [entry.unit, passedAlone.includes(entry.unit)]));
    if (built.status !== 0) {
        // A test that could not build ran against stale code: neither a pass nor a failure of its own.
        for (const entry of entries) {
            if (!results.get(entry.unit)) {
                results.delete(entry.unit);
            }
        }
    }
    const { store, released, evicted } = withStore(path, (read) => night(expire(read, Date.now()).store, results));
    for (const entry of evicted) {
        console.log(
            `::error file=${posix.join(entry.directory, entry.file)},title=quarantined test failed alone::${escapeData(`${entry.test} (${entry.name}) failed when run alone, so it is not a flake: it is back in the gate's verdict.`)}`,
        );
    }
    const line = (entry) => `- ${entry.unit}`;
    writeSummary(
        [
            `### Quarantined tests, nightly: ${entries.length} run alone`,
            "",
            `**Released** (passed ${RELEASE_NIGHTS} nights in a row): ${released.length}`,
            ...released.map(line),
            "",
            `**Evicted** (failed alone, back in the verdict): ${evicted.length}`,
            ...evicted.map(line),
            "",
            `**Still listed**: ${store.entries.length}`,
            ...store.entries.map((entry) => `${line(entry)} (${entry.nights}/${RELEASE_NIGHTS})`),
            "",
        ].join("\n"),
    );
    return evicted.length > 0 ? 1 : 0;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === "gate") {
        process.exit(gate(rest));
    } else if (mode === "nightly") {
        process.exit(nightly());
    } else {
        console.error("usage: quarantine.mjs gate --graph <success|failure> | quarantine.mjs nightly");
        process.exit(2);
    }
}
