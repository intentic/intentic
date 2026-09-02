import type { PipelineRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { failureStreaks, openFailures, streakTooltip, supersededBy } from "./ciStreaks";
import { type JobFailureRun, recurringFailures } from "./failureHistory";

/* The rail badge's derivations. Both answer "is this branch red right now?", and both are worth pinning down
 * because the failure mode is silent: a badge that counts the wrong thing still renders a plausible number.
 *
 * `sha` defaults to one per run, so a test spells out a stream of commits unless it says otherwise. Passing the
 * SAME sha to several runs is the case this file exists for: one push firing several workflows. */

const run = (runId: number, status: PipelineRun["status"], createdAt: number, branch = "main", sha = `sha${runId}`): PipelineRun => ({
    repo: "intentic",
    host: "gitlab",
    project: "radarsu/intentic",
    runId,
    branch,
    sha,
    status,
    url: "u",
    createdAt,
});

test("a streak starts when the branch went red, not at its newest failure", () => {
    const streaks = failureStreaks([run(1, "failed", 50), run(2, "failed", 40), run(3, "failed", 30), run(4, "success", 20)]);
    expect(streaks).toHaveLength(1);
    // `since` is the OLDEST failure still inside the breakage, so it names when the branch went red rather
    // than when it last said so.
    expect(streaks[0]).toMatchObject({ repo: "intentic", branch: "main", sha: "sha1", since: 30, commits: 3, runs: 3 });
});

test("green at the head ends the streak", () => {
    expect(failureStreaks([run(1, "success", 50), run(2, "failed", 40)])).toHaveLength(0);
});

/* THE BUG THIS RULE EXISTS FOR. One push fires every workflow the repo has, they start in the same second, and
 * which of them carries the newest timestamp is a coin toss. Reading the branch off the newest RUN let a green
 * sibling hide a red one and blinked the badge out while main was broken. */
test("a commit with one failed run among green siblings is a red commit", () => {
    const push = [run(1, "success", 51, "main", "head"), run(2, "failed", 50, "main", "head"), run(3, "success", 49, "main", "head")];
    expect(failureStreaks(push)).toHaveLength(1);
    // Whichever sibling the vendor happens to timestamp last.
    expect(failureStreaks([run(1, "failed", 49, "main", "head"), run(2, "success", 50, "main", "head")])).toHaveLength(1);
    // And the streak is one commit deep however many of its runs are red: the count is branches, not failures.
    const both = failureStreaks([run(1, "failed", 51, "main", "head"), run(2, "failed", 50, "main", "head")]);
    expect(both[0]).toMatchObject({ commits: 1, runs: 2 });
});

test("a later commit that passes clean is what ends it", () => {
    const runs = [run(1, "success", 60, "main", "fixed"), run(2, "failed", 50, "main", "broke"), run(3, "success", 51, "main", "broke")];
    expect(failureStreaks(runs)).toHaveLength(0);
    // A newer commit that is itself mixed is not a recovery: the branch is still red, now at the new commit.
    const mixed = failureStreaks([run(4, "failed", 60, "main", "next"), run(5, "success", 61, "main", "next"), ...runs.slice(1)]);
    expect(mixed[0]).toMatchObject({ sha: "next", commits: 2, since: 50 });
});

test("canceled, skipped and running are not verdicts: they neither start nor break a streak", () => {
    const streaks = failureStreaks([
        run(1, "canceled", 60),
        run(2, "failed", 50),
        run(3, "skipped", 45),
        run(4, "failed", 40),
        run(5, "success", 30),
    ]);
    expect(streaks[0]).toMatchObject({ since: 40, commits: 2, runs: 2 });
    // A push that supersedes a running pipeline must not read as a recovery.
    expect(failureStreaks([run(1, "running", 60), run(2, "failed", 50)])).toHaveLength(1);
});

test("streaks are per branch", () => {
    expect(failureStreaks([run(1, "failed", 50, "main"), run(2, "failed", 40, "feat"), run(3, "success", 30, "feat")])).toHaveLength(2);
});

test("a breakage keeps badging for as long as it is broken", () => {
    // No read marker anywhere in the derivation: the same runs give the same answer however often the board
    // has been opened. Looking at a broken branch is not fixing it.
    const runs = [run(1, "failed", 50), run(2, "failed", 40), run(3, "failed", 30), run(4, "success", 20)];
    expect(failureStreaks(runs)).toHaveLength(1);
    expect(failureStreaks(runs)).toEqual(failureStreaks(runs));
    // It clears the only way the condition does: a commit that passes.
    expect(failureStreaks([run(5, "success", 60), ...runs])).toHaveLength(0);
});

test("the tooltip names the branch while there is only one", () => {
    const streaks = failureStreaks([run(1, "failed", 50), run(2, "failed", 40)]);
    const [only] = streaks;
    const single = streakTooltip(streaks);
    expect(single).toContain(only?.repo);
    expect(single).toContain(only?.branch);
    expect(single).toContain(String(only?.commits));
    // One commit is the ordinary breakage, and the tooltip names the commit rather than counting to one.
    const oneCommit = streakTooltip(failureStreaks([run(1, "failed", 50, "main", "abcdef1234")]));
    expect(oneCommit).toContain("abcdef1");
    const multi = streakTooltip([...streaks, ...failureStreaks([run(3, "failed", 50, "feat")])]);
    expect(multi).toContain(String(2));
    expect(multi).not.toBe(single);
});

/* The row tiering's two derivations. Same head-commit rule as the badge, read per run: which failure still
 * asks to be fixed, and which one a later green closed. */

test("only the head commit's failures are open: the ones behind them are the same breakage", () => {
    const head = run(1, "failed", 50);
    const behind = run(2, "failed", 40);
    const open = openFailures([head, behind, run(3, "success", 30)]);
    expect(open.has(head)).toBe(true);
    // Unfixed, but not a second thing to fix: flagging it too is how one breakage becomes three demands.
    expect(open.has(behind)).toBe(false);
});

test("two workflows failing on the head commit are two open failures", () => {
    // Two pipelines, two logs, two fix buttons: the thing this must not do is silently drop one of them.
    const first = run(1, "failed", 50, "main", "head");
    const second = run(2, "failed", 49, "main", "head");
    const open = openFailures([first, second, run(3, "success", 48, "main", "head")]);
    expect([...open]).toEqual([first, second]);
});

test("a branch that recovered has no open failure", () => {
    expect(openFailures([run(1, "success", 50), run(2, "failed", 40)]).size).toBe(0);
    // Per branch: main is red while feat is green.
    expect(openFailures([run(1, "failed", 50, "main"), run(2, "success", 40, "feat"), run(3, "failed", 30, "feat")]).size).toBe(1);
});

test("a failure is superseded by the run that recovered the branch, not by the newest green", () => {
    const failure = run(1, "failed", 10);
    const recovery = run(2, "success", 20);
    const later = run(3, "success", 30);
    const superseded = supersededBy([later, recovery, failure]);
    expect(superseded.get(failure)).toBe(recovery);
    // A success supersedes nothing, and the green rows carry no chip.
    expect(superseded.get(recovery)).toBeUndefined();
});

test("a green run on the failure's OWN commit does not supersede it", () => {
    // A different workflow passing on the same broken code is not a recovery, and saying "superseded by" of it
    // would tell the reader their breakage is over while it is the branch's last word.
    const failure = run(1, "failed", 50, "main", "head");
    const sibling = run(2, "success", 51, "main", "head");
    expect(supersededBy([sibling, failure]).size).toBe(0);
    // The next commit passing clean is: that is the one that closed it.
    const recovery = run(3, "success", 60, "main", "next");
    expect(supersededBy([recovery, sibling, failure]).get(failure)).toBe(recovery);
});

test("a failure with nothing green after it is not superseded", () => {
    const head = run(1, "failed", 50);
    const behind = run(2, "failed", 40);
    const superseded = supersededBy([head, behind]);
    expect(superseded.size).toBe(0);
    // And a green on ANOTHER branch cannot close it.
    expect(supersededBy([head, run(3, "success", 60, "feat")]).size).toBe(0);
});

test("canceled and running runs after a failure do not supersede it", () => {
    const failure = run(1, "failed", 10);
    // Neither is a verdict, so neither is evidence the branch recovered: the same rule the streaks follow.
    expect(supersededBy([run(2, "canceled", 30), run(3, "running", 20), failure]).size).toBe(0);
});

const entry = (createdAt: number, failed: readonly string[] | undefined, branch = "main"): JobFailureRun => ({
    repo: "intentic",
    branch,
    createdAt,
    failed,
});

test("a job failing run after run is one problem, not many failures", () => {
    const recurring = recurringFailures([entry(50, ["eslint", "unit"]), entry(40, ["eslint"]), entry(30, ["eslint"]), entry(20, [])]);
    expect(recurring[0]).toMatchObject({ job: "eslint", runs: 3 });
    // Failed once, in the newest run only: that is the thing that just changed, not a pattern.
    expect(recurring.find((item) => item.job === "unit")).toBeUndefined();
});

test("a green run in between splits one streak into two short ones", () => {
    expect(recurringFailures([entry(50, ["eslint"]), entry(40, []), entry(30, ["eslint"])])).toHaveLength(0);
});

test("a run whose jobs have not loaded stops the walk instead of joining streaks across it", () => {
    expect(recurringFailures([entry(50, ["eslint"]), entry(40, undefined), entry(30, ["eslint"])])).toHaveLength(0);
});

test("recurrence is counted per branch", () => {
    const recurring = recurringFailures([entry(50, ["a"], "main"), entry(40, ["a"], "main"), entry(45, ["a"], "feat")]);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({ branch: "main", runs: 2 });
});
