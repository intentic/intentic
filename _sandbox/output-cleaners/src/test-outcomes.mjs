// The sandbox's record of test runs: every run the output filter read as tests, one small JSON file each, keyed by the
// commit it ran at and whether the tree was clean. A clean tree at a commit on the main line is that commit's BASELINE:
// what its failures say is what fails at main, which the filter's digest compares a worktree's failures with and the
// daemon's `agents ci` lists beside CI's. 2026-11-19, the shinobi-society audit: whether a failure "already fails on
// main" was argued case by case in 19 conversations; one parent spent 21 minutes building a baseline in /tmp and pasted
// it into three children's prompts while another child built its own of the same commit.
//
// One file per run, never a shared file rewritten: concurrent filters across a sandbox's conversations each write their
// own, by rename, so a reader never meets half of one. The name carries what a lookup needs before opening anything:
// `<sha12>-<b|w>-<base36 ms>-<random>.json`, `b` for a baseline. Bounded by count and age, work runs pruned before
// baselines. Node builtins only, like every module the filter loads.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The record's directory under the sandbox's logs (the filter's `logsDir`, the daemon's logs root). */
export const OUTCOMES_DIR = "test-outcomes";

// Runs kept, by count, bytes and age; work runs go before baselines. The daemon's log pruner holds this directory to a
// larger count of its own (src/logs/log-files.ts GROUP_CAPS), so these are the bounds that bite.
const KEEP = { files: 1000, bytes: 32 * 1024 * 1024, ms: 21 * 24 * 3_600_000 };
// A run's passing tests are kept as short hashes, enough to say "passes at main"; past this many, the rest are not.
const KEEP_PASSES = 8000;
// What one run keeps of its failures and its command.
const KEEP_FAILURES = 200;
const COMMAND_MAX = 300;
// Baseline files a lookup or a listing opens at most, newest first.
const READ_MAX = 200;
const NAME = /^([0-9a-f]{12})-([bw])-([0-9a-z]+)-[0-9a-f]+\.json$/;

// The short hash a passing test is kept under.
const passKey = (id) => createHash("sha1").update(id).digest("hex").slice(0, 8);

/** Whether a run read back saw this test pass. */
export const passedIn = (run, id) => ` ${run.passed} `.includes(` ${passKey(id)} `);

const entryOf = (name) => {
    const match = NAME.exec(name);
    return match === null ? undefined : { name, sha12: match[1], baseline: match[2] === "b", at: Number.parseInt(match[3], 36) };
};

// Every run file's name, parsed, newest first; none when the directory is not there.
const entriesIn = (dir) => {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        // allow(silent-catch): the record is best effort inside the output filter: an unreadable directory is no runs, never a failed command
        return [];
    }
    return names.flatMap((name) => {
        const entry = entryOf(name);
        return entry === undefined ? [] : [entry];
    }).toSorted((a, b) => b.at - a.at);
};

const sizeOf = (path) => {
    try {
        return statSync(path).size;
    } catch {
        // allow(silent-catch): pruned by a concurrent writer between the listing and the stat, so it holds nothing
        return 0;
    }
};

// The files past the bounds: anything older than `keep.ms`, then past `keep.files` or `keep.bytes` counted baselines
// first and newest first, so the oldest work runs go first. The file just written (`written`) is always kept.
const overBounds = (dir, entries, now, written, keep) => {
    const young = entries.filter((entry) => now - entry.at <= keep.ms);
    let bytes = 0;
    const kept = new Set(
        young
            .toSorted((a, b) => Number(b.baseline) - Number(a.baseline) || b.at - a.at)
            .filter((entry, index) => {
                bytes += sizeOf(join(dir, entry.name));
                return entry.name === written || (index < keep.files && bytes <= keep.bytes);
            }),
    );
    return entries.filter((entry) => !kept.has(entry));
};

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const textOr = (value, fallback) => (value === undefined || value === null ? fallback : String(value));
const countOf = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// A run file's text as a run, every field coerced to what the writer wrote, or undefined when it is not one: the reader
// never trusts a file's shape, since anything with the directory's permissions could have written it.
const parseRun = (text, entry) => {
    const raw = JSON.parse(text) ?? {};
    const sha = textOr(raw.sha, "");
    if (!SHA.test(sha) || !Array.isArray(raw.failed)) {
        return undefined;
    }
    return {
        at: countOf(raw.at),
        repo: textOr(raw.repo, ""),
        sha,
        command: textOr(raw.command, ""),
        by: raw.by === undefined ? undefined : textOr(raw.by, ""),
        counts: { passed: countOf(raw.counts?.passed), failed: countOf(raw.counts?.failed), ignored: countOf(raw.counts?.ignored) },
        failed: raw.failed.map((failure) => ({ id: textOr(failure?.id, ""), name: textOr(failure?.name, ""), line: failure?.line === undefined ? undefined : textOr(failure.line, "") })),
        passed: textOr(raw.passed, ""),
        baseline: entry.baseline,
    };
};

// A run file read back, or undefined when it is gone or not one.
const readRun = (dir, entry) => {
    try {
        return parseRun(readFileSync(join(dir, entry.name), "utf8"), entry);
    } catch {
        // allow(silent-catch): a run file pruned or half-written by another command is not a run; the rest still count
        return undefined;
    }
};

/**
 * Keeps one run: what it ran at, how it ended, its failures by id with their first line, and its passes as hashes. A
 * write that fails costs the record, never the command, so this never throws; it answers the file written, if any.
 * `keep` is for tests.
 */
export const recordRun = (dir, run, now = Date.now(), keep = KEEP) => {
    try {
        mkdirSync(dir, { recursive: true });
        const name = `${run.sha.slice(0, 12)}-${run.baseline ? "b" : "w"}-${now.toString(36)}-${randomBytes(4).toString("hex")}.json`;
        const passes = run.tests.filter((test) => test.outcome === "pass").slice(0, KEEP_PASSES);
        const body = {
            v: 1,
            at: now,
            repo: run.repo,
            sha: run.sha,
            tree: run.tree,
            fork: run.fork,
            main: run.mainRef,
            command: run.command.slice(0, COMMAND_MAX),
            by: run.by,
            runners: run.runners,
            partial: run.partial,
            counts: run.counts,
            failed: run.tests
                .filter((test) => test.outcome === "fail")
                .slice(0, KEEP_FAILURES)
                .map((test) => ({ id: test.id, name: test.name, line: test.line })),
            passed: passes.map((test) => passKey(test.id)).join(" "),
        };
        const staging = join(dir, `.${name}.part`);
        writeFileSync(staging, JSON.stringify(body));
        renameSync(staging, join(dir, name));
        for (const entry of overBounds(dir, entriesIn(dir), now, name, keep)) {
            rmSync(join(dir, entry.name), { force: true });
        }
        return join(dir, name);
    } catch {
        // allow(silent-catch): recording is best effort inside the output filter: a full or read-only disk must not fail the agent's command
        return undefined;
    }
};

/** The baseline runs kept at one commit, newest first. */
export const baselinesAt = (dir, sha) =>
    entriesIn(dir)
        .filter((entry) => entry.baseline && entry.sha12 === sha.slice(0, 12))
        .slice(0, READ_MAX)
        .flatMap((entry) => {
            const run = readRun(dir, entry);
            return run !== undefined && run.sha === sha ? [run] : [];
        });

/** The commits that have a baseline, newest baseline first, as 12-character prefixes. */
export const baselineCommits = (dir) => [...new Set(entriesIn(dir).filter((entry) => entry.baseline).map((entry) => entry.sha12))];

// One baseline commit's runs, folded: each failing test once (its newest line), and the runs' commands, newest first.
const foldRuns = (runs) => {
    const failed = new Map();
    for (const run of runs) {
        for (const failure of run.failed) {
            if (failure.id !== "" && !failed.has(failure.id)) {
                failed.set(failure.id, { test: failure.id, line: failure.line, at: run.at });
            }
        }
    }
    return [...failed.values()];
};

/**
 * What each repository's newest baselined main commit is known to fail on, for `agents ci`: the commit, when it was
 * last run there and by what, and each failing test with its first line. A repository whose newest baseline failed
 * nothing is listed with none, which says it ran clean.
 */
export const mainBaselines = (dir) => {
    const runs = entriesIn(dir)
        .filter((entry) => entry.baseline)
        .slice(0, READ_MAX)
        .flatMap((entry) => {
            const run = readRun(dir, entry);
            return run === undefined ? [] : [run];
        });
    const newest = new Map();
    for (const run of runs) {
        if (!newest.has(run.repo)) {
            newest.set(run.repo, run.sha);
        }
    }
    return [...newest].map(([repo, sha]) => {
        const at = runs.filter((run) => run.sha === sha && run.repo === repo);
        return {
            repo,
            sha,
            at: at[0]?.at ?? 0,
            runs: at.map((run) => ({ command: run.command, at: run.at, by: run.by, counts: run.counts })),
            failed: foldRuns(at),
        };
    });
};
