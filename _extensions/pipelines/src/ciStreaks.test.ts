import type { PipelineRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { failureStreaks, openFailures, streakTooltip, supersededBy, unseenStreaks } from "./ciStreaks";
import { type JobFailureRun, recurringFailures } from "./failureHistory";

/* The rail badge's two derivations. Both exist to answer "is this news?", and both are worth pinning down
 * because the failure mode is silent: a badge that counts the wrong thing still renders a plausible number. */

const run = (runId: number, status: PipelineRun["status"], createdAt: number, branch = "main"): PipelineRun => ({
    repo: "intentic",
    host: "gitlab",
    project: "radarsu/intentic",
    runId,
    branch,
    sha: "abc1234",
    status,
    url: "u",
    createdAt,
});

test("a streak starts when the branch went red, not at its newest failure", () => {
    const streaks = failureStreaks([run(1, "failed", 50), run(2, "failed", 40), run(3, "failed", 30), run(4, "success", 20)]);
    expect(streaks).toHaveLength(1);
    // The whole anti-spam property: `since` is the OLDEST consecutive failure, so later failures inside the
    // same breakage don't move it forward and can't re-badge.
    expect(streaks[0]).toMatchObject({ repo: "intentic", branch: "main", since: 30, runs: 3 });
});

test("green at the head ends the streak", () => {
    expect(failureStreaks([run(1, "success", 50), run(2, "failed", 40)])).toHaveLength(0);
});

test("canceled, skipped and running are not verdicts: they neither start nor break a streak", () => {
    const streaks = failureStreaks([
        run(1, "canceled", 60),
        run(2, "failed", 50),
        run(3, "skipped", 45),
        run(4, "failed", 40),
        run(5, "success", 30),
    ]);
    expect(streaks[0]).toMatchObject({ since: 40, runs: 2 });
    // A push that supersedes a running pipeline must not read as a recovery.
    expect(failureStreaks([run(1, "running", 60), run(2, "failed", 50)])).toHaveLength(1);
});

test("streaks are per branch", () => {
    expect(failureStreaks([run(1, "failed", 50, "main"), run(2, "failed", 40, "feat"), run(3, "success", 30, "feat")])).toHaveLength(2);
});

test("a breakage badges once and then stays quiet however many more runs fail", () => {
    const streaks = failureStreaks([run(1, "failed", 50), run(2, "failed", 40), run(3, "failed", 30), run(4, "success", 20)]);
    expect(unseenStreaks(streaks, undefined)).toHaveLength(1); // never opened the view
    expect(unseenStreaks(streaks, 25)).toHaveLength(1); // last looked before it broke
    // Looked after it broke: two further runs have failed since, and the rail stays silent. This is the rule
    // that keeps the badge usable on a repo where most runs fail.
    expect(unseenStreaks(streaks, 35)).toHaveLength(0);
});

test("the tooltip names the branch while there is only one", () => {
    const streaks = failureStreaks([run(1, "failed", 50), run(2, "failed", 40)]);
    const [only] = streaks;
    const single = streakTooltip(streaks);
    expect(single).toContain(only?.repo);
    expect(single).toContain(only?.branch);
    expect(single).toContain(String(only?.runs));
    const multi = streakTooltip([...streaks, ...failureStreaks([run(3, "failed", 50, "feat")])]);
    expect(multi).toContain(String(2));
    expect(multi).not.toBe(single);
});

/* The row tiering's two derivations. Same "green at the head" rule as the badge, read per run: which failure
 * still asks to be fixed, and which one a later green closed. */

test("only the head of a red branch is an open failure: the ones behind it are the same breakage", () => {
    const head = run(1, "failed", 50);
    const behind = run(2, "failed", 40);
    const open = openFailures([head, behind, run(3, "success", 30)]);
    expect(open.has(head)).toBe(true);
    // Unfixed, but not a second thing to fix: flagging it too is how one breakage becomes three demands.
    expect(open.has(behind)).toBe(false);
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
