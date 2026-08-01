import type { CiRepo, CiRunsResponse, PipelineJob, PipelineRun } from "@intentic/sandbox-contract";

/* THE PIPELINES BOARD: acme-shop's two repos on two different hosts, because that is the fact the view exists
 * to flatten — `web` on GitHub, `api` on GitLab, one board, one vocabulary. A visitor who runs both sees their
 * own situation; one who runs either sees theirs.
 *
 * The runs are a plausible afternoon rather than a demonstration of green: the newest is still going, the one
 * before it broke, and the same e2e job broke two runs ago as well — which is what makes the view's
 * "keeps breaking" analysis (useFailureHistory) say something instead of being an empty affordance.
 *
 * Two shapes of job list, deliberately. GitLab reports a `stage` per job, so the api runs carry stages and the
 * row draws its circles from them; GitHub's jobs API has none, so the web runs carry only timestamps and the
 * view layers them into waves from overlapping runtimes. Both paths therefore render from this one fixture. */

const minutes = (count: number): number => count * 60_000;

export const CI_REPOS: CiRepo[] = [
    { repo: `web`, host: `github`, project: `acme/shop-web`, url: `https://github.com/acme/shop-web` },
    { repo: `api`, host: `gitlab`, project: `acme/shop-api`, url: `https://gitlab.com/acme/shop-api` },
];

export const ciRuns = (now: number): PipelineRun[] => [
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
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_820,
        title: `Fix the flaky signup e2e test`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `agent/flaky-signup`,
        sha: `19a7e55`,
        status: `failed`,
        url: `https://github.com/acme/shop-web/actions/runs/4820`,
        createdAt: now - minutes(48),
        durationSeconds: 268,
        failedJobs: [`e2e (chromium)`],
    },
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_819,
        title: `Fix the flaky signup e2e test`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `agent/flaky-signup`,
        sha: `0c33d81`,
        status: `failed`,
        url: `https://github.com/acme/shop-web/actions/runs/4819`,
        createdAt: now - minutes(96),
        durationSeconds: 254,
        failedJobs: [`e2e (chromium)`],
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
        status: `canceled`,
        url: `https://gitlab.com/acme/shop-api/-/pipelines/90301`,
        createdAt: now - minutes(410),
        durationSeconds: 44,
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

const githubJobs = (base: number, failing: boolean): PipelineJob[] => [
    { name: `typecheck`, status: `success`, startedAt: base, finishedAt: base + 74_000, durationSeconds: 74 },
    { name: `unit`, status: `success`, startedAt: base + 2_000, finishedAt: base + 121_000, durationSeconds: 119 },
    {
        name: `e2e (chromium)`,
        status: failing ? `failed` : `success`,
        startedAt: base + 125_000,
        finishedAt: base + 268_000,
        durationSeconds: 143,
        webUrl: `https://github.com/acme/shop-web/actions/runs/4820/job/12907`,
    },
    { name: `bundle-size`, status: failing ? `skipped` : `success`, startedAt: base + 125_000, finishedAt: base + 173_000, durationSeconds: 48 },
];

/* A run still going has its jobs mid-flight, which is the one case the row's graph animates. */
const runningJobs = (base: number): PipelineJob[] => [
    { name: `typecheck`, status: `success`, startedAt: base, finishedAt: base + 68_000, durationSeconds: 68 },
    { name: `unit`, status: `success`, startedAt: base + 2_000, finishedAt: base + 112_000, durationSeconds: 110 },
    { name: `e2e (chromium)`, status: `running`, startedAt: base + 115_000 },
    { name: `bundle-size`, status: `running`, startedAt: base + 115_000 },
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

// When the owner last read the board. Older than the two failures above, so the rail badge that brought them
// here is telling the truth — and `POST /ci/seen` clears it, exactly as it does against a real daemon.
export const ciRunsResponse = (now: number, seenAt: number | undefined): CiRunsResponse => ({
    repos: CI_REPOS,
    runs: ciRuns(now),
    ...(seenAt === undefined ? {} : { seenAt }),
});
