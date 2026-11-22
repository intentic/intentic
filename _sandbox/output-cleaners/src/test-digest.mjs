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
import { cpus, homedir, loadavg } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { baselineCommits, baselinesAt, passedIn, recordRun } from "./test-outcomes.mjs";
import { shellCommands } from "./cleaner-shapes.mjs";
import { parseTestRun } from "./test-runs.mjs";

// A command that runs tests: a runner by name, a package script called test, or the sandbox's `suites`.
const TEST_COMMAND =
    /(?<![\w./-])(?:cargo(?:\s+\+\S+)?\s+(?:test|nextest)|bun\s+test|suites|vitest|jest|pytest|py\.test|go\s+test|deno\s+test|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|(?:make|just)\s+test|tox|nox)(?![\w.-])/;
// `base run <command>` runs it in a worktree at the fork point (the sibling `base` command), so its run is that
// commit's, on a clean tree, whatever this worktree holds. `base` runs its command without a shell.
const BASE_RUN = /^\s*base\s+run\s/;
// `cd dir && …` or `cd dir; …` at the front: where a line this cannot split ran its tests.
const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)/;
const CD_HOPS = 4;

const GIT_TIMEOUT_MS = 3000;
// How far from the fork point a recorded main commit may be and still stand in for it, and how many are tried.
const NEAR_COMMITS = 50;
const NEAR_TRIED = 8;
const SHOWN_FAILURES = 15;
const SHORT_SHA = 9;

// The `cd`s a command starts with, followed from `cwd`: where its tests ran, and what it ran there. Only for a line
// `testRunOf` cannot read.
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

// The test command within the line, read from the line as the shell splits it (cleaner-shapes.mjs). 2026-11-22, the
// shinobi-society audit: 4 of 11 "no baseline" lines named something other than the test command, cut at the first
// `| head` (`base run 'sed -i … && cd /work/integra && free -g'`) or a file edit (`base run 'cat >> … <<'\''EOF'\'' …`),
// because only leading `cd`s were followed and the rest was cut at the first filter.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A redirection (`>`, `>>`, `2>&1`, `&>`, `>|`, `<`), its target in the same word or the next.
const REDIRECT = /^(?:\d+|&)?(?:>>|>\||>&|<&|>|<)/;
// Programs that print or edit and never run tests, whatever their words say (`echo cargo test`).
const NOT_RUNNERS = new Set(["echo", "printf", "cat", "sed", "perl", "awk", "tee", "cp", "mv", "rm", "touch", "patch", "git", "grep", "egrep", "rg", "ls", "find", "true", "false", ":"]);

// The shell's own words in front of a command, which `base` cannot run: the command alone goes without them.
const SHELL_ONLY = new Set(["time", "exec", "command"]);

const programName = (word) => word?.value.split("/").at(-1) ?? "";

// Whether a pipeline stage runs tests: a runner among its unquoted words, run by a program that does not only print or
// edit.
const runsTests = (stage) => {
    const program = stage.find((word) => !ASSIGNMENT.test(word.raw));
    const plain = stage.filter((word) => !/['"\\]/.test(word.raw)).map((word) => word.raw);
    return program !== undefined && !NOT_RUNNERS.has(programName(program)) && TEST_COMMAND.test(plain.join(" "));
};

// Where `cd` with these words leads from `dir`; undefined where this cannot know (a variable, a glob, two operands).
const cdTarget = (words, dir, previous) => {
    const first = words.findIndex((word) => !/^-(?:[LPe@]+|-)$/.test(word.raw));
    const operands = first === -1 ? [] : words.slice(first);
    const [target] = operands;
    if (operands.length > 1 || (target !== undefined && /[$`*?[]/.test(target.raw))) {
        return undefined;
    }
    if (target === undefined || target.raw === "-") {
        return target === undefined ? homedir() : previous;
    }
    return resolve(dir, target.raw.startsWith("~") ? target.value.replace(/^~(?=\/|$)/, homedir()) : target.value);
};

// `base run [--at <commit>] [--] <command>`: the commit `--at` named (undefined for the fork point); undefined for a
// stage `base` does not run.
const baseRunOf = (words) => {
    const start = words.findIndex((word) => !ASSIGNMENT.test(word.raw));
    if (programName(words[start]) !== "base" || words[start + 1]?.value !== "run") {
        return undefined;
    }
    let at;
    for (let index = start + 2; index < words.length && words[index].value.startsWith("--at"); index += 1) {
        const flag = words[index].value;
        at = flag === "--at" ? words[index + 1]?.value : flag.slice("--at=".length);
        index += flag === "--at" ? 1 : 0;
    }
    return { at };
};

// A test stage as a command of its own: its words without their redirections or the shell's own `time` and `exec`, its
// env assignments (with those `export`ed before it) apart, since they go ahead of `base run`, which runs its command
// without a shell.
const aloneOf = (stage, exported) => {
    const words = stage.filter((word, index) => {
        const before = stage[index - 1];
        const target = before !== undefined && REDIRECT.exec(before.raw)?.[0] === before.raw;
        return !target && REDIRECT.exec(word.raw) === null;
    });
    const program = words.findIndex((word) => !ASSIGNMENT.test(word.raw));
    let start = program;
    while (SHELL_ONLY.has(words[start]?.value ?? "") || (words[start]?.value === "-p" && words[start - 1]?.value === "time")) {
        start += 1;
    }
    return { env: [...exported, ...words.slice(0, program)].map((word) => word.raw), words: words.slice(start).map((word) => word.raw) };
};

/**
 * Where a line's tests ran and how to run them alone: the top-level command whose pipeline runs a test runner, the
 * directory every `cd` before it leads to, whether `base run` ran it (and at what `--at` named), and its stage alone,
 * without what is piped after it or its redirections (`alone`). `alone` is absent where two commands run tests or the
 * runner reads a pipe, and `mixed` says two ran in different places (`base run cargo test; cargo test`), whose output
 * no one record can hold. Undefined where the line cannot be split safely or no runner is in plain sight in it; the
 * caller then follows only its leading `cd`s.
 */
const testRunOf = (command, cwd) => {
    const commands = shellCommands(command);
    if (commands === undefined) {
        return undefined;
    }
    const runs = [];
    const exported = [];
    let dir = cwd;
    let previous = cwd;
    for (const [index, { after, stages }] of commands.entries()) {
        const stage = stages.findIndex(runsTests);
        const [program, ...args] = stages[0];
        // A `cd` in a pipeline or in the background moves a subshell, and one after `||` may not have run.
        const ownShell = stages.length === 1 && after !== "||" && commands[index + 1]?.after !== "&";
        if (stage !== -1) {
            runs.push({ dir, stage: stages[stage], first: stage === 0, exported: [...exported] });
        } else if (program.value === "pushd" || program.value === "popd") {
            return undefined;
        } else if (ownShell && program.value === "cd") {
            const to = cdTarget(args, dir, previous);
            if (to === undefined) {
                return undefined;
            }
            [previous, dir] = [dir, to];
        } else if (ownShell && program.value === "export") {
            exported.push(...args.filter((word) => ASSIGNMENT.test(word.raw)));
        }
    }
    const [run] = runs;
    if (run === undefined) {
        return undefined;
    }
    const base = baseRunOf(run.stage);
    const mixed = runs.some((other) => other.dir !== run.dir || (baseRunOf(other.stage) === undefined) !== (base === undefined));
    const alone = runs.length === 1 && run.first && base === undefined ? aloneOf(run.stage, run.exported) : undefined;
    return { dir: existsSync(run.dir) ? run.dir : cwd, base, alone, mixed };
};

// A line `testRunOf` cannot read: its leading `cd`s, `base run` only at the front of what follows them, and no command
// named to record a baseline with.
const leadingRunOf = (command, cwd) => {
    const { dir, rest } = leadingCds(command, cwd);
    return { dir, base: BASE_RUN.test(rest) ? { at: undefined } : undefined, alone: undefined, mixed: false };
};

const shellWord = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

// The command that records a run of these tests at the fork point, from where this line started: a `cd` to where the
// tests ran when that is elsewhere, then the test command alone under `base run`; without `base`, the test command
// alone. Undefined where the line's test command could not be singled out: running the line again would run its edits
// there too.
const recordingCommand = (run, cwd, hasBase) => {
    if (run.alone === undefined) {
        return undefined;
    }
    if (!hasBase) {
        return [...run.alone.env, ...run.alone.words].join(" ");
    }
    const cd = run.dir === cwd ? "" : `cd ${shellWord(run.dir)} && `;
    return `${cd}${[...run.alone.env, "base", "run", ...run.alone.words].join(" ")}`;
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

// When a "new" failure names the load it ran at: this run's load per core at or above LOADED, and at least LOAD_RATIO
// times that of the baseline run that passed the test at the highest load. Below either, the two runs are close enough
// that the failure is the change's to explain. 2026-11-22, cider-644m: ten tests that spawn real server processes failed
// at load 11-16 on 16 cores and were labelled new; the agent reverted its diff twice, and the clean tree failed the same
// way at that load.
const LOADED = 0.75;
const LOAD_RATIO = 2;
const perCore = (load) => load.one / load.cores;
const loadText = (load) => `${load.one.toFixed(1)}/${load.cores}`;

// The machine's load as a run ends: the 1-minute load average over the cores it is shared by. A container reads the
// host's load average, so the count is the host's (os.cpus), not the container's share. Undefined where there is no
// load average (Windows reports zeros).
const machineLoad = () => {
    const [one = Number.NaN] = loadavg();
    const cores = cpus().length;
    return process.platform === "win32" || !Number.isFinite(one) || cores === 0 ? undefined : { one: Math.round(one * 100) / 100, cores };
};

// The load of the baseline run that passed this test at the load nearest this run's, when even that one ran much calmer
// than this run: what a timing-sensitive failure may owe to load alone.
const calmerPass = (passes, load) => {
    if (load === undefined || perCore(load) < LOADED) {
        return undefined;
    }
    const [nearest] = passes.flatMap((run) => (run.load === undefined ? [] : [run.load])).toSorted((a, b) => perCore(b) - perCore(a));
    return nearest !== undefined && perCore(load) >= LOAD_RATIO * perCore(nearest) ? nearest : undefined;
};

// What the baseline says of one failure, and in which order the digest lists it. Only a baseline run that passed the
// test makes its failure new, the clearest sign of the change's own breakage, listed first; then what no baseline run
// there included, which says nothing either way; then what fails there too. 2026-11-22, cider-644m: ten tests the
// baseline never ran were labelled "new: not seen failing at main".
const verdictOf = (test, known, load, now) => {
    const at = mainAt(known.sha);
    const failedThere = known.runs.find((run) => run.failed.some((failure) => sameTest(failure, test)));
    const passes = known.runs.filter((run) => passedIn(run, test.id));
    if (failedThere !== undefined) {
        const flaky = passes.length > 0 ? "; it passed there too, so flaky" : "";
        return { rank: 2, kind: "main", label: `also fails at ${at} (seen ${ago(now - failedThere.at)}${flaky})` };
    }
    if (passes.length === 0) {
        return { rank: 1, kind: "unrun", label: `not run at ${at}: no recorded run there includes it` };
    }
    const calm = calmerPass(passes, load);
    const label =
        calm === undefined
            ? `new: passes at ${at}`
            : `new: passed at ${at} at load ${loadText(calm)}; this run at ${loadText(load)}, so a timing-sensitive test may fail from load alone: \`base run\` it now to compare`;
    return { rank: 0, kind: "new", label };
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

// How to record a run at the fork point, named just before as "there": the test command alone, under `base` where it
// is installed (asked only now, so a run that needs no such line never looks).
const recordHow = (run, cwd, fork, hasBase = onPath("base")) => {
    const command = recordingCommand(run, cwd, hasBase);
    if (hasBase) {
        return command === undefined ? "run the test command alone through `base run` to run it there and record it" : `\`${command}\` runs this there and records it`;
    }
    const what = command === undefined ? "the test command alone" : `\`${command}\``;
    return `run ${what} once in a clean checkout of that commit (\`git worktree add --detach <dir> ${fork.slice(0, SHORT_SHA)}\`) and it is recorded`;
};

// What to record where the baseline lacks something: all of it where none is recorded, else the failures no baseline
// run included.
const recordingLines = ({ judged, where, known, recordedBaseline, recording, run, cwd, hasBase }) => {
    const fork = recording && !recordedBaseline ? where?.fork : undefined;
    const unrun = judged.filter(({ verdict }) => verdict?.kind === "unrun").length;
    if (fork === undefined || (known !== undefined && unrun === 0)) {
        return [];
    }
    const how = recordHow(run, cwd, fork, hasBase);
    if (known === undefined) {
        return [`--- no baseline: nothing is recorded of these tests at ${mainAt(fork)} (your fork point); ${how}, and every later run is labelled against it. \`agents ci\` lists what main's CI is known to fail on.`];
    }
    const fromFork = known.sha === fork ? "" : ` nor recorded at ${mainAt(fork)} (your fork point)`;
    return [`--- ${unrun} of these ${unrun === 1 ? "was" : "were"} not run at ${mainAt(known.sha)}${fromFork}; ${how}.`];
};

const countsLine = (parsed) => {
    const { passed, failed, ignored } = parsed.counts;
    return `--- tests: ${failed} failed, ${passed} passed${ignored > 0 ? `, ${ignored} ignored` : ""} (${parsed.runners.join(", ")})`;
};

// The failures past the ones shown, counted by verdict; the ones no baseline run included only where there are some.
const unshownSplit = (unshown, known) => {
    const count = (kind) => unshown.filter(({ verdict }) => verdict?.kind === kind).length;
    const unrun = count("unrun");
    return `: ${count("new")} new, ${unrun > 0 ? `${unrun} not run at ${mainAt(known.sha)}, ` : ""}${count("main")} also failing at ${mainAt(known.sha)}`;
};

// The digest's lines: the counts and what they were compared with, a line per failure, and how to record what the
// baseline lacks.
const render = (digest) => {
    const { parsed, failures, where, known, recordedBaseline, load, now } = digest;
    const against = recordedBaseline
        ? ` · ran on a clean tree at ${mainAt(where.sha)}: recorded as its baseline, so these fail at main itself`
        : known === undefined
          ? ""
          : ` · against ${mainAt(known.sha)} (${distanceWords(known)})`;
    const judged = failures
        .map((test) => ({ test, verdict: known === undefined ? undefined : verdictOf(test, known, load, now) }))
        .toSorted((a, b) => (a.verdict?.rank ?? 0) - (b.verdict?.rank ?? 0));
    const lines = judged.slice(0, SHOWN_FAILURES).map(({ test, verdict }) => {
        const why = test.line === undefined ? "" : `: ${test.line}`;
        return `✗ ${test.id}${why}${verdict === undefined ? "" : ` — ${verdict.label}`}`;
    });
    const unshown = judged.slice(SHOWN_FAILURES);
    const more = unshown.length > 0 ? [`… +${unshown.length} more failing${known === undefined ? "" : unshownSplit(unshown, known)} (each in the full output)`] : [];
    return [`${countsLine(parsed)}${against}`, ...lines, ...more, ...recordingLines({ ...digest, judged })].join("\n");
};

// The commit a `base run` ran at: the fork point, unless `--at` named the main line's tip or a commit git resolves here.
const baseCommit = (tree, at) => {
    if (at === undefined || at === "fork") {
        return tree.fork;
    }
    const ref = at === "main" ? tree.mainRef : at;
    return ref === undefined ? undefined : git(tree.top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])?.trim();
};

// Where the run's tests ran, as the record files it: this checkout, or for `base run` the commit its base stood at on a
// clean tree, on the main line when that commit is.
const runPlace = (base, cwd) => {
    const tree = treeState(cwd);
    if (tree === undefined || base === undefined) {
        return tree;
    }
    const sha = baseCommit(tree, base.at);
    if (sha === undefined) {
        return undefined;
    }
    const onMain = sha === tree.fork || (tree.mainRef !== undefined && git(tree.top, ["merge-base", "--is-ancestor", sha, tree.mainRef]) !== undefined);
    return { ...tree, sha, clean: true, tree: "clean", onMain };
};

/**
 * One test command's digest, and its run recorded under `dir`: "" when the command runs no tests, its output names
 * none, or it failed none. `lines` is the output cleaned of ANSI; `narrowed` says a pipeline stage may have dropped some
 * of it, which the record keeps. `hasBase`, `now` and `load` (the machine's, read when absent) are for tests.
 */
export const testDigest = (lines, { command, cwd, dir, by, narrowed = false, now = Date.now(), hasBase, load }) => {
    if (!TEST_COMMAND.test(command)) {
        return "";
    }
    const parsed = parseTestRun(lines);
    if (parsed === undefined) {
        return "";
    }
    const run = testRunOf(command, cwd) ?? leadingRunOf(command, cwd);
    const where = run.mixed ? undefined : runPlace(run.base, run.dir);
    const tests = parsed.tests.map((test) => {
        const named = { ...test, file: repoFile(test.file, run.dir, where?.top) };
        return { ...named, id: testId(named) };
    });
    const ranAt = load ?? machineLoad();
    const recordedBaseline = where !== undefined && where.clean && where.onMain;
    if (dir !== undefined && where !== undefined) {
        const partial = narrowed || !parsed.summarized;
        recordRun(dir, { ...where, baseline: recordedBaseline, command, by, runners: parsed.runners, partial, counts: parsed.counts, tests, load: ranAt }, now);
    }
    const failures = tests.filter((test) => test.outcome === "fail");
    if (failures.length === 0 && parsed.counts.failed === 0) {
        return "";
    }
    const known = recordedBaseline || dir === undefined || where?.fork === undefined ? undefined : baselineFor(dir, where.top, where.fork);
    return render({ parsed, failures, where, known, recordedBaseline, recording: dir !== undefined, run, cwd, hasBase, load: ranAt, now });
};
