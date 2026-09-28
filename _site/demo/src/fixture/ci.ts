import type { CiMainFailure, CiRepo, CiRunsResponse, PipelineJob, PipelineRun } from "@intentic/sandbox-contract";
import { API_MAIN_FIXER_ID, WEB_MAIN_FIXER_ID } from "./fleet";

// acme-shop's two repos on two hosts (web/GitHub, api/GitLab) as one board. Runs are a healthy afternoon: one running,
// five passing, one mixed failure (`test:integration` failed, deploy skipped). The whole recording adds main failing on
// both (MAIN FAILING below). GitLab jobs carry a `stage`; GitHub's don't, so the view layers them by `needs`.

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
    // The only failed run on the board.
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

// MAIN FAILING, in the whole recording only, since its two fix agents are on no other roster. The release notes' push
// failed `web`'s main at its unit job, and the sandbox put one fix agent on it there and then (ci/main-fixer.ts); the
// next push to main failed too, and went to the same agent, which is working on both. On `api`, main has been failing
// test:integration for most of an hour: its fix agent read the logs, found the failure outside the code and finished
// without changing anything, so it waits for you.
const mainFailureRuns = (now: number): PipelineRun[] => [
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_822,
        title: `Tighten the changelog page copy`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `main`,
        sha: `e7d41c2`,
        status: `failed`,
        url: `https://github.com/acme/shop-web/actions/runs/4822`,
        createdAt: now - minutes(9),
        durationSeconds: 214,
        failedJobs: [`typecheck`, `unit`],
    },
    {
        repo: `web`,
        host: `github`,
        project: `acme/shop-web`,
        runId: 4_818,
        title: `Draft the release notes for 2.4`,
        authorName: `Ada Lovelace`,
        trigger: `push`,
        branch: `main`,
        sha: `9d20f6b`,
        status: `failed`,
        url: `https://github.com/acme/shop-web/actions/runs/4818`,
        createdAt: now - minutes(34),
        durationSeconds: 163,
        failedJobs: [`unit`],
    },
    {
        repo: `api`,
        host: `gitlab`,
        project: `acme/shop-api`,
        runId: 90_314,
        title: `Bump the Stripe SDK to 17`,
        authorName: `Grace Hopper`,
        trigger: `push`,
        branch: `main`,
        sha: `b3e9a07`,
        status: `failed`,
        url: `https://gitlab.com/acme/shop-api/-/pipelines/90314`,
        createdAt: now - minutes(58),
        durationSeconds: 431,
        failedJobs: [`test:integration`],
    },
];

const mainFailures = (now: number): CiMainFailure[] => [
    {
        repo: `web`,
        branch: `main`,
        since: now - minutes(32),
        runId: 4_822,
        jobs: [`typecheck`, `unit`],
        fixer: WEB_MAIN_FIXER_ID,
        decision: {
            kind: `fix-up`,
            conversationId: WEB_MAIN_FIXER_ID,
            at: now - minutes(32),
            detail: `Its first failed job, unit, put a fix agent on it; every later failure goes to the same one.`,
        },
    },
    {
        repo: `api`,
        branch: `main`,
        since: now - minutes(51),
        runId: 90_314,
        jobs: [`test:integration`],
        fixer: API_MAIN_FIXER_ID,
        decision: {
            kind: `spent`,
            reason: `no-change`,
            conversationId: API_MAIN_FIXER_ID,
            at: now - minutes(19),
            detail: `Its fix agent finished without changing anything.`,
        },
    },
];

// Every run the fixture has, whichever recording lists it: a row asks for its jobs by id, and only lists what it drew.
const allRuns = (now: number): PipelineRun[] => [...ciRuns(now), ...mainFailureRuns(now)];

// Both forges give every job its own page, so the fixture mints one per job rather than only for the interesting ones:
// the graph draws each job name as a link out, and a fixture without them would under-draw the view.
const withJobPages = (page: (index: number) => string, jobs: PipelineJob[]): PipelineJob[] =>
    jobs.map((job, index) => ({ ...job, webUrl: page(index) }));

// Both forges give every job its own page: the job graph draws each name as a link out to it.
const gitlabJobPage = (index: number): string => `https://gitlab.com/acme/shop-api/-/jobs/${771_204 + index}`;
const githubJobPage = (runId: number, index: number): string => `https://github.com/acme/shop-web/actions/runs/${runId}/job/${12_907 + index}`;

// One job as the pipeline declares it: when it starts after the run does and how long it takes, in seconds.
interface JobSpec {
    readonly name: string;
    readonly at: number;
    readonly took: number;
}

// A job that ran: its verdict and its clock, from the run's own start.
const ran = (base: number, spec: JobSpec, failed: readonly string[]): PipelineJob => ({
    name: spec.name,
    status: failed.includes(spec.name) ? `failed` : `success`,
    startedAt: base + spec.at * 1000,
    finishedAt: base + (spec.at + spec.took) * 1000,
    durationSeconds: spec.took,
});

// One run's jobs, fetched when a row expands; keyed by repo + the vendor's run id, same pair rerun/cancel use. GitLab
// runs stage by stage, so a stage after a failed one never starts.
const GITLAB_STAGES = [`build`, `test`, `deploy`] as const;
const GITLAB_JOBS: readonly (JobSpec & { readonly stage: (typeof GITLAB_STAGES)[number] })[] = [
    { name: `lint`, stage: `build`, at: 0, took: 41 },
    { name: `build`, stage: `build`, at: 0, took: 96 },
    { name: `test:unit`, stage: `test`, at: 100, took: 114 },
    { name: `test:integration`, stage: `test`, at: 100, took: 312 },
    { name: `deploy:staging`, stage: `deploy`, at: 420, took: 62 },
];
const gitlabJobs = (base: number, failed: readonly string[]): PipelineJob[] => {
    const broke = Math.min(...GITLAB_JOBS.filter((spec) => failed.includes(spec.name)).map((spec) => GITLAB_STAGES.indexOf(spec.stage)));
    return withJobPages(
        gitlabJobPage,
        GITLAB_JOBS.map((spec) =>
            GITLAB_STAGES.indexOf(spec.stage) > broke
                ? { name: spec.name, status: `skipped`, stage: spec.stage }
                : { ...ran(base, spec, failed), stage: spec.stage },
        ),
    );
};

// Branching workflow: install fans out, e2e is a matrix, deploy waits on all of them, drawn from `needs`. Timestamps
// run one after another on purpose, so the graph must use `needs`, not wave-layering, to render right. A job waiting
// on one that failed, or on one that never ran, is skipped with no clock of its own.
const GITHUB_JOBS: readonly (JobSpec & { readonly needs: readonly string[] })[] = [
    { name: `install`, needs: [], at: 0, took: 31 },
    { name: `typecheck`, needs: [`install`], at: 33, took: 74 },
    { name: `lint`, needs: [`install`], at: 34, took: 41 },
    { name: `unit`, needs: [`install`], at: 35, took: 119 },
    { name: `build`, needs: [`typecheck`, `lint`], at: 110, took: 112 },
    { name: `e2e (chromium)`, needs: [`build`], at: 225, took: 143 },
    { name: `e2e (firefox)`, needs: [`build`], at: 226, took: 129 },
    { name: `bundle-size`, needs: [`build`], at: 227, took: 48 },
    // Fan-in: a single failing leg means the deploy step never runs.
    { name: `deploy preview`, needs: [`e2e (chromium)`, `e2e (firefox)`, `bundle-size`, `unit`], at: 370, took: 62 },
];
const githubJobs = (base: number, failed: readonly string[], runId: number): PipelineJob[] => {
    const stopped = new Set<string>();
    return withJobPages(
        (index) => githubJobPage(runId, index),
        GITHUB_JOBS.map((spec) => {
            if (spec.needs.some((need) => stopped.has(need))) {
                stopped.add(spec.name);
                return { name: spec.name, status: `skipped`, needs: [...spec.needs] };
            }
            if (failed.includes(spec.name)) {
                stopped.add(spec.name);
            }
            return { ...ran(base, spec, failed), needs: [...spec.needs] };
        }),
    );
};

// Jobs mid-flight for a running run; not-yet-started jobs have no timestamps to layer by, so the graph needs `needs`
// here too. `deploy preview` is placed by what it waits on, not when it ran.
const runningJobs = (base: number, runId: number): PipelineJob[] =>
    withJobPages(
        (index) => githubJobPage(runId, index),
        [
            { name: `install`, status: `success`, needs: [], startedAt: base, finishedAt: base + 29_000, durationSeconds: 29 },
            { name: `typecheck`, status: `success`, needs: [`install`], startedAt: base + 31_000, finishedAt: base + 99_000, durationSeconds: 68 },
            { name: `lint`, status: `success`, needs: [`install`], startedAt: base + 32_000, finishedAt: base + 70_000, durationSeconds: 38 },
            { name: `unit`, status: `success`, needs: [`install`], startedAt: base + 33_000, finishedAt: base + 145_000, durationSeconds: 112 },
            {
                name: `build`,
                status: `success`,
                needs: [`typecheck`, `lint`],
                startedAt: base + 102_000,
                finishedAt: base + 210_000,
                durationSeconds: 108,
            },
            { name: `e2e (chromium)`, status: `running`, needs: [`build`], startedAt: base + 213_000 },
            { name: `e2e (firefox)`, status: `running`, needs: [`build`], startedAt: base + 214_000 },
            { name: `bundle-size`, status: `running`, needs: [`build`], startedAt: base + 215_000 },
            // queued, not running: a spinner here would wrongly suggest deploy started before its legs finished.
            { name: `deploy preview`, status: `queued`, needs: [`e2e (chromium)`, `e2e (firefox)`, `bundle-size`, `unit`] },
        ],
    );

export const ciJobs = (repo: string, runId: number, now: number): PipelineJob[] => {
    const run = allRuns(now).find((candidate) => candidate.repo === repo && candidate.runId === runId);
    if (run === undefined) {
        return [];
    }
    if (run.status === `running`) {
        return runningJobs(run.createdAt, run.runId);
    }
    const failed = run.failedJobs ?? [];
    return run.host === `gitlab` ? gitlabJobs(run.createdAt, failed) : githubJobs(run.createdAt, failed, run.runId);
};

// The feature branch's failure is the newest run on its branch, so the rail badge stays lit truthfully. `failures` as a
// current daemon always sends it, empty or not; only the whole recording's main is failing.
export const ciRunsResponse = (now: number, mainFailing = false): CiRunsResponse => ({
    repos: CI_REPOS,
    runs: mainFailing ? [...ciRuns(now), ...mainFailureRuns(now)].toSorted((left, right) => right.createdAt - left.createdAt) : ciRuns(now),
    failures: mainFailing ? mainFailures(now) : [],
});
