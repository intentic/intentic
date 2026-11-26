import { isPipelineInFlight, type PipelineRun, type PipelineStatus } from "@intentic/sandbox-contract/schemas/ci";
import type { ForgeProject } from "./projects.js";

export const epoch = (iso: string | undefined | null): number => {
    const parsed = iso === undefined || iso === null ? Number.NaN : Date.parse(iso);
    return Number.isNaN(parsed) ? 0 : parsed;
};

// Whether a run/job is over; only then is the span between its timestamps a duration, not elapsed-so-far or queue wait.
export const isSettled = (status: PipelineStatus): boolean => !isPipelineInFlight(status);

// ---- github: Actions workflow runs ----

// Pre-run states (accepted, not yet executing); an unrecognized non-terminal status reads as running.
const GITHUB_QUEUED = new Set(["queued", "waiting", "requested", "pending"]);

// A completed run's conclusion maps to the three terminal buckets; anything meaning "did not pass" (failure, timed_out,
// startup_failure, action_required) reads as failed.
export const githubStatus = (status: string, conclusion: string | null | undefined): PipelineStatus => {
    if (status !== "completed") {
        return GITHUB_QUEUED.has(status) ? "queued" : "running";
    }
    switch (conclusion) {
        case "success":
            return "success";
        case "cancelled":
            return "canceled";
        case "skipped":
        case "neutral":
        case "stale":
            return "skipped";
        default:
            return "failed";
    }
};

export interface GithubRun {
    readonly id: number;
    readonly display_title?: string;
    readonly head_branch: string | null;
    readonly head_sha: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly html_url: string;
    readonly created_at: string;
    readonly run_started_at?: string;
    readonly updated_at: string;
    // Who set the run off; present on the runs list and the webhook, so the avatar costs no extra call.
    readonly actor?: { readonly login?: string; readonly avatar_url?: string } | null;
    // push | pull_request | schedule | workflow_dispatch | …
    readonly event?: string;
    // The workflow's name, which its jobs' webhooks name too (`workflow_name`).
    readonly name?: string;
}

// One workflow_run object -> the normalized run; shared by the list call and the webhook receiver (same object under
// `workflow_run`).
export const githubRun = (project: Pick<ForgeProject, "repo" | "project">, run: GithubRun): PipelineRun => {
    const status = githubStatus(run.status, run.conclusion);
    const started = epoch(run.run_started_at ?? run.created_at);
    const ended = epoch(run.updated_at);
    return {
        repo: project.repo,
        host: "github",
        project: project.project,
        runId: run.id,
        ...(run.display_title !== undefined && run.display_title !== "" ? { title: run.display_title } : {}),
        ...(run.actor?.login !== undefined && run.actor.login !== "" ? { authorName: run.actor.login } : {}),
        ...(run.actor?.avatar_url !== undefined && run.actor.avatar_url !== "" ? { authorAvatarUrl: run.actor.avatar_url } : {}),
        ...(run.event !== undefined && run.event !== "" ? { trigger: run.event } : {}),
        ...(run.name !== undefined && run.name !== "" ? { workflow: run.name } : {}),
        branch: run.head_branch ?? "",
        sha: run.head_sha,
        status,
        url: run.html_url,
        createdAt: epoch(run.created_at),
        ...(isSettled(status) && ended > started ? { durationSeconds: Math.round((ended - started) / 1000) } : {}),
    };
};

// ---- gitlab: pipelines ----

// Pre-run states, including manual/scheduled (waiting on a person or clock); unrecognized reads as running.
const GITLAB_QUEUED = new Set(["created", "waiting_for_resource", "preparing", "pending", "manual", "scheduled"]);

export const gitlabStatus = (status: string): PipelineStatus => {
    switch (status) {
        case "success":
            return "success";
        case "failed":
            return "failed";
        case "canceled":
            return "canceled";
        case "skipped":
            return "skipped";
        default:
            return GITLAB_QUEUED.has(status) ? "queued" : "running";
    }
};

export interface GitlabPipeline {
    readonly id: number;
    readonly name?: string | null;
    readonly ref: string;
    readonly sha: string;
    readonly status: string;
    readonly web_url: string;
    readonly created_at: string;
    readonly updated_at?: string;
    // push | schedule | merge_request_event | web | api | trigger | …
    readonly source?: string;
}

// A pipelines-list row names neither its commit nor its author; listRuns joins both in from responses the vendor
// already returns.
export interface GitlabRunMeta {
    readonly title?: string;
    readonly authorName?: string;
    readonly authorAvatarUrl?: string;
    readonly trigger?: string;
}

// One pipelines-list row -> the normalized run; duration is the created-to-updated span (queue time included) until a
// webhook overwrites it with the true one. `meta` is optional; absent still yields a valid run.
export const gitlabRun = (project: Pick<ForgeProject, "repo" | "project">, pipeline: GitlabPipeline, meta: GitlabRunMeta = {}): PipelineRun => {
    const status = gitlabStatus(pipeline.status);
    const created = epoch(pipeline.created_at);
    const updated = epoch(pipeline.updated_at);
    // A named pipeline takes priority; fall back to the commit subject only when unnamed.
    const title = pipeline.name !== undefined && pipeline.name !== null && pipeline.name !== "" ? pipeline.name : meta.title;
    const trigger = pipeline.source ?? meta.trigger;
    return {
        repo: project.repo,
        host: "gitlab",
        project: project.project,
        runId: pipeline.id,
        ...(title !== undefined && title !== "" ? { title } : {}),
        ...(meta.authorName !== undefined && meta.authorName !== "" ? { authorName: meta.authorName } : {}),
        ...(meta.authorAvatarUrl !== undefined && meta.authorAvatarUrl !== "" ? { authorAvatarUrl: meta.authorAvatarUrl } : {}),
        ...(trigger !== undefined && trigger !== "" ? { trigger } : {}),
        branch: pipeline.ref,
        sha: pipeline.sha,
        status,
        url: pipeline.web_url,
        createdAt: created,
        ...(isSettled(status) && updated > created ? { durationSeconds: Math.round((updated - created) / 1000) } : {}),
    };
};

// Pipeline Hook payload shape differs from the list row (attributes nested, true duration present, no web_url on older
// instances); its own normalizer shares the status mapping.
export interface GitlabPipelineHook {
    readonly object_attributes: {
        readonly id: number;
        readonly name?: string | null;
        readonly ref: string;
        readonly sha: string;
        readonly status: string;
        readonly created_at: string;
        readonly duration?: number | null;
        readonly url?: string;
    };
    // `id` and `default_branch` are the forge's word on the project (main-line.ts), not on the run.
    readonly project: {
        readonly id?: number;
        readonly path_with_namespace: string;
        readonly web_url: string;
        readonly default_branch?: string | null;
    };
    readonly commit?: { readonly title?: string };
    // The hook is the one gitlab path that hands us an avatar outright, no /avatar lookup needed.
    readonly user?: { readonly name?: string; readonly username?: string; readonly avatar_url?: string };
}

export const gitlabHookRun = (project: Pick<ForgeProject, "repo" | "project">, hook: GitlabPipelineHook): PipelineRun => {
    const attributes = hook.object_attributes;
    const title = attributes.name ?? hook.commit?.title;
    const author = hook.user?.name ?? hook.user?.username;
    return {
        repo: project.repo,
        host: "gitlab",
        project: project.project,
        runId: attributes.id,
        ...(title !== undefined && title !== null && title !== "" ? { title } : {}),
        ...(author !== undefined && author !== "" ? { authorName: author } : {}),
        ...(hook.user?.avatar_url !== undefined && hook.user.avatar_url !== "" ? { authorAvatarUrl: hook.user.avatar_url } : {}),
        branch: attributes.ref,
        sha: attributes.sha,
        status: gitlabStatus(attributes.status),
        url: attributes.url ?? `${hook.project.web_url}/-/pipelines/${attributes.id}`,
        createdAt: epoch(attributes.created_at),
        ...(attributes.duration !== undefined && attributes.duration !== null ? { durationSeconds: attributes.duration } : {}),
    };
};
