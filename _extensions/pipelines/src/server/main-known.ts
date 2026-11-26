import { errorMessage } from "@intentic/base/errors";
import type { CiFailure, CiFinding, CiLocalMain, CiMainBranch, CiMainJob, CiMainLine, CiMainResponse } from "@intentic/sandbox-contract/schemas/ci";
import { fixerOf } from "./main-streak.js";
import { opt } from "./opt.js";
import type { Repair } from "./repair.js";

/* WHAT MAIN IS KNOWN TO FAIL ON, FOR AN AGENT THAT MEETS A FAILURE.
   2026-11-17, the shinobi-society audit: conversation after conversation spent calls finding out whether a failing test
   was its own or already failing on main (stashing its work, re-running main, comparing), while the daemon followed
   main's CI and had read every failed job's log (main-fixer.ts). This says it in one call (`agents ci`, GET /ci/main):
   each job failing on a main line now, the run and commit it last failed in, when that was read, and what its log named.
   Read from this extension's record and the core's last conclusions alone, never the forge: the answer is as fresh as
   the last run a webhook or the poller brought, and says when that was. Where nothing is known (no repository wired to
   CI, no run of main heard yet) it says so, so silence never reads as a passing main.
   Beside CI's, what the sandbox's own test runs saw fail at main (2026-11-19: `agents ci` said "nothing known to fail"
   while sixteen tests failed on main, in suites CI does not run): the core's record of test runs, asked for its rows and
   its words (GET /ci/main/local, the daemon's ci/local-main.ts), since it lives under the history root.
   (2026-11-26) The daemon's ci/known/main-known.ts until main's fix agent moved here; `agents ci` reads it through this
   extension's `main_failures` tool, from the turn's own shell. */

// Enough of a commit for `git merge-base --is-ancestor` to find it.
const SHA_CHARS = 10;

// A finding kept before findings kept their own run (2026-11-17) borrows its workflow's newest failed run and when that
// was heard: a finished failed run leaves exactly its own failures on the workflow (main-fixer.ts failedRun).
const jobOf =
    (streak: CiFailure) =>
    (finding: CiFinding): CiMainJob => ({
        workflow: finding.source,
        job: finding.text,
        ...opt("runId", finding.runId ?? streak.workflows[finding.source]),
        ...opt("sha", finding.sha),
        ...opt("readAt", finding.readAt ?? streak.spans[finding.source]?.failedAt),
        ...opt("errors", finding.errors),
        ...opt("timedOut", finding.timedOut),
    });

// The newest run heard on a branch of a main line, as the core keeps it (GET /ci/main-lines `concluded`).
const lastRunOf = (line: CiMainLine | undefined, branch: string): CiMainBranch["lastRun"] => {
    const heard = line?.concluded.find((each) => each.branch === branch);
    return heard === undefined ? undefined : { status: heard.status, at: heard.at };
};

const failingOf = (lines: readonly CiMainLine[], [key, streak]: readonly [string, CiFailure]): CiMainBranch => {
    const [repo = "", branch = ""] = key.split("\n");
    return {
        repo,
        branch,
        state: "failing",
        since: streak.since,
        jobs: streak.findings.map(jobOf(streak)),
        ...opt("lastRun", lastRunOf(lines.find((line) => line.repo === repo), branch)),
        ...opt("fixer", fixerOf(streak)),
    };
};

// A repository with no failure on file: clear when a finished run of its main line was heard, else unread.
const quietOf = (line: CiMainLine): CiMainBranch => {
    for (const branch of line.branches) {
        const lastRun = lastRunOf(line, branch);
        if (lastRun !== undefined) {
            return { repo: line.repo, branch, state: "clear", jobs: [], lastRun };
        }
    }
    return { repo: line.repo, ...opt("branch", line.named ? line.branches[0] : undefined), state: "unread", jobs: [] };
};

/** Every main line known of: each failing one, then each wired repository with none failing. */
const mainBranches = async (repair: Pick<Repair, "daemon" | "store">): Promise<CiMainBranch[]> => {
    const [lines, failures] = await Promise.all([repair.daemon.mainLines(), repair.store.failures()]);
    const failing = Object.entries(failures).map((entry) => failingOf(lines, entry));
    const quiet = lines.filter((line) => !failing.some(({ repo }) => repo === line.repo)).map(quietOf);
    return [...failing, ...quiet];
};

const ago = (ms: number): string => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

const when = (at: number, now: number): string => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC (${ago(now - at)} ago)`;

// What one failing job's lines say: where it failed and when that was read, then what its log named.
const jobLines = (job: CiMainJob, now: number): string[] => {
    const name = `  ${job.workflow} / ${job.job}${job.timedOut === true ? " (ran out of time)" : ""}`;
    if (job.runId === undefined) {
        return [`${name}: no run of it kept, so open the workflow's runs`];
    }
    const where = `run ${job.runId}${job.sha === undefined ? "" : ` at ${job.sha.slice(0, SHA_CHARS)}`}${job.readAt === undefined ? "" : `, read ${when(job.readAt, now)}`}`;
    if (job.errors === undefined) {
        return [`${name}: ${where}; what its log named was not kept (the log was unreadable, or it failed before the daemon kept that), so open the run`];
    }
    if (job.errors.length === 0) {
        return [`${name}: ${where}; its log named no failing test or error line, so open the run`];
    }
    return [`${name}: ${where}`, ...job.errors.map((error) => `    - ${error}`)];
};

const lastRunWords = (lastRun: CiMainBranch["lastRun"], now: number): string =>
    lastRun === undefined
        ? ""
        : lastRun.status === "success"
          ? ` The newest run heard on it passed, ${when(lastRun.at, now)}.`
          : ` The newest run heard on it failed, ${when(lastRun.at, now)}, on nothing counted as main's code (the CI runners, or a workflow that is not main's CI or was set aside).`;

const branchLines = (branch: CiMainBranch, now: number): string[] => {
    const name = `${branch.repo} · ${branch.branch ?? "its main line"}`;
    if (branch.state === "unread") {
        return [`${name}: no finished run of it heard yet, so nothing is known: a failure there may still be main's.`];
    }
    if (branch.state === "clear") {
        return [`${name}: nothing known to fail.${lastRunWords(branch.lastRun, now)}`];
    }
    const heard = branch.lastRun === undefined ? "" : `, newest run heard ${when(branch.lastRun.at, now)}`;
    const fixer = branch.fixer === undefined ? "" : `; fix agent ${branch.fixer} has it`;
    return [`${name}: FAILING since ${when(branch.since ?? 0, now)}${heard}${fixer}`, ...branch.jobs.flatMap((job) => jobLines(job, now))];
};

const ciLines = (branches: readonly CiMainBranch[], now: number): string[] =>
    branches.length === 0
        ? ["No repository in this workspace is wired to CI (a GitHub or GitLab remote on a connected account), so nothing is known of what fails on main. That is not a passing main."]
        : [
              "What main's CI is known to fail on, from the runs this sandbox heard (no forge was asked now):",
              "",
              ...branches.flatMap((branch) => branchLines(branch, now)),
              "",
              "A failure matching a job or line above is main's, not yours. One matching nothing here is only not known to be main's: main may have moved since the times above, and a repository not listed is not wired to CI.",
          ];

/** The answer in words, as `agents ci` prints it: CI's, then what the sandbox's own runs at main saw fail (`localText`, the
 *  core's words for them, empty when none is recorded). */
export const mainText = (branches: readonly CiMainBranch[], now: number, localText = ""): string => [...ciLines(branches, now), ...(localText === "" ? [] : [localText])].join("\n");

/** What main's CI is known to fail on, in words and as rows, and what the sandbox's own test runs saw fail at main. A
 *  core that could not say the second leaves it out. */
export const mainKnown = async (repair: Pick<Repair, "daemon" | "store" | "logger">, now: number = Date.now()): Promise<CiMainResponse> => {
    const branches = await mainBranches(repair);
    let local: { readonly local: readonly CiLocalMain[]; readonly text: string } | undefined;
    try {
        local = await repair.daemon.localMain();
    } catch (error) {
        repair.logger.warn({ err: errorMessage(error) }, "ci: what the sandbox's own test runs saw at main could not be read");
    }
    return { text: mainText(branches, now, local?.text), branches, ...opt("local", local === undefined ? undefined : [...local.local]) };
};
