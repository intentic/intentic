import type { PipelineRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { arrivesOpen, failureStreaks, openFailures, inFlightOnHead, streakTooltip, supersededBy } from "./ciStreaks";
import { type JobFailureRun, recurringFailures } from "./failureHistory";

// Pins failureStreaks and friends: is this branch red right now. `sha` defaults to one per run; the same sha on several
// runs models one push firing several workflows.

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
    expect(streaks[0]).toMatchObject({ repo: "intentic", branch: "main", sha: "sha1", since: 30, commits: 3, runs: 3 });
});

test("green at the head ends the streak", () => {
    expect(failureStreaks([run(1, "success", 50), run(2, "failed", 40)])).toHaveLength(0);
});

test("a commit with one failed run among green siblings is a red commit", () => {
    const push = [run(1, "success", 51, "main", "head"), run(2, "failed", 50, "main", "head"), run(3, "success", 49, "main", "head")];
    expect(failureStreaks(push)).toHaveLength(1);
    // Order-independent: whichever sibling the vendor timestamps last.
    expect(failureStreaks([run(1, "failed", 49, "main", "head"), run(2, "success", 50, "main", "head")])).toHaveLength(1);
    // Commits counts branches, not failing runs: stays 1 even with 2 failed runs.
    const both = failureStreaks([run(1, "failed", 51, "main", "head"), run(2, "failed", 50, "main", "head")]);
    expect(both[0]).toMatchObject({ commits: 1, runs: 2 });
});

test("a later commit that passes clean is what ends it", () => {
    const runs = [run(1, "success", 60, "main", "fixed"), run(2, "failed", 50, "main", "broke"), run(3, "success", 51, "main", "broke")];
    expect(failureStreaks(runs)).toHaveLength(0);
    // A mixed newer commit isn't a recovery; the branch stays red, now at the new commit.
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
    expect(failureStreaks([run(1, "running", 60), run(2, "failed", 50)])).toHaveLength(1);
});

test("streaks are per branch", () => {
    expect(failureStreaks([run(1, "failed", 50, "main"), run(2, "failed", 40, "feat"), run(3, "success", 30, "feat")])).toHaveLength(2);
});

test("a breakage keeps badging for as long as it is broken", () => {
    // No read marker: the same input gives the same answer regardless of how often it's read.
    const runs = [run(1, "failed", 50), run(2, "failed", 40), run(3, "failed", 30), run(4, "success", 20)];
    expect(failureStreaks(runs)).toHaveLength(1);
    expect(failureStreaks(runs)).toEqual(failureStreaks(runs));
    // Clears only when a commit actually passes.
    expect(failureStreaks([run(5, "success", 60), ...runs])).toHaveLength(0);
});

test("the tooltip names the branch while there is only one", () => {
    const streaks = failureStreaks([run(1, "failed", 50), run(2, "failed", 40)]);
    const [only] = streaks;
    const single = streakTooltip(streaks);
    expect(single).toContain(only?.repo);
    expect(single).toContain(only?.branch);
    expect(single).toContain(String(only?.commits));
    // One-commit streaks name the commit, not a count of 1.
    const oneCommit = streakTooltip(failureStreaks([run(1, "failed", 50, "main", "abcdef1234")]));
    expect(oneCommit).toContain("abcdef1");
    const multi = streakTooltip([...streaks, ...failureStreaks([run(3, "failed", 50, "feat")])]);
    expect(multi).toContain(String(2));
    expect(multi).not.toBe(single);
});

// openFailures/supersededBy: same head-commit rule as the badge, applied per run.

test("only the head commit's failures are open: the ones behind them are the same breakage", () => {
    const head = run(1, "failed", 50);
    const behind = run(2, "failed", 40);
    const open = openFailures([head, behind, run(3, "success", 30)]);
    expect(open.has(head)).toBe(true);
    expect(open.has(behind)).toBe(false);
});

test("two workflows failing on the head commit are two open failures", () => {
    const first = run(1, "failed", 50, "main", "head");
    const second = run(2, "failed", 49, "main", "head");
    const open = openFailures([first, second, run(3, "success", 48, "main", "head")]);
    expect([...open]).toEqual([first, second]);
});

test("a branch that recovered has no open failure", () => {
    expect(openFailures([run(1, "success", 50), run(2, "failed", 40)]).size).toBe(0);
    // Per branch: main red, feat green.
    expect(openFailures([run(1, "failed", 50, "main"), run(2, "success", 40, "feat"), run(3, "failed", 30, "feat")]).size).toBe(1);
});

test("a failure is superseded by the run that recovered the branch, not by the newest green", () => {
    const failure = run(1, "failed", 10);
    const recovery = run(2, "success", 20);
    const later = run(3, "success", 30);
    const superseded = supersededBy([later, recovery, failure]);
    expect(superseded.get(failure)).toBe(recovery);
    expect(superseded.get(recovery)).toBeUndefined();
});

test("a green run on the failure's OWN commit does not supersede it", () => {
    const failure = run(1, "failed", 50, "main", "head");
    const sibling = run(2, "success", 51, "main", "head");
    expect(supersededBy([sibling, failure]).size).toBe(0);
    // The next commit passing clean does close it.
    const recovery = run(3, "success", 60, "main", "next");
    expect(supersededBy([recovery, sibling, failure]).get(failure)).toBe(recovery);
});

test("a failure with nothing green after it is not superseded", () => {
    const head = run(1, "failed", 50);
    const behind = run(2, "failed", 40);
    const superseded = supersededBy([head, behind]);
    expect(superseded.size).toBe(0);
    // A green on another branch cannot close it.
    expect(supersededBy([head, run(3, "success", 60, "feat")]).size).toBe(0);
});

test("canceled and running runs after a failure do not supersede it", () => {
    const failure = run(1, "failed", 10);
    expect(supersededBy([run(2, "canceled", 30), run(3, "running", 20), failure]).size).toBe(0);
});

// inFlightOnHead: still going AND on the branch's newest commit; both halves load-bearing.

test("a run still going on the branch's newest commit is what the board opens", () => {
    const live = run(1, "running", 50, "main", "head");
    const stale = run(2, "running", 40, "main", "before");
    const open = inFlightOnHead([live, stale]);
    expect(open.has(live)).toBe(true);
    // Running, but on code a later push replaced: a stale re-run, not what the board opens for.
    expect(open.has(stale)).toBe(false);
});

// inFlightOnHead needs its own walk: the streak walk only keeps verdicted runs, so an all-running push has no commit in
// it at all.
test("a push whose pipelines are all still going is its own head commit", () => {
    const live = run(1, "running", 60, "main", "pushed");
    expect(inFlightOnHead([live, run(2, "success", 50, "main", "before")]).has(live)).toBe(true);
});

test("a run held at the runner is opened too: that is when the graph answers the only question there is", () => {
    const held = run(1, "queued", 50, "main", "head");
    expect(inFlightOnHead([held]).has(held)).toBe(true);
    expect(arrivesOpen([held]).has(held)).toBe(true);
    // Stale queued run (code since replaced) stays shut.
    const stale = run(2, "queued", 40, "main", "before");
    expect(inFlightOnHead([held, stale]).has(stale)).toBe(false);
});

test("a finished run on the head commit is not opened, however new it is", () => {
    const done = run(1, "success", 50, "main", "head");
    expect(inFlightOnHead([done, run(2, "failed", 49, "main", "head")]).size).toBe(0);
});

test("every branch with something in flight gets its own row opened", () => {
    const mine = run(1, "running", 40, "feat", "mine");
    const theirs = run(2, "running", 50, "main", "theirs");
    expect(inFlightOnHead([theirs, mine, run(3, "success", 30, "feat", "older")])).toEqual(new Set([theirs, mine]));
});

// arrivesOpen: everything the newest commit has to say that isn't 'fine'. Pins what stays shut as much as what opens.

test("the head commit's failures arrive open, not just its live runs", () => {
    const broke = run(1, "failed", 50, "main", "head");
    expect(arrivesOpen([broke]).has(broke)).toBe(true);
    const live = run(2, "running", 60, "feat", "building");
    expect(arrivesOpen([broke, live])).toEqual(new Set([broke, live]));
});

test("a commit still building with a failure of its own opens both rows", () => {
    const broke = run(1, "failed", 50, "main", "head");
    const going = run(2, "running", 49, "main", "head");
    expect(arrivesOpen([broke, going])).toEqual(new Set([broke, going]));
});

test("a fresh push shows its live graph beside the failure the last commit left open", () => {
    const pushed = run(1, "running", 60, "main", "pushed");
    const broke = run(2, "failed", 50, "main", "before");
    expect(arrivesOpen([pushed, broke])).toEqual(new Set([pushed, broke]));
});

test("a failure that is not the branch's current problem stays shut", () => {
    const head = run(1, "failed", 50);
    const behind = run(2, "failed", 40);
    expect(arrivesOpen([head, behind])).toEqual(new Set([head]));
    // Closed by a later passing commit; that's history now, not reopened.
    expect(arrivesOpen([run(3, "success", 60), head, behind]).size).toBe(0);
});

test("a passing board opens nothing", () => {
    expect(arrivesOpen([run(1, "success", 50, "main", "head"), run(2, "success", 49, "main", "head")]).size).toBe(0);
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
    // Failed once, in the newest run only: not yet a pattern.
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

// Tag refs (release dispatch's head_branch, e.g. v1.245.0) must not participate in auto-open: read as branches, they'd
// create pseudo-branches with stale runs.

test("a running run on a tag ref does not auto-open", () => {
    const tagRun = run(1, "running", 50, "v1.245.0", "cee7a1d");
    const mainRun = run(2, "running", 40, "main", "abc1234");
    const open = inFlightOnHead([tagRun, mainRun]);
    expect(open.has(tagRun)).toBe(false);
    expect(open.has(mainRun)).toBe(true);
});

test("a failed run on a tag ref does not auto-open", () => {
    const tagRun = run(1, "failed", 50, "v1.245.0", "cee7a1d");
    const mainRun = run(2, "failed", 40, "main", "abc1234");
    const open = openFailures([tagRun, mainRun]);
    expect(open.has(tagRun)).toBe(false);
    expect(open.has(mainRun)).toBe(true);
});

test("arrivesOpen excludes both running and failed tag ref runs", () => {
    const tagRunning = run(1, "running", 60, "v2.0.0", "sha1");
    const tagFailed = run(2, "failed", 50, "v1.245.0", "sha2");
    const mainRunning = run(3, "running", 40, "main", "sha3");
    const open = arrivesOpen([tagRunning, tagFailed, mainRunning]);
    expect(open.has(tagRunning)).toBe(false);
    expect(open.has(tagFailed)).toBe(false);
    expect(open.has(mainRunning)).toBe(true);
});

test("tag ref detection matches semver patterns", () => {
    const tags = ["v1.0.0", "v1.245.0", "v0.0.1", "v10.20.30", "v1.0.0-alpha", "v2.0.0-beta.1"];
    for (const tag of tags) {
        const tagRun = run(1, "running", 50, tag);
        expect(inFlightOnHead([tagRun]).size).toBe(0);
    }
    // Near-miss branch names that only look tag-like must still count as ordinary branches.
    const branches = ["main", "feat/v1-migration", "release-v1", "v1-branch", "version-1.0.0"];
    for (const branch of branches) {
        const branchRun = run(1, "running", 50, branch);
        expect(inFlightOnHead([branchRun]).size).toBe(1);
    }
});
