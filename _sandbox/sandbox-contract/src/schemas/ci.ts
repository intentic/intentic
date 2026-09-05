// ci: pipeline runs on the workspace repos' github/gitlab remotes
import { z } from "zod";
import { AgentRunPickSchema } from "./agent.js";
// The daemon maps each workspace repo to the CI project behind its remote (a connected github/gitlab
// capability supplies the token), registers a webhook so completed pipelines dispatch `ci` listener
// automations instantly, and serves the Pipelines rail view from a webhook-freshened cache backfilled over the
// same REST clients. `host` names WHICH provider API serves a repo; the listener provider is always `ci`, one
// automation covers both hosts because the repo, not the vendor, is what a trigger narrows to.

export const CiHostSchema = z.enum(["github", "gitlab"]);
export type CiHost = z.infer<typeof CiHostSchema>;
/* Both vendors' vocabularies over one enum: github's status+conclusion pair and gitlab's single status collapse
 * onto these six.
 *
 * QUEUED IS ITS OWN STATE AND NOT A FLAVOUR OF RUNNING, which it used to be, on the reasoning that a view only
 * needs "still moving" vs the three ways it stopped. What that produced is a board that spins over work nothing
 * is doing: a nightly whose six self-hosted jobs are waiting for a runner that is offline reads as six jobs in
 * progress, with a duration ticking up, for as long as the runner stays down. The distinction is not cosmetic,
 * it is the difference between "wait" and "go look at your runners", and it is the only question a reader of a
 * stuck pipeline actually has.
 *
 * The two are still one class for everything that asks "has this said anything yet": neither is a verdict, and
 * the callers that care read them as a pair. */
export const PipelineStatusSchema = z.enum(["queued", "running", "success", "failed", "canceled", "skipped"]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;
/* Whether a run or a job has yet to say anything, the pair against the three ways one stops. Here rather than
 * in either consumer because both ends split on it and must split the same way: the daemon, to know that the
 * span between two timestamps is not yet a duration, and the board, to count what is in flight, to keep a
 * Cancel button on offer, and to leave a run out of a verdict walk. */
export const isPipelineInFlight = (status: PipelineStatus): boolean => status === "queued" || status === "running";
export const PipelineRunSchema = z.object({
    // The workspace repo dir (the panels `repo` convention), the join key back to the tree and to triggers.
    repo: z.string().describe("Which workspace repository it belongs to."),
    host: CiHostSchema.describe("Which forge is running it."),
    // owner/name (github) or the full project path (gitlab).
    project: z.string().describe("The project there, as that forge names it."),
    // The vendor's numeric run/pipeline id, what rerun/cancel address.
    runId: z.number().describe("The forge's own id for the run, which is what re-running and cancelling take."),
    // The run's headline: github's display_title (the commit subject, or the PR title when a PR triggered it),
    // gitlab's pipeline name or the head commit's subject. Absent ⇒ the view falls back to ref@sha.
    title: z
        .string()
        .optional()
        .describe("The run's headline, usually the commit subject or the pull request's title. Absent means falling back to the branch and commit."),
    // Who the vendor credits for the run, the actor who set it off, matching what both vendors' own UIs
    // show. The avatar is a vendor-hosted URL; absent ⇒ the view draws the author's initials instead.
    authorName: z.string().optional().describe("Who the forge credits for setting it off."),
    authorAvatarUrl: z.string().optional().describe("Their picture, hosted by the forge. Absent means drawing their initials instead."),
    // What set the run off, in the vendor's own vocabulary: gitlab's pipeline `source` (push, schedule,
    // merge_request_event, web, api, trigger…) or github's `event` (push, pull_request, schedule,
    // workflow_dispatch…). Left raw rather than flattened into a shared enum, the vendor's word is the
    // precise one, and the view only calls it out when it isn't the everyday push.
    trigger: z
        .string()
        .optional()
        .describe(
            "What set it off, in the forge's own word rather than flattened into a shared vocabulary, because the forge's word is the precise one.",
        ),
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
/* One job inside a pipeline run. The view fetches these lazily (one extra call per visible run) so the list
 * endpoint stays cheap. Both GitHub Actions jobs and GitLab CI jobs normalize onto these fields.
 *
 * HOW THE VIEW LEARNS THE RUN'S SHAPE, in descending order of truth:
 *   1. `needs`, the dependencies the pipeline itself declares. The real graph, and the only one that can say
 *      a job waited on THIS one rather than on everything before it. Neither vendor's jobs API returns it, so
 *      it is read out of the pipeline definition (github: workflowGraph.ts) and is absent whenever that could
 *      not be resolved, a private workflow file, a deleted one, a name no declared job matches.
 *   2. `stage`. GitLab's native sequential grouping, returned by its jobs API and used verbatim.
 *   3. The timestamps, the last resort, and GitHub's before `needs` existed: overlapping runtimes ⇒ the jobs
 *      ran in parallel. Honest about when things happened, silent about what actually gated what.
 * Both timestamps are epoch ms, and a `queued` job carries NEITHER. That is an invariant the normalizers hold
 * up rather than something a vendor gives: GitHub reports a `started_at` on a job that has never started, set
 * to the moment the run was queued, so a job waiting an hour for a runner arrives claiming an hour of work.
 * Everything downstream reads a present `startedAt` as "this began", so the lie has to be dropped at the edge. */
export const PipelineJobSchema = z.object({
    name: z.string().describe("The job's name."),
    status: PipelineStatusSchema.describe("How it went."),
    stage: z.string().optional().describe("Which stage it belongs to, where the pipeline groups its jobs that way."),
    // Names of jobs IN THIS RUN that this one declared it waits on. Absent ⇒ nothing was resolved and the view
    // must fall back; an empty array is the different, meaningful claim that this job is a root.
    needs: z
        .array(z.string())
        .optional()
        .describe(
            "Which jobs in this run it declared it waits on: the real shape of the pipeline. Absent means nothing could be read, which is different from an empty list, which is the claim that it waits on nothing.",
        ),
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
// One mapped repo's CI wiring state. `hookWarning` is the manual-setup story when webhook registration was
// refused (token scope, role) or impossible (no public URL): what happened plus the target URL + secret to
// paste into the repo's webhook settings, the git-access sshRegistrationWarning pattern.
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
            "Present when the sandbox could not register for instant notifications, with what happened and what to paste in by hand. Without them the sandbox polls instead, so this costs a couple of minutes' delay rather than the feature.",
        ),
});
export type CiRepo = z.infer<typeof CiRepoSchema>;
/* How often the daemon polls a repo whose webhook could NOT be registered (ci/poller.ts), the fallback that
 * keeps a `ci` automation firing on a sandbox with no public URL or a token without hook scope.
 *
 * Here rather than beside the poller because both ends need the number: the daemon to run on it, and the
 * automation editor to tell the owner what a `hookWarning` actually costs them. "Webhooks are off" is a fact
 * about infrastructure; "this fires within two minutes instead of instantly" is the answer to the question
 * they were really asking. */
export const CI_POLL_INTERVAL_MS = 2 * 60_000;
export const CiRunsResponseSchema = z.object({
    repos: z.array(CiRepoSchema).describe("Which workspace repositories are wired to a forge, and how each one's notifications are set up."),
    // Newest first, across all mapped repos.
    runs: z.array(PipelineRunSchema).describe("Runs across all of them, newest first."),
});
export type CiRunsResponse = z.infer<typeof CiRunsResponseSchema>;
// rerun/cancel/fix address a run by repo + vendor id; the daemon re-resolves repo → project + token per call,
// so a stale card can't act on a project the workspace no longer maps to.
export const CiRunParamSchema = z.object({
    repo: z
        .string()
        .describe(
            "Which workspace repository. The project behind it is resolved fresh each call, so a stale screen cannot act on one the workspace no longer maps to.",
        ),
    runId: z.number().describe("Which run, by the forge's own id."),
});
export type CiRunParam = z.infer<typeof CiRunParamSchema>;
// Fixing takes one thing the vendor proxies do not: which model to open the session on, when the user reached
// for the caret beside the button rather than pressing it (AgentRunPickSchema). Absent is the ordinary path.
export const CiFixParamSchema = CiRunParamSchema.extend({
    pick: AgentRunPickSchema.describe(
        "Which model to open the conversation on, when somebody chose one. Leave it out for the sandbox's own choice, which is the ordinary path.",
    ),
});
export type CiFixParam = z.infer<typeof CiFixParamSchema>;
// The fix route opens an isolated conversation (fleet card + chat tab) seeded with the failure context.
export const CiFixResponseSchema = z.object({
    conversationId: z.string().describe("The conversation that was opened, already holding the failure. Open it to watch, or attach to its turn."),
});
export type CiFixResponse = z.infer<typeof CiFixResponseSchema>;
/* ---- the pre-push check: the workspace's own answer to "would this push go red" ----
 *
 * WHERE THIS SITS. A fleet of 5-20 agents lands work into the main tree, the user reviews and commits it by
 * parts, pushes, and CI answers minutes later. The check front-runs that answer at the push itself, the last
 * moment before the work leaves the machine, and the first moment at which what will be pushed is finally
 * settled.
 *
 * WHY THE PUSH AND NOT THE LAND, which is where this used to run. A post-land verdict is about a tree that
 * keeps moving: the user commits by parts, another agent lands, an edit arrives, so the verdict spent its life
 * either stale or being recomputed, and needed a content fingerprint, a staleness rule and a badge to say which.
 * All of that machinery existed to answer a question the push asks for free, because at the push there is
 * exactly one artifact and the user is standing in front of it waiting.
 *
 * SO THERE IS NO STORED VERDICT AND NOTHING IS POLLED AT REST. A run exists while it runs, reports to the
 * dialog that started it, and is gone. Nothing survives a daemon restart because nothing needs to: the next
 * push asks again. */

/* A COMMAND RUN ON A CLICK, in a visible terminal, with a verdict and a quotable tail: the ONE shape for
 * everything the daemon runs because the owner pressed a button and then has to be told how it went. The
 * pre-push check is one (above); the push itself is another (PushRunSchema, schemas/git.ts), because a push
 * runs the repository's own pre-push hook, which is a suite in disguise. One shape rather than one per
 * moment, so a field the browser learns to read for the check (the terminal to open, the tail to quote, the
 * kill to distinguish from the timeout) is read for the push by the same code, and cannot drift.
 *
 * Where a run is.
 *
 *   idle     , nothing has run in this daemon's life, or the last run was cleared.
 *   running  , the command is live. Its output is the terminal's (`session`), not this object's.
 *   passed   , exited 0. The push goes (or went).
 *   failed   , exited non-zero, or was killed by its ceiling (`timedOut`). The state a fix answers.
 *   error    , the command could not run at all: it was not spawnable. NOT a fix-able failure, because there
 *               is nothing wrong with the code, the command is misconfigured, and saying "tests failed" would
 *               send an agent hunting a bug that isn't there.
 *   cancelled, the user stopped the run.
 */
export const CommandRunStatusSchema = z.enum(["idle", "running", "passed", "failed", "error", "cancelled"]);
export type CommandRunStatus = z.infer<typeof CommandRunStatusSchema>;
export const CommandRunSchema = z.object({
    status: CommandRunStatusSchema.describe(
        "Where the run is. Failed and error are deliberately different: failed means the code is wrong, error means the command could not be run at all, and calling the second one a test failure would send an agent hunting a bug that is not there.",
    ),
    // The command this run executed, echoed rather than read back from settings: a result read after the
    // setting changed still has to say what produced it.
    command: z
        .string()
        .describe(
            "What actually ran, echoed here rather than read back from the settings, so a result looked at after the setting changed still says what produced it.",
        ),
    startedAt: z.number().optional().describe("When it began, in milliseconds."),
    finishedAt: z.number().optional().describe("When it ended, in milliseconds."),
    exitCode: z.number().optional().describe("How the command exited."),
    timedOut: z.boolean().optional().describe("It was killed for taking too long rather than finishing."),
    /* The tmux session the suite runs in, for the browser to open the terminals panel on, the check is a
     * visible terminal like every other shell command the daemon runs on a click (terminal/terminal-run.ts), so
     * WATCHING it is not this object's job and never was. Absent where the sandbox has no tmux wrapper (local
     * dev): the runner falls back to an invisible shell, and a name nothing can attach to would send the browser
     * after a tab that is never going to be listed. */
    session: z
        .string()
        .optional()
        .describe(
            "The terminal it runs in, which is where to watch it. Absent where the sandbox has no terminals, in which case there is nothing to attach to.",
        ),
    /* What the fix proposal quotes, and its only reader, tail-capped (PREPUSH_OUTPUT_BYTES) so a prompt seeded
     * from a red run stays about fixing rather than scrolling. The TAIL, not the head: a suite's verdict and its
     * failure summary are at the end. PLAIN TEXT, not what the terminal received: the suite's colour codes and
     * redrawn progress lines are resolved away (terminal/plain-text.ts) before the cap, so a quoted tail reads
     * as a failure instead of as litter. Empty while the run is going, and for a run that was killed: the pane
     * (and its log) is where the whole of it lives. */
    output: z
        .string()
        .describe(
            "The end of what it printed, as plain text with the colour codes and redrawn progress lines resolved away. The end rather than the beginning, because a suite's verdict is at the end. Empty while it runs, and for one that was killed.",
        ),
});
export type CommandRun = z.infer<typeof CommandRunSchema>;
