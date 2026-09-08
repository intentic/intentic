// ci: pipeline runs on the workspace repos' github/gitlab remotes
import { z } from "zod";
import { AgentRunPickSchema } from "./agent.js";
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
export const CiRunsResponseSchema = z.object({
    repos: z.array(CiRepoSchema).describe("Which workspace repositories are wired to a forge, and how each one's notifications are set up."),
    // Newest first, across all mapped repos.
    runs: z.array(PipelineRunSchema).describe("Runs across all of them, newest first."),
});
export type CiRunsResponse = z.infer<typeof CiRunsResponseSchema>;
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
    force: z
        .boolean()
        .optional()
        .describe(
            "Open the conversation even when every failed job died in its runner's own setup, which is the fleet's fault and nothing an agent on the code can repair. Left out, such a run is refused with that sentence.",
        ),
});
export type CiFixParam = z.infer<typeof CiFixParamSchema>;
// The fix route opens an isolated conversation (fleet card + chat tab) seeded with the failure context.
export const CiFixResponseSchema = z.object({
    conversationId: z.string().describe("The conversation that was opened, already holding the failure. Open it to watch, or attach to its turn."),
});
export type CiFixResponse = z.infer<typeof CiFixResponseSchema>;
// The workspace's own answer to "would this push go red": front-runs CI at the push itself, the last moment before work
// leaves the machine and the first at which what's pushed is finally settled. Runs at the push rather than the land,
// where the tree keeps moving and a verdict would need staleness tracking to answer a question the push gets for free.
// No stored verdict, nothing polled at rest: a run exists while it runs and is gone after, since the next push asks
// again.

// One shape for any command the daemon runs on a click with a verdict and a quotable tail (the pre-push check, and the
// push itself via PushRunSchema in schemas/git.ts), so the fields the browser reads (terminal, tail, kill vs timeout)
// can't drift between them.
// idle: nothing has run yet, or the last run was cleared
// running: live; its output is the terminal's, not this object's
// passed: exited 0
// failed: exited non-zero, or killed by its ceiling (`timedOut`)
// error: not spawnable at all; not fixable, since nothing is wrong with the code
// cancelled: the user stopped it
export const CommandRunStatusSchema = z.enum(["idle", "running", "passed", "failed", "error", "cancelled"]);
export type CommandRunStatus = z.infer<typeof CommandRunStatusSchema>;
export const CommandRunSchema = z.object({
    status: CommandRunStatusSchema.describe(
        "Where the run is. Failed and error are deliberately different: failed means the code is wrong, error means the command could not be run at all, and calling the second one a test failure would send an agent hunting a bug that is not there.",
    ),
    // Echoed rather than read from settings, so a result seen after the setting changed still says what produced it.
    command: z
        .string()
        .describe(
            "What actually ran, echoed here rather than read back from the settings, so a result looked at after the setting changed still says what produced it.",
        ),
    startedAt: z.number().optional().describe("When it began, in milliseconds."),
    finishedAt: z.number().optional().describe("When it ended, in milliseconds."),
    exitCode: z.number().optional().describe("How the command exited."),
    timedOut: z.boolean().optional().describe("It was killed for taking too long rather than finishing."),
    // The tmux session to open, since watching a run is the terminal panel's job, not this object's; absent where the
    // sandbox has no tmux wrapper.
    session: z
        .string()
        .optional()
        .describe(
            "The terminal it runs in, which is where to watch it. Absent where the sandbox has no terminals, in which case there is nothing to attach to.",
        ),
    // Tail-capped plain text, colour codes and redrawn progress lines stripped, so a fix prompt quotes a verdict, not
    // terminal litter; empty while running or for a killed run.
    output: z
        .string()
        .describe(
            "The end of what it printed, as plain text with the colour codes and redrawn progress lines resolved away. The end rather than the beginning, because a suite's verdict is at the end. Empty while it runs, and for one that was killed.",
        ),
});
export type CommandRun = z.infer<typeof CommandRunSchema>;
