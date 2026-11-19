// The digest a test run's output ends with: what failed and the first line of why, the counts, and for each failure
// whether it also fails at main, from the sandbox's own record of runs on clean trees at main commits
// (./test-outcomes.mjs). Every run it reads is recorded there too, so the first run in a fresh worktree, before any edit,
// is the baseline every later run in any worktree of that commit is compared with. 2026-11-19, the shinobi-society
// audit: "already fails on main" was argued case by case in 19 conversations, and agents grepped test output 717 times
// and re-ran suites only to change the filter.
//
// Reads git, so it runs only for a command that names a test runner and whose output a parser recognised. Never throws
// past `testDigest`: a digest it cannot make is no digest, and the command's own output is untouched either way.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { baselineCommits, baselinesAt, passedIn, recordRun } from "./test-outcomes.mjs";
import { parseTestRun } from "./test-runs.mjs";

// A command that runs tests: a runner by name, a package script called test, or the sandbox's `suites`.
const TEST_COMMAND =
    /(?<![\w./-])(?:cargo(?:\s+\+\S+)?\s+(?:test|nextest)|bun\s+test|suites|vitest|jest|pytest|py\.test|go\s+test|deno\s+test|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|(?:make|just)\s+test|tox|nox)(?![\w.-])/;
// `base run <command>` runs it in a worktree at the fork point (the sibling `base` command), so its run is that
// commit's, on a clean tree, whatever this worktree holds.
const BASE_RUN = /^\s*base\s+run\s/;
// `cd dir && …` or `cd dir; …` at the front: the directory the command's tests ran in.
const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)/;
const CD_HOPS = 4;

const GIT_TIMEOUT_MS = 3000;
// How far from the fork point a recorded main commit may be and still stand in for it, and how many are tried.
const NEAR_COMMITS = 50;
const NEAR_TRIED = 8;
const SHOWN_FAILURES = 15;
const SHORT_SHA = 9;

// The `cd`s a command starts with, followed from `cwd`: where its tests ran, and what it ran there.
const leadingCds = (command, cwd) => {
    let dir = cwd;
    let rest = command;
    for (let hop = 0; hop < CD_HOPS; hop += 1) {
        const cd = LEADING_CD.exec(rest);
        if (cd === null) {
            break;
        }
        dir = resolve(dir, cd[1].replaceAll(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, homedir()));
        rest = rest.slice(cd[0].length);
    }
    return { dir: existsSync(dir) ? dir : cwd, rest: rest.trim() };
};

// The command a baseline is made with: the test command itself, without the filters piped after it (a baseline wants
// every line), quoted as one word when it is still more than one command.
const baselineCommand = (rest) => {
    const whole = rest.replace(/\s*\|&?\s*(?:grep|egrep|rg|head|tail|sed|awk|cut|sort|uniq|wc)\b.*$/s, "").replace(/\s+2>&1\s*$/, "");
    return /[;&|<>]/.test(whole) ? `'${whole.replaceAll("'", "'\\''")}'` : whole;
};

// git, read-only: no optional locks (a sibling's commit must never meet this one's index.lock), C locale, bounded.
const git = (cwd, args) => {
    const ran = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return ran.status === 0 ? ran.stdout : undefined;
};

// The repository's name: its shared git dir's (a worktree's `/history/gits/<name>`), else its checkout's.
const repoName = (commonDir, top) => {
    const dir = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
    return basename(dir).replace(/\.git$/, "") || basename(top);
};

// The main line a fork point is measured from: the sandbox's latched one, else the usual names.
const mainRefOf = (top) => {
    const named = git(top, ["config", "--get", "intentic.mainBranch"])?.trim();
    const candidates = [named === undefined || named === "" ? "" : `refs/heads/${named}`, "refs/heads/main", "refs/heads/master", "refs/remotes/origin/HEAD"].filter(Boolean);
    const listed = new Set((git(top, ["for-each-ref", "--format=%(refname)", ...candidates]) ?? "").split("\n"));
    return candidates.find((ref) => listed.has(ref));
};

// What a dirty tree is, as a short hash: its diff against HEAD and the names of its untracked files.
const treeHash = (top, status) => createHash("sha1").update(git(top, ["diff", "HEAD", "--no-ext-diff", "--binary"]) ?? "").update(status).digest("hex").slice(0, 12);

/**
 * Where a command ran, as git sees it: the checkout, its repository's name, HEAD, whether the tree is clean (else a
 * hash of its changes), the main line and the fork point from it, and whether HEAD is on that line. Undefined outside
 * a repository or when git does not answer.
 */
const treeState = (cwd) => {
    const head = git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir", "HEAD"])?.trim().split("\n");
    const status = head?.length === 3 ? git(head[0], ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]) : undefined;
    if (head === undefined || status === undefined) {
        return undefined;
    }
    const [top = "", common = "", sha = ""] = head;
    const mainRef = mainRefOf(top);
    const fork = mainRef === undefined ? undefined : git(top, ["merge-base", "HEAD", mainRef])?.trim();
    return { top, repo: repoName(resolve(cwd, common), top), sha, clean: status === "", tree: status === "" ? "clean" : treeHash(top, status), mainRef, fork, onMain: fork === sha };
};

// A test file as the repository names it, wherever the runner printed it from: the nearest directory from `cwd` up to
// the checkout where the printed path exists (`suites` and a package script run from the package's own directory).
const repoFile = (file, cwd, top) => {
    if (file === undefined || top === undefined || !cwd.startsWith(top)) {
        return file;
    }
    for (let dir = cwd; dir.startsWith(top); dir = dirname(dir)) {
        if (existsSync(resolve(dir, file))) {
            return relative(top, resolve(dir, file));
        }
        if (dir === top) {
            break;
        }
    }
    return file;
};

/** A test's id across runs: `crate name` for Rust, `file > name` for a JS runner, the runner's own node id otherwise. */
const testId = (test) => {
    if (test.suite !== undefined) {
        return `${test.suite} ${test.name}`;
    }
    return test.file === undefined ? test.name : `${test.file} > ${test.name}`;
};

// The recorded baseline that stands for the fork point: its own, else the nearest recorded main commit within reach.
const baselineFor = (dir, top, fork) => {
    const exact = baselinesAt(dir, fork);
    if (exact.length > 0) {
        return { sha: fork, runs: exact, ahead: 0, behind: 0 };
    }
    let best;
    for (const sha12 of baselineCommits(dir).slice(0, NEAR_TRIED)) {
        const [ahead = Number.NaN, behind = Number.NaN] = (git(top, ["rev-list", "--left-right", "--count", `${sha12}...${fork}`]) ?? "").trim().split(/\s+/).map(Number);
        if (ahead + behind <= NEAR_COMMITS && (best === undefined || ahead + behind < best.ahead + best.behind)) {
            best = { sha12, ahead, behind };
        }
    }
    const sha = best === undefined ? undefined : git(top, ["rev-parse", "--verify", "-q", `${best.sha12}^{commit}`])?.trim();
    const runs = sha === undefined ? [] : baselinesAt(dir, sha);
    return runs.length === 0 ? undefined : { sha, runs, ahead: best.ahead, behind: best.behind };
};

const ago = (ms) => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const mainAt = (sha) => `main@${sha.slice(0, SHORT_SHA)}`;

// A baseline run's failure is this test's: the same id, or the same name where either side ran without its suite or
// file (a run piped through grep loses the line that names them).
const sameTest = (failure, test) => failure.id === test.id || failure.id === test.name || (test.id === test.name && failure.name === test.name);

// What the baseline says of one failure, and in which order the digest lists it: what passes at main first (the
// clearest sign of the change's own breakage), then what was not seen there, then what fails there too.
const verdictOf = (test, known, now) => {
    const failedThere = known.runs.find((run) => run.failed.some((failure) => sameTest(failure, test)));
    const passedThere = known.runs.some((run) => passedIn(run, test.id));
    if (failedThere !== undefined) {
        const flaky = passedThere ? "; it passed there too, so flaky" : "";
        return { rank: 2, main: true, label: `also fails at ${mainAt(known.sha)} (seen ${ago(now - failedThere.at)}${flaky})` };
    }
    return passedThere ? { rank: 0, main: false, label: `new: passes at ${mainAt(known.sha)}` } : { rank: 1, main: false, label: `new: not seen failing at ${mainAt(known.sha)}` };
};


const distanceWords = (known) => {
    if (known.ahead === 0 && known.behind === 0) {
        return "your fork point";
    }
    if (known.ahead === 0) {
        return `${known.behind} commit${known.behind === 1 ? "" : "s"} before your fork point`;
    }
    return known.behind === 0 ? `${known.ahead} commit${known.ahead === 1 ? "" : "s"} after your fork point` : `${known.ahead + known.behind} commits from your fork point`;
};

// Whether a program is on PATH, read when the digest is written: the `base` command may not be in this image.
const onPath = (name) => (process.env["PATH"] ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));

// The line that says how to get a baseline where none is recorded: one command, with `base` where it is installed
// (asked only now, so a run that needs no such line never looks).
const noBaselineLine = (rest, fork, hasBase = onPath("base")) => {
    const known = `nothing is recorded of these tests at ${mainAt(fork)} (your fork point)`;
    const how = hasBase
        ? `\`base run ${baselineCommand(rest)}\` runs this there and records it`
        : `run the same command once in a clean checkout of that commit (\`git worktree add --detach <dir> ${fork.slice(0, SHORT_SHA)}\`) and it is recorded`;
    return `--- no baseline: ${known}; ${how}, and every later run is labelled against it. \`agents ci\` lists what main's CI is known to fail on.`;
};

const countsLine = (parsed) => {
    const { passed, failed, ignored } = parsed.counts;
    return `--- tests: ${failed} failed, ${passed} passed${ignored > 0 ? `, ${ignored} ignored` : ""} (${parsed.runners.join(", ")})`;
};

// The digest's lines: the counts and what they were compared with, a line per failure, and how to get a baseline when
// there is none.
const render = ({ parsed, failures, where, known, recordedBaseline, recording, rest, hasBase, now }) => {
    const against = recordedBaseline
        ? ` · ran on a clean tree at ${mainAt(where.sha)}: recorded as its baseline, so these fail at main itself`
        : known === undefined
          ? ""
          : ` · against ${mainAt(known.sha)} (${distanceWords(known)})`;
    const judged = failures
        .map((test) => ({ test, verdict: known === undefined ? undefined : verdictOf(test, known, now) }))
        .toSorted((a, b) => (a.verdict?.rank ?? 0) - (b.verdict?.rank ?? 0));
    const lines = judged.slice(0, SHOWN_FAILURES).map(({ test, verdict }) => {
        const why = test.line === undefined ? "" : `: ${test.line}`;
        return `✗ ${test.id}${why}${verdict === undefined ? "" : ` — ${verdict.label}`}`;
    });
    const unshown = judged.slice(SHOWN_FAILURES);
    const mains = unshown.filter(({ verdict }) => verdict?.main === true).length;
    const split = known === undefined ? "" : `: ${unshown.length - mains} new, ${mains} also failing at ${mainAt(known.sha)}`;
    const more = unshown.length > 0 ? [`… +${unshown.length} more failing${split} (each in the full output)`] : [];
    const missing = recording && !recordedBaseline && known === undefined && where?.fork !== undefined ? [noBaselineLine(rest, where.fork, hasBase)] : [];
    return [`${countsLine(parsed)}${against}`, ...lines, ...more, ...missing].join("\n");
};

// Where the run's tests ran, as the record files it: this checkout, or for `base run` its fork point on a clean tree.
const runPlace = (rest, cwd) => {
    const tree = treeState(cwd);
    if (tree === undefined || !BASE_RUN.test(rest)) {
        return tree;
    }
    return tree.fork === undefined ? undefined : { ...tree, sha: tree.fork, clean: true, tree: "clean", onMain: true };
};

/**
 * One test command's digest, and its run recorded under `dir`: "" when the command runs no tests, its output names
 * none, or it failed none. `lines` is the output cleaned of ANSI; `narrowed` says a pipeline stage may have dropped some
 * of it, which the record keeps. `hasBase` and `now` are for tests.
 */
export const testDigest = (lines, { command, cwd, dir, by, narrowed = false, now = Date.now(), hasBase }) => {
    if (!TEST_COMMAND.test(command)) {
        return "";
    }
    const parsed = parseTestRun(lines);
    if (parsed === undefined) {
        return "";
    }
    const { dir: at, rest } = leadingCds(command, cwd);
    const where = runPlace(rest, at);
    const tests = parsed.tests.map((test) => {
        const named = { ...test, file: repoFile(test.file, at, where?.top) };
        return { ...named, id: testId(named) };
    });
    const recordedBaseline = where !== undefined && where.clean && where.onMain;
    if (dir !== undefined && where !== undefined) {
        recordRun(dir, { ...where, baseline: recordedBaseline, command, by, runners: parsed.runners, partial: narrowed || !parsed.summarized, counts: parsed.counts, tests }, now);
    }
    const failures = tests.filter((test) => test.outcome === "fail");
    if (failures.length === 0 && parsed.counts.failed === 0) {
        return "";
    }
    const known = recordedBaseline || dir === undefined || where?.fork === undefined ? undefined : baselineFor(dir, where.top, where.fork);
    return render({ parsed, failures, where, known, recordedBaseline, recording: dir !== undefined, rest, hasBase, now });
};
