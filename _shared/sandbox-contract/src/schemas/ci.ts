// ci: pipeline runs on the workspace repos' github/gitlab remotes
import { isInfraStep } from "@intentic/constants/ci-infra-steps";
import { z } from "zod";
import { AgentRunPickSchema } from "./agent.js";

// Split out to keep this module one reading (2026-11-26), served from this subpath as before.
export * from "./ci-deployments.js";
export * from "./command-run.js";
// The daemon maps each workspace repo to its CI project via a connected github/gitlab capability, registers a webhook
// to fire `ci` listener automations instantly, and serves the Pipelines rail from a webhook-freshened, poll-backfilled
// cache. `host` names which provider API serves a repo; the listener provider is always `ci`, since a trigger narrows
// by repo, not by vendor.

export const CiHostSchema = z.enum(["github", "gitlab"]);
export type CiHost = z.infer<typeof CiHostSchema>;
// Both vendors' vocabularies collapsed onto six states. `queued` is its own state, not a flavor of `running`: a job
// waiting on an offline runner must read as "go look at your runners", not as work in progress with a ticking duration.
export const PipelineStatusSchema = z.enum(["queued", "running", "success", "failed", "canceled", "skipped"]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;
// Whether a run has said anything yet, against the three ways it can stop; shared here since the daemon (for duration
// math) and the board (in-flight count, Cancel button, verdict walk) must split the same way.
export const isPipelineInFlight = (status: PipelineStatus): boolean => status === "queued" || status === "running";
export const PipelineRunSchema = z.object({
    // The workspace repo dir (the panels `repo` convention), the join key back to the tree and to triggers.
    repo: z.string().describe("Which workspace repository it belongs to."),
    host: CiHostSchema.describe("Which forge is running it."),
    // owner/name (github) or the full project path (gitlab).
    project: z.string().describe("The project there, as that forge names it."),
    // The vendor's numeric run/pipeline id, what rerun/cancel address.
    runId: z.number().describe("The forge's own id for the run, which is what re-running and cancelling take."),
    // github's display_title (commit subject, or PR title); gitlab's pipeline name or head commit subject.
    title: z
        .string()
        .optional()
        .describe("The run's headline, usually the commit subject or the pull request's title. Absent means falling back to the branch and commit."),
    // The actor the vendor credits, matching what its own UI shows; the avatar is vendor-hosted.
    authorName: z.string().optional().describe("Who the forge credits for setting it off."),
    authorAvatarUrl: z.string().optional().describe("Their picture, hosted by the forge. Absent means drawing their initials instead."),
    // What set it off, in the vendor's own word (gitlab's `source`, github's `event`), left raw rather than flattened
    // into a shared enum.
    trigger: z
        .string()
        .optional()
        .describe(
            "What set it off, in the forge's own word rather than flattened into a shared vocabulary, because the forge's word is the precise one.",
        ),
    // github's workflow name: several workflows run on one push there, and one passing says nothing of another. Absent on
    // gitlab, where a commit's pipeline is the project's one.
    workflow: z.string().optional().describe("Which workflow it is a run of, where a push starts several. Absent where a commit has one pipeline."),
    branch: z.string().describe("Which branch."),
    sha: z.string().describe("Which commit."),
    status: PipelineStatusSchema.describe(
        "How it is going. Queued means the forge has accepted it and nothing is executing it yet, which is a different thing to wait on than a run actually in progress.",
    ),
    // The vendor's run page, the deep link out.
    url: z.string().describe("Its page on the forge."),
    createdAt: z.number().describe("When it started, in milliseconds."),
    durationSeconds: z.number().optional().describe("How long it took."),
    // Names of the failed jobs, fetched only for failed runs (one extra call), so a wake or a view names what broke.
    failedJobs: z
        .array(z.string())
        .optional()
        .describe(
            "What broke, by name. Fetched only for failed runs, so that a notification or a screen can say what went wrong rather than just that something did.",
        ),
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;
// Jobs fetched lazily per visible run so the list endpoint stays cheap; both vendors normalize onto these fields. Run
// shape is read in descending order of truth: `needs` (the real declared graph), then `stage` (gitlab's own grouping),
// then overlapping timestamps as a last resort. A `queued` job carries neither timestamp, an invariant the normalizers
// enforce since github reports a fake `started_at` on a job that hasn't started.
export const PipelineJobSchema = z.object({
    name: z.string().describe("The job's name."),
    status: PipelineStatusSchema.describe("How it went."),
    stage: z.string().optional().describe("Which stage it belongs to, where the pipeline groups its jobs that way."),
    // Absent means nothing could be resolved (fall back); an empty array is the different claim that this job is a
    // root.
    needs: z
        .array(z.string())
        .optional()
        .describe(
            "Which jobs in this run it declared it waits on: the real shape of the pipeline. Absent means nothing could be read, which is different from an empty list, which is the claim that it waits on nothing.",
        ),
    declaredId: z
        .string()
        .optional()
        .describe(
            "The job's id in its workflow file, with a called workflow's job under its caller as `caller.job`. Present where the workflow could be read; it is what the forge orders its own drawing of the run by.",
        ),
    matrix: z
        .string()
        .optional()
        .describe("The matrix job this is one leg of, by that job's name. Legs of one matrix are drawn together, apart from every other job."),
    startedAt: z.number().optional().describe("When it began, in milliseconds. Absent while it is queued."),
    finishedAt: z.number().optional().describe("When it ended, in milliseconds."),
    durationSeconds: z.number().optional().describe("How long it took."),
    // The job's page on its host, the shortest path from "this step failed" to the log that says why.
    webUrl: z.string().optional().describe("Its page on the forge, which is the shortest path from this step failed to the log that says why."),
});
export type PipelineJob = z.infer<typeof PipelineJobSchema>;
export const CiJobsResponseSchema = z.object({
    jobs: z.array(PipelineJobSchema).describe("The steps inside one run. Fetched separately from the run list, so that list stays cheap."),
});
export type CiJobsResponse = z.infer<typeof CiJobsResponseSchema>;
// One mapped repo's CI wiring: `hookWarning` explains why webhook registration was refused or impossible, visible to
// everyone. `hookRecipe` is the URL and secret to paste manually, shown to a maintainer or owner only, since the secret
// signs every delivery this sandbox trusts.
export const CiRepoSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    host: CiHostSchema.describe("Which forge it lives on."),
    project: z.string().describe("The project there."),
    // The project's home page on its host.
    url: z.string().describe("Its page on the forge."),
    hookWarning: z
        .string()
        .optional()
        .describe(
            "Present when the sandbox could not register for instant notifications, with what happened. Without them the sandbox polls instead, so this costs a couple of minutes' delay rather than the feature.",
        ),
    hookRecipe: z
        .string()
        .optional()
        .describe("What to paste into the repository's webhook settings by hand, secret included. Shown to a maintainer or the owner only."),
});
export type CiRepo = z.infer<typeof CiRepoSchema>;
// Fallback poll interval when a repo's webhook couldn't register; lives here since both the poller and the automation
// editor need it to tell the owner what a `hookWarning` actually costs (minutes' delay, not the feature).
export const CI_POLL_INTERVAL_MS = 2 * 60_000;
// What was decided about a main-line branch while its CI fails, in the order it was decided (ci/main-fixer.ts).
export const MainFailureDecisionKindSchema = z.enum([
    // Its one fix agent was put on it: by the sandbox with the first run that failed, or by a person's Fix press, which
    // gives the agent its turns back.
    "fix-up",
    // Nobody was sent: repairs are switched off, or nothing could take it.
    "reported",
    // The fix agent had its turns, or stopped without a fix: it waits for a person.
    "spent",
]);
export type MainFailureDecisionKind = z.infer<typeof MainFailureDecisionKindSchema>;

// Why the fix agent handed the failure back (a `spent` decision), as a closed set the editor words for itself, so what a
// reader sees stays a few words in every language rather than whatever the turn's error happened to say.
export const MainFailureHandBackSchema = z.enum([
    // It had every turn the sandbox gives one failure, and main still fails.
    "turns",
    // Its turn ended without changing anything, so the failure is likely not in the code.
    "no-change",
    // A person stopped it.
    "stopped",
    // Its turn was cut off.
    "interrupted",
    // Its turn failed.
    "turn-failed",
    // Its conversation is gone or archived.
    "gone",
    // It could not be told about the newest failure.
    "refused",
]);
export type MainFailureHandBack = z.infer<typeof MainFailureHandBackSchema>;

export const MainFailureDecisionSchema = z.object({
    kind: MainFailureDecisionKindSchema.describe("What was decided."),
    reason: MainFailureHandBackSchema.optional().describe("Why the fix agent handed it back, on a `spent` decision."),
    conversationId: z.string().optional().describe("The conversation working on it, when one is."),
    at: z.number().describe("When that was decided, in milliseconds."),
    detail: z.string().optional().describe("One short sentence on why, in the sandbox's words."),
});
export type MainFailureDecision = z.infer<typeof MainFailureDecisionSchema>;

// A main-line branch while its CI fails, as the daemon's one fix agent on it sees it (ci/main-fixer.ts): from the first
// job that failed until a later run of every workflow that failed on it passes, whatever else failed along the way.
// One workflow failing on a main-line branch, where a push starts several (GitHub): a later run of it passing takes it
// off the failure, so a pass of any other says nothing of it. A scheduled one (a nightly) is the case that needs
// spelling out: a push does not run it, and the board's own runs may all pass while it still fails.
export const CiMainFailureWorkflowSchema = z.object({
    name: z.string().describe("The workflow, by the name the forge gives it. `ci` on a forge that runs one pipeline per commit."),
    runId: z.number().describe("Its newest run that failed."),
    jobs: z.array(z.string()).describe("Its jobs failing now, by name."),
    since: z
        .number()
        .optional()
        .describe(
            "When this workflow began failing on the branch, in milliseconds: each workflow keeps its own, so one failing for weeks does not make another's breakage look as old. Absent for a failure kept before workflows were timed apart.",
        ),
    failedAt: z
        .number()
        .optional()
        .describe(
            "When its newest run failed, in milliseconds. A workflow that has not failed for MAIN_FAILURE_STALE_MS, and has not passed either, is taken off the failure by itself.",
        ),
    trigger: z
        .string()
        .optional()
        .describe(
            "What set its newest failed run off, in the forge's own word (`push`, `schedule`, …), where it is known: a scheduled workflow is measured by its next scheduled run, or one started by hand, and never by a push.",
        ),
    timedOut: z
        .array(z.string())
        .optional()
        .describe(
            "Those of its failing jobs that failed by running out of time, which the forge reports as cancelled rather than failed. Absent when none did.",
        ),
});
export type CiMainFailureWorkflow = z.infer<typeof CiMainFailureWorkflowSchema>;
export const CiMainFailureSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    branch: z.string().describe("Which main-line branch."),
    since: z.number().describe("When its first job failed, in milliseconds."),
    runId: z.number().describe("The newest run that failed on it."),
    jobs: z.array(z.string()).describe("The jobs failing on it now, by name: the newest failed run's failures, and any that failed since."),
    workflows: z
        .array(CiMainFailureWorkflowSchema)
        .optional()
        .describe(
            "Each workflow failing on it, in the order they began failing, with its newest failed run and its jobs: the branch passes again only once a later run of every one of them passes. Absent from a daemon from before workflows were told apart.",
        ),
    fixer: z
        .string()
        .optional()
        .describe("The one conversation working on it, which every failure goes to until the branch passes. Absent while nobody is on it."),
    decision: MainFailureDecisionSchema.optional().describe(
        "The latest thing decided about it: `fix-up` while the fix agent has it, `spent` once it waits for you (its turns are used up, or it stopped without a fix), `reported` when repairs are off.",
    ),
    attempts: z
        .number()
        .optional()
        .describe(
            "How many fix attempts have been opened on it so far. A failure on its tenth attempt is stuck in a way no single attempt says. Absent from a daemon that does not count them.",
        ),
});
export type CiMainFailure = z.infer<typeof CiMainFailureSchema>;
// How long a workflow failing on a main-line branch stays on the failure without failing again or passing: its newest
// failed run is then weeks old, so nothing is measuring it (a one-off run, a workflow renamed or no longer scheduled),
// and holding the failure open on it only hides the branch's real state.
export const MAIN_FAILURE_STALE_MS = 14 * 24 * 60 * 60_000;
// Takes a workflow off a failing main-line branch by hand, or the whole failure when no workflow is named: what a person
// does when they know better than the forge (the workflow was deleted, or what fails is not the code's to fix).
export const CiForgetParamSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    branch: z.string().describe("Which main-line branch."),
    workflow: z
        .string()
        .optional()
        .describe("The workflow to stop tracking, by the name the failure lists it under. Leave it out to end the whole failure, every workflow on it."),
});
export type CiForgetParam = z.infer<typeof CiForgetParamSchema>;
// A step only a person can take, outside the repository, that a CI fix agent ended its turn on: a field in a store's
// dashboard, a secret's value, an account setting. No commit fixes such a failure, so the board shows the step on the
// failed run instead of reading the agent's turn as a fix (ci/owner-steps.ts).
export const CI_OWNER_STEP_MARK = "Owner step:";
export const CiOwnerStepSchema = z.object({
    conversationId: z.string().describe("The fix agent that said it: which run's failure it answers is in its id."),
    step: z.string().describe("What the owner has to do, and where, in the agent's own words."),
    at: z.number().describe("When the turn that said it ended, in milliseconds."),
});
export type CiOwnerStep = z.infer<typeof CiOwnerStepSchema>;
export const CiRunsResponseSchema = z.object({
    repos: z.array(CiRepoSchema).describe("Which workspace repositories are wired to a forge, and how each one's notifications are set up."),
    // Newest first, across all mapped repos.
    runs: z.array(PipelineRunSchema).describe("Runs across all of them, newest first."),
    // (2026-11-26) Filled by the pipelines extension's backend, whose board read answers this same shape; the daemon's own
    // GET /ci/runs leaves both out since main's fix agent moved there, and an older daemon fills them itself.
    failures: z
        .array(CiMainFailureSchema)
        .optional()
        .describe("Every main-line branch failing right now, with the fix agent on it. Absent where nothing keeps them."),
    ownerSteps: z
        .array(CiOwnerStepSchema)
        .optional()
        .describe("Steps outside the repository that CI fix agents ended their latest turn on, one per agent. Absent where nothing keeps them."),
});
export type CiRunsResponse = z.infer<typeof CiRunsResponseSchema>;
// 2026-11-17, the shinobi-society audit: conversation after conversation spent calls finding out whether a test that
// failed for it was its own or already failing on main (stashing its work, re-running main, comparing), while the daemon
// had already read every failed main-line job's log. `GET /ci/main` (`agents ci`) answers from what it heard, asking no
// forge: each job failing on a main line, the run and commit it last failed in, when that was read, and what its log
// named. A main line nothing is known of says so, so silence never reads as a passing main.
export const CiMainJobSchema = z.object({
    workflow: z.string().describe("The workflow it is a job of, by the forge's name. `ci` on a forge that runs one pipeline per commit."),
    job: z.string().describe("The job, by name."),
    runId: z.number().optional().describe("The run it last failed in. Absent for a failure heard before the daemon kept it."),
    sha: z.string().optional().describe("That run's commit, where the forge said."),
    readAt: z.number().optional().describe("When the daemon read that failure, in milliseconds."),
    errors: z
        .array(z.string())
        .optional()
        .describe(
            "What its failed steps printed, one line each and bounded: failing tests by name (`(fail) …`, `test … FAILED`), type and lint errors, failed checks, and how a task ended (a signal's exit code, a heap run out). Empty when its log named nothing of the kind; absent when the log was not read.",
        ),
    timedOut: z.boolean().optional().describe("Whether it failed by running out of time. Absent when it did not."),
});
export type CiMainJob = z.infer<typeof CiMainJobSchema>;
export const CiMainBranchSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    branch: z.string().optional().describe("Its main line. Absent when neither the forge nor the clone named a default branch and no run of one was heard."),
    state: z
        .enum(["failing", "clear", "unread"])
        .describe(
            "`failing`: the jobs below fail on it now. `clear`: a finished run of it was heard and no job of main's own code is known to fail. `unread`: no finished run of it has been heard, so nothing is known.",
        ),
    since: z.number().optional().describe("When its first job failed, on a failing one, in milliseconds."),
    jobs: z.array(CiMainJobSchema).describe("The jobs failing on it now, in the order they began failing. Empty unless it is failing."),
    lastRun: z
        .object({ status: z.enum(["success", "failed"]), at: z.number() })
        .optional()
        .describe("The newest finished run of it the daemon heard, any workflow: how it ended and when it was heard. Absent when none was."),
    fixer: z.string().optional().describe("The fix agent on its failure, when one is."),
});
export type CiMainBranch = z.infer<typeof CiMainBranchSchema>;
// 2026-11-19, the shinobi-society audit: `agents ci` said "nothing known to fail" while sixteen tests failed on main,
// in suites CI does not run. The sandbox's own record of test runs (output-cleaners' test-outcomes.mjs) knows those: a
// run on a clean tree at a main commit is that commit's baseline.
export const CiLocalMainSchema = z.object({
    repo: z.string().describe("Which repository, by the name of its git directory."),
    sha: z.string().describe("The main commit, the newest one with a recorded run in this repository."),
    at: z.number().describe("When the newest run there ended, in milliseconds."),
    runs: z
        .array(
            z.object({
                command: z.string().describe("The command as the agent wrote it."),
                at: z.number().describe("When it ended, in milliseconds."),
                by: z.string().optional().describe("The conversation that ran it, where known."),
                failed: z.number().describe("How many tests it counted failing."),
                passed: z.number().describe("How many it counted passing."),
            }),
        )
        .describe("Every recorded run at that commit, newest first."),
    failed: z
        .array(
            z.object({
                test: z.string().describe("The test, by the id the digest names it with: `crate name`, `file > name`, a node id."),
                line: z.string().optional().describe("The first line of why it failed, where the output said."),
                at: z.number().describe("When the newest run that failed it ended, in milliseconds."),
            }),
        )
        .describe("Each test those runs failed. Empty when they failed none."),
});
export type CiLocalMain = z.infer<typeof CiLocalMainSchema>;
export const CiMainResponseSchema = z.object({
    text: z.string().describe("The whole answer in words, as `agents ci` prints it."),
    branches: z.array(CiMainBranchSchema).describe("Each repository wired to CI, and any main line still failing in one no longer wired."),
    local: z
        .array(CiLocalMainSchema)
        .optional()
        .describe(
            "What this sandbox's own test runs on clean trees at main commits saw fail, newest main commit per repository: suites CI does not run included. Absent from a daemon that keeps no such record.",
        ),
});
export type CiMainResponse = z.infer<typeof CiMainResponseSchema>;
// Re-resolves repo → project + token on every call, so a stale card can't act on a mapping the workspace no longer has.
export const CiRunParamSchema = z.object({
    repo: z
        .string()
        .describe(
            "Which workspace repository. The project behind it is resolved fresh each call, so a stale screen cannot act on one the workspace no longer maps to.",
        ),
    runId: z.number().describe("Which run, by the forge's own id."),
});
export type CiRunParam = z.infer<typeof CiRunParamSchema>;
// Which model to open the session on, when the user reached for the caret instead of pressing the button; absent is
// ordinary.
export const CiFixParamSchema = CiRunParamSchema.extend({
    pick: AgentRunPickSchema.describe(
        "Which model to open the conversation on, when somebody chose one. Leave it out for the sandbox's own choice, which is the ordinary path.",
    ),
    // The browser's own chat pick, which the daemon never holds: without it an unpinned fix opened on a provider the
    // owner never chose. Absent (an older app, or nobody pressed) keeps the sandbox's own fallback.
    fallback: AgentRunPickSchema.describe(
        "The model a new chat opens on for whoever pressed, for when nobody chose one and no model set for fixing pipelines can run. Used while this sandbox can serve its provider; left out, or not servable, the sandbox takes its default provider when connected, else the first one connected.",
    ),
    // The verb the picker's bar was ended with, when an attempt already exists (state/fix-attempt-plan.ts). Left out,
    // an ended attempt is continued and a fresh press opens attempt 1; one still in play answers CONFLICT.
    mode: z
        .enum(["continue", "start-over"])
        .optional()
        .describe(
            "What to do about the attempt already made at this run, when there is one. `continue` carries on in that conversation; `start-over` stops it if running, files it away, and opens the next attempt on a clean worktree. Leave it out for the plain press: an attempt that ended is continued, a fresh failure gets attempt 1, and one still in play answers CONFLICT with why.",
        ),
    force: z
        .boolean()
        .optional()
        .describe(
            "Open the conversation even when every failed job died in its runner's own setup, which is the fleet's fault and nothing an agent on the code can repair. Left out, such a run is refused with that sentence.",
        ),
    // The run button's booking (useAgentRunPick `booking`): the chosen model's allowance is spent, so the press schedules
    // the fix for its reopen instead of sending it into a refusal. AgentTurn's own two fields, read the same way.
    sendAt: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "Hold the fix until then (epoch milliseconds) instead of starting it now: the reopen of the allowance the chosen model would be refused by. The conversation opens at once with its task waiting in the queue, drawn as scheduled, and starts by itself then. Ignored when already past; at most a month ahead.",
        ),
    sendAtReopen: z
        .literal(true)
        .optional()
        .describe("Says `sendAt` is the reopen of a spent allowance rather than a time you chose, so every window says the fix waits on an allowance. Only with `sendAt`."),
});
export type CiFixParam = z.infer<typeof CiFixParamSchema>;
// The fix route opens an isolated conversation (fleet card + chat tab) seeded with the failure context.
export const CiFixResponseSchema = z.object({
    conversationId: z.string().describe("The conversation that was opened, already holding the failure. Open it to watch, or attach to its turn."),
});
export type CiFixResponse = z.infer<typeof CiFixResponseSchema>;

// ---- (2026-11-25) CI events for code: GET /ci/feed ------------------------------------------------------------------
// What the forges' webhooks (and the poller, for repositories without one) said, as it is heard, for a program rather
// than an agent: the Deployments extension's engine starts a deploy the moment the job that publishes images passes,
// not when the whole workflow ends. A Server-Sent Events stream of these frames, one `data:` line each; a reader that
// was away reads `/ci/runs` to catch up on runs (jobs it missed are gone, so a trigger should also accept the run).
// Reached by an extension that declares `GET /ci/feed` in its `permissions.daemon`; listener automations are not fed
// job frames, which are many.
// (2026-11-26) What the forge said of one failed job (`failed` on its `job` frame), for main's fix agent in the pipelines
// extension: the forge's id for it, which its log is read by (POST /ci/jobs/log), the step it failed in first and every
// step it failed in where the forge names steps, the forge's reason (GitLab's `failure_reason`; on GitHub, why a job it
// reports as cancelled failed after all: `timed_out` or `runner_unavailable`), what set its run off where the core knows,
// its check run annotations where they were read, and the runner that ran it.
export const CiJobFailureSchema = z.object({
    jobId: z.number(),
    step: z.string().optional(),
    steps: z.array(z.string()).optional(),
    reason: z.string().optional(),
    trigger: z.string().optional(),
    annotations: z.array(z.string()).optional(),
    runner: z.string().optional(),
});
export type CiJobFailure = z.infer<typeof CiJobFailureSchema>;
export const CiFeedEventSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("run"),
        run: PipelineRunSchema,
    }),
    z.object({
        kind: z.literal("job"),
        repo: z.string(),
        host: CiHostSchema,
        project: z.string(),
        runId: z.number(),
        workflow: z.string().optional(),
        job: z.string(),
        branch: z.string(),
        sha: z.string(),
        status: PipelineStatusSchema,
        url: z.string(),
        // (2026-11-26) Present on a job that failed, a job allowed to fail excepted: what the forge said of it.
        failed: CiJobFailureSchema.optional(),
    }),
]);
export type CiFeedEvent = z.infer<typeof CiFeedEventSchema>;


// (2026-11-26) Whether a CI job's step is one the runner owns rather than the repository (Set up job, Complete job, a Post
// step): a job that died in one never ran a line of the checkout, so an agent on the code can do nothing for it. The one
// list `_tools/constants` keeps for the CI audit script, read here for the pipelines extension's fix agent and board.
export const isCiInfraStep = (step: string): boolean => isInfraStep(step);

// ---- (2026-11-26) the forge's word for a program: what main's fix agent and the Pipelines board read ---------------------
// The forge clients and their credentials are the core's (CI ingestion); main's fix agent and the Pipelines board's
// backend are the pipelines extension's, which reads the forges through these, each declared in its
// `permissions.daemon`. Each resolves repo -> project and token per call, as every CI route does.

// One failed job of a run, as the forge lists it (POST /ci/runs/failed-steps): every job that failed, and every one the
// forge reports as cancelled whose cancel was a failure after all, in the run's order; a job allowed to fail is none.
export const CiFailedStepSchema = z.object({
    job: z.string().describe("The job, by name."),
    id: z.number().describe("The forge's id for it, which its log is read by."),
    step: z.string().optional().describe("The first step that failed it, where the forge names steps."),
    steps: z.array(z.string()).optional().describe("Every step that failed it, in order, where the forge names steps."),
    reason: z.string().optional().describe("The forge's own word for why it failed, where it gives one."),
    annotations: z.array(z.string()).optional().describe("What its check run annotations say, where the forge has them."),
    runner: z.string().optional().describe("The runner that ran it, by the name its forge knows it by."),
});
export type CiFailedStep = z.infer<typeof CiFailedStepSchema>;
export const CiFailedStepsResponseSchema = z.object({ steps: z.array(CiFailedStepSchema).describe("The run's failed jobs, in its order.") });
export const CiPassedJobsResponseSchema = z.object({ jobs: z.array(z.string()).describe("The names of the run's jobs that passed.") });
export const CiRunListParamSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    limit: z.number().int().min(1).max(100).describe("How many of its newest runs."),
});
export const CiRunListResponseSchema = z.object({ runs: z.array(PipelineRunSchema).describe("Its newest runs, newest first, asked of the forge now.") });
export const CiRunResponseSchema = z.object({ run: PipelineRunSchema.describe("The run, asked of the forge now.") });
// The workflow file a GitHub run ran, at its commit, and every reusable workflow it calls that could be read, by the key
// its call names it with: what the board's backend draws the run's job graph from. Absent where the forge has no such
// file (GitLab) or it could not be read.
export const CiRunWorkflowResponseSchema = z.object({
    root: z.string().optional().describe("The run's workflow file, at the run's commit."),
    called: z.record(z.string(), z.string()).describe("Each reusable workflow it calls that could be read, by the key its call names it with."),
});
export const CiJobParamSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    jobId: z.number().describe("Which job, by the forge's own id."),
});
export const CiJobLogResponseSchema = z.object({
    log: z.string().describe("The job's whole log, as plain text; a log the forge would not serve says so in place of it."),
});
export const CiJobAnnotationsResponseSchema = z.object({ annotations: z.array(z.string()).describe("What the job's check run annotations say.") });
// Each repository wired to CI, and which branches are its main line: the forge's default branch, learned at the hook
// reconcile and from every delivery, else the clone's `origin/HEAD`, else `main` and `master` both (ci/main-line.ts).
export const CiMainLineSchema = z.object({
    repo: z.string().describe("Which workspace repository."),
    host: CiHostSchema.describe("Which forge it lives on."),
    project: z.string().describe("The project there."),
    branches: z.array(z.string()).describe("Its main line: the default branch, or `main` and `master` when nothing has said which."),
    named: z.boolean().describe("Whether the forge or the clone named the default branch, rather than the two usual names standing in."),
    concluded: z
        .array(z.object({ branch: z.string(), status: z.enum(["success", "failed"]), at: z.number() }))
        .describe("The newest finished run heard on each of those branches, any workflow: how it ended and when it was heard. Empty when none was."),
});
export type CiMainLine = z.infer<typeof CiMainLineSchema>;
export const CiMainLinesResponseSchema = z.object({ lines: z.array(CiMainLineSchema) });
// An extension taking main lines' failures for itself (POST /ci/main-lines/claim): while a claim of an enabled extension
// stands, a main line's failure reaches no `ci` automation listening on every branch (ci/events.ts), so the extension's
// one fix agent is the only agent on it. Kept across restarts; an extension switched off holds none.
export const CiMainLineClaimSchema = z.object({ claimed: z.boolean().describe("Take main lines' failures (true), or let them go (false).") });
// What the sandbox's own test runs saw fail on clean trees at main commits (GET /ci/main/local), in rows and in words.
export const CiLocalMainResponseSchema = z.object({
    local: z.array(CiLocalMainSchema),
    text: z.string().describe("The same in words, as `agents ci` prints it below CI's own; empty when nothing is recorded."),
});

// ---- (2026-11-26) main's repair, as the daemon kept it until it moved to the pipelines extension ---------------------
// The shapes `.intentic/secrets/ci.json` held for main's one fix agent (`failures`, `passes`, `fleetReruns`,
// `ownerSteps`), handed once to the extension that takes main's repair over (POST /ci/repair/hand-over), so a sandbox's
// streaks, their turn counts and its fix agents carry across the update.

// One job failing on a main-line branch: its name, under the workflow it is a job of as its `source`, and an id derived
// from both, so the same job failing again in a later run is the same finding.
export const CiFindingSchema = z.object({
    id: z.string(),
    source: z.string(),
    text: z.string(),
    // Whether it failed by running out of time, the last time it failed.
    timedOut: z.boolean().optional(),
    // What the fixer read of the job when it last failed: the run and its commit, when it was read, and the error lines
    // its log named. Absent on a finding kept before 2026-11-17.
    runId: z.number().optional(),
    sha: z.string().optional(),
    readAt: z.number().optional(),
    errors: z.array(z.string()).optional(),
});
export type CiFinding = z.infer<typeof CiFindingSchema>;
// Main's CI failing on one branch, as its one fix agent's streak keeps it.
export const CiFailureSchema = z.object({
    // When its first job failed, which began the streak.
    since: z.number(),
    findings: z.array(CiFindingSchema).default([]),
    // Oldest first.
    decisions: z.array(MainFailureDecisionSchema).default([]),
    // The run the streak began in, which names its fix agent, and the newest run failing on it.
    firstRunId: z.number(),
    runId: z.number(),
    // How many runs have failed on it.
    count: z.number(),
    // Each workflow failing on it, with the newest run of it that failed. Empty for a failure kept before 2026-09-27.
    workflows: z.record(z.string(), z.number()).default({}),
    // Each workflow in `workflows`, timed apart (2026-11-03): when it began failing, when it last failed, and what set its
    // newest failed run off.
    spans: z.record(z.string(), z.object({ since: z.number(), failedAt: z.number(), trigger: z.string().optional() })).default({}),
    // Every failed job the streak has heard of, as `<runId>/<jobId>`, oldest first. Bounded.
    heard: z.array(z.string()).default([]),
    // Turns the sandbox started for its fix agent this streak; a person's Fix press gives them back.
    turns: z.number().default(0),
    // Whether its fix agent has left a change this streak.
    changed: z.boolean().default(false),
});
export type CiFailure = z.infer<typeof CiFailureSchema>;
export const CiOwnerStepKeptSchema = z.object({ step: z.string(), at: z.number() });
export const CiRepairHandOverSchema = z.object({
    // Keyed "<repo>\n<branch>": only branches failing when it was handed over.
    failures: z.record(z.string(), CiFailureSchema),
    // Keyed like `failures`: the newest run of each workflow that passed on a main-line branch.
    passes: z.record(z.string(), z.record(z.string(), z.number())),
    // Keyed by workspace repo: the runs re-run because the CI fleet, not the code, failed them, newest first.
    fleetReruns: z.record(z.string(), z.array(z.number())),
    // Keyed by fix conversation id: the step outside the repository its latest turn ended on.
    ownerSteps: z.record(z.string(), CiOwnerStepKeptSchema),
    // Whether the owner had switched repairs off in the sandbox's own setting, which the taking extension's own setting
    // of the same name now holds. Absent: they had not.
    autoRepair: z.literal(false).optional(),
});
export type CiRepairHandOver = z.infer<typeof CiRepairHandOverSchema>;
