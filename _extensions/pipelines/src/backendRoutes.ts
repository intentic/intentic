// The routes this extension's backend answers (src/server/board.ts), named once for both halves. Each answer is a shape of
// the wire contract's `schemas/ci`, which the extension API versions, so a newer browser half reads an older backend's
// answer and the other way round. Until 2026-11-26 the daemon answered each of these itself (`GET /ci/runs` with main's
// failures, `POST /ci/runs/jobs` with the graph drawn, `POST /ci/failures/forget`, `POST /ci/fix`), which a daemon older
// than this backend still does (backendRead.ts).

// GET runs: what the forges report, with main's failures and the steps fix agents ended on (`CiRunsResponse`).
export const RUNS_ROUTE = `runs`;
// POST jobs { repo, runId }: one run's jobs with their graph drawn from its workflow file (`CiJobsResponse`).
export const JOBS_ROUTE = `jobs`;
// POST forget { repo, branch, workflow? }: a workflow, or the whole failure, taken off a failing main line (`{ ok }`).
export const FORGET_ROUTE = `forget`;
// POST fix (`CiFixParam`): an agent put on a failed run, as whoever pressed (`CiFixResponse`).
export const FIX_ROUTE = `fix`;

// What a daemon from before the backend answers the same at, for the way back (backendCall.ts): the two it took off its
// contract. The runs and a run's jobs are still the contract's, reached through its typed client.
export const LEGACY = {
    forget: `/ci/failures/forget`,
    fix: `/ci/fix`,
} as const;
