import type { CiRepo, CiRunsResponse, PipelineJob, PipelineRun } from "@intentic/sandbox-contract";

/* THE PIPELINES BOARD: acme-shop's two repos on two different hosts, because that is the fact the view exists
 * to flatten — `web` on GitHub, `api` on GitLab, one board, one vocabulary. A visitor who runs both sees their
 * own situation; one who runs either sees theirs.
 *
 * The runs are a plausible afternoon on a HEALTHY workspace: one still going, five green behind it, and one
 * that broke. That balance is the honest picture of CI on a repo whose agents land reviewed work — and it is
 * what the board has to show, because a board that is mostly red teaches the reader that the product's output
 * does not pass, which is the opposite of the claim it sits under.
 *
 * The one failure is a MIXED run rather than a wholesale collapse: `test:integration` is red, everything
 * before it is green, and the deploy behind it is skipped. That is the shape a real break has, and it is the
 * only shape from which the row's fan-in and its "fix with agent" affordance mean anything.
 *
 * There is deliberately no REPEATED failure any more. The streak analysis (useFailureHistory) needs the same
 * job red in consecutive runs, and buying that costs a second red row plus a red banner across the top of the
 * board — a price the whole rest of the picture then pays. The analysis is exercised by its own unit tests
 * (failureHistory.test.ts), which is where a rule belongs; this fixture's job is to be a truthful afternoon.
 *
 * Two shapes of job list, deliberately. GitLab reports a `stage` per job, so the api runs carry stages and the
 * row draws its circles from them; GitHub's jobs API has none, so the web runs carry only timestamps and the
 * view layers them into waves from overlapping runtimes. Both paths therefore render from this one fixture. */

const minutes = (count: number): number => count * 60_000;

const CI_REPOS: CiRepo[] = [
    { repo: `web`, host: `github`, project: `acme/shop-web`, url: `https://github.com/acme/shop-web` },
    { repo: `api`, host: `gitlab`, project: `acme/shop-api`, url: `https://gitlab.com/acme/shop-api` },
];

const ciRuns = (now: number): PipelineRun[] => [
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_821,
        title: `Add Stripe checkout to the pricing page`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `agent/checkout-stripe`,
        sha: `c41f9ab`,
        status: `running`,
        url: `https://github.com/acme/shop-web/actions/runs/4821`,
        createdAt: now - minutes(2),
    },
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_820,
        title: `Fix the flaky signup e2e test`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `agent/flaky-signup`,
        sha: `19a7e55`,
        status: `success`,
        url: `https://github.com/acme/shop-web/actions/runs/4820`,
        createdAt: now - minutes(48),
        durationSeconds: 268,
    },
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_819,
        title: `Tighten the pricing page bundle budget`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `agent/bundle-budget`,
        sha: `0c33d81`,
        status: `success`,
        url: `https://github.com/acme/shop-web/actions/runs/4819`,
        createdAt: now - minutes(96),
        durationSeconds: 254,
    },
    // THE ONE THAT BROKE, and the only red on the board.
    {
        repo: `api`,
        host: `gitlab`,
        project: `acme/shop-api`,
        runId: 90_312,
        title: `Migrate the users table to soft deletes`,
        authorName: `Ada Lovelace`,
        trigger: `merge_request_event`,
        branch: `agent/soft-deletes`,
        sha: `7bd2c04`,
        status: `failed`,
        url: `https://gitlab.com/acme/shop-api/-/pipelines/90312`,
        createdAt: now - minutes(26),
        durationSeconds: 412,
        failedJobs: [`test:integration`],
    },
    {
        repo: `api`,
        host: `gitlab`,
        project: `acme/shop-api`,
        runId: 90_308,
        title: `Draft the release notes for 2.4`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `main`,
        sha: `4f1c8ab`,
        status: `success`,
        url: `https://gitlab.com/acme/shop-api/-/pipelines/90308`,
        createdAt: now - minutes(140),
        durationSeconds: 388,
    },
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_817,
        title: `Nightly dependency audit`,
        authorName: `intentic automation`,
        trigger: `schedule`,
        branch: `main`,
        sha: `4f1c8ab`,
        status: `success`,
        url: `https://github.com/acme/shop-web/actions/runs/4817`,
        createdAt: now - minutes(392),
        durationSeconds: 231,
    },
    {
        repo: `api`,
        host: `gitlab`,
        project: `acme/shop-api`,
        runId: 90_301,
        title: `Refactor the auth middleware onto the new session store`,
        authorName: `Ada Lovelace`,
        trigger: `web`,
        branch: `agent/auth-middleware`,
        sha: `a90bb17`,
        status: `success`,
        url: `https://gitlab.com/acme/shop-api/-/pipelines/90301`,
        createdAt: now - minutes(410),
        durationSeconds: 356,
    },
];

/* One run's jobs, fetched when a row expands. Keyed by repo + the vendor's run id — the same pair rerun and
 * cancel address a run by, so a job list can't drift onto the wrong row. */
const gitlabJobs = (base: number, failing: boolean): PipelineJob[] => [
    { name: `lint`, status: `success`, stage: `build`, startedAt: base, finishedAt: base + 41_000, durationSeconds: 41 },
    { name: `build`, status: `success`, stage: `build`, startedAt: base, finishedAt: base + 96_000, durationSeconds: 96 },
    { name: `test:unit`, status: `success`, stage: `test`, startedAt: base + 100_000, finishedAt: base + 214_000, durationSeconds: 114 },
    {
        name: `test:integration`,
        status: failing ? `failed` : `success`,
        stage: `test`,
        startedAt: base + 100_000,
        finishedAt: base + 412_000,
        durationSeconds: 312,
        webUrl: `https://gitlab.com/acme/shop-api/-/jobs/771204`,
    },
    { name: `deploy:staging`, status: failing ? `skipped` : `success`, stage: `deploy`, startedAt: base + 420_000, durationSeconds: 62 },
];

/* A workflow that BRANCHES, because a straight line is the one shape the job graph cannot teach anything with.
 * `needs` is what the daemon resolves out of the real workflow file (sandbox: ci/workflowGraph.ts) and it is
 * what the graph is drawn from — fan-out from install, a matrix of e2e legs, and a deploy that waits on all of
 * them. The timestamps deliberately do NOT tell the same story: the legs here start one after another, so the
 * old wave layering would still render this as a queue. It branches because the workflow says so. */
const githubJobs = (base: number, failing: boolean): PipelineJob[] => [
    { name: `install`, status: `success`, needs: [], startedAt: base, finishedAt: base + 31_000, durationSeconds: 31 },
    { name: `typecheck`, status: `success`, needs: [`install`], startedAt: base + 33_000, finishedAt: base + 107_000, durationSeconds: 74 },
    { name: `lint`, status: `success`, needs: [`install`], startedAt: base + 34_000, finishedAt: base + 75_000, durationSeconds: 41 },
    { name: `unit`, status: `success`, needs: [`install`], startedAt: base + 35_000, finishedAt: base + 154_000, durationSeconds: 119 },
    { name: `build`, status: `success`, needs: [`typecheck`, `lint`], startedAt: base + 110_000, finishedAt: base + 222_000, durationSeconds: 112 },
    {
        name: `e2e (chromium)`,
        status: failing ? `failed` : `success`,
        needs: [`build`],
        startedAt: base + 225_000,
        finishedAt: base + 368_000,
        durationSeconds: 143,
        webUrl: `https://github.com/acme/shop-web/actions/runs/4820/job/12907`,
    },
    { name: `e2e (firefox)`, status: `success`, needs: [`build`], startedAt: base + 226_000, finishedAt: base + 355_000, durationSeconds: 129 },
    { name: `bundle-size`, status: `success`, needs: [`build`], startedAt: base + 227_000, finishedAt: base + 275_000, durationSeconds: 48 },
    // The whole point of the fan-in: one red leg and the deploy never happens.
    {
        name: `deploy preview`,
        status: failing ? `skipped` : `success`,
        needs: [`e2e (chromium)`, `e2e (firefox)`, `bundle-size`, `unit`],
        startedAt: failing ? undefined : base + 370_000,
        finishedAt: failing ? undefined : base + 432_000,
        durationSeconds: failing ? undefined : 62,
    },
];

/* A run still going has its jobs mid-flight, which is the one case the row's graph animates — and the one
 * where a declared graph earns its keep twice over, since the jobs that have not started yet have no
 * timestamps to be layered by at all. `deploy preview` is placed by what it waits on, not by when it ran. */
const runningJobs = (base: number): PipelineJob[] => [
    { name: `install`, status: `success`, needs: [], startedAt: base, finishedAt: base + 29_000, durationSeconds: 29 },
    { name: `typecheck`, status: `success`, needs: [`install`], startedAt: base + 31_000, finishedAt: base + 99_000, durationSeconds: 68 },
    { name: `lint`, status: `success`, needs: [`install`], startedAt: base + 32_000, finishedAt: base + 70_000, durationSeconds: 38 },
    { name: `unit`, status: `success`, needs: [`install`], startedAt: base + 33_000, finishedAt: base + 145_000, durationSeconds: 112 },
    { name: `build`, status: `success`, needs: [`typecheck`, `lint`], startedAt: base + 102_000, finishedAt: base + 210_000, durationSeconds: 108 },
    { name: `e2e (chromium)`, status: `running`, needs: [`build`], startedAt: base + 213_000 },
    { name: `e2e (firefox)`, status: `running`, needs: [`build`], startedAt: base + 214_000 },
    { name: `bundle-size`, status: `running`, needs: [`build`], startedAt: base + 215_000 },
    { name: `deploy preview`, status: `running`, needs: [`e2e (chromium)`, `e2e (firefox)`, `bundle-size`, `unit`] },
];

export const ciJobs = (repo: string, runId: number, now: number): PipelineJob[] => {
    const run = ciRuns(now).find((candidate) => candidate.repo === repo && candidate.runId === runId);
    if (run === undefined) {
        return [];
    }
    if (run.status === `running`) {
        return runningJobs(run.createdAt);
    }
    const failing = run.status === `failed`;
    return run.host === `gitlab` ? gitlabJobs(run.createdAt, failing) : githubJobs(run.createdAt, failing);
};

// When the owner last read the board. Older than the failure above, so the rail badge that brought them
// here is telling the truth — and `POST /ci/seen` clears it, exactly as it does against a real daemon.
export const ciRunsResponse = (now: number, seenAt: number | undefined): CiRunsResponse => ({
    repos: CI_REPOS,
    runs: ciRuns(now),
    ...(seenAt === undefined ? {} : { seenAt }),
});
