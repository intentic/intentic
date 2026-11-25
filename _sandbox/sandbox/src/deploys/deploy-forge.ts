import { keyedLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { DeployRecord, StackSpec } from "@intentic/sandbox-contract/schemas/deploys";
import type { Logger } from "pino";
import { z } from "zod";
import { githubHeaders } from "../capabilities/cli/git-access.js";
import { CiRefused, throwOn } from "../ci/forge-refusals.js";
import type { CiProject } from "../ci/projects.js";
import type { FetchFn } from "../ci/providers.js";
import { repoFolder } from "../hosts/stacks/device-stack-bundle.js";
import { opt } from "../opt.js";
import { manifestAt } from "./deploy-manifests.js";
import { type DeployWatchStore, FORGE_REPORTS_KEPT, type ForgeReport } from "./deploy-watch-store.js";
import type { DeploysEngine } from "./deploys-engine.js";

/* EACH DEPLOY ON THE FORGE IT CAME FROM (schemas/deploys.ts: deploys are pulled, and the outcome goes back), told when it
   starts and when it ends, with the token of the GitHub or GitLab connection the repository's remote maps to
   (ci/projects.ts):
   - GitHub: a Deployment of the commit to an environment named after the stack (production unless the name says
     staging), then its statuses: `in_progress`, and `success`, `failure` (failed, or rolled back), `error` (refused) or
     `inactive` (replaced while it waited, once it had started there). `environment_url` is the origin of the stack's
     first health URL that is not loopback, and `log_url` the sandbox's Deployments page when its public address is known.
   - GitLab: a commit status named `deploy/<stack>`: running, then success, failed or canceled.
   The record keeps where the forge shows it (`forgeUrl`). Nothing here fails a deploy: a refusal (a token without
   Deployments: write, a commit the forge does not have) is logged once per repository and shown as a problem on its
   environments until a report there works again. */

export interface ForgeDeps {
    readonly root: string;
    readonly engine: Pick<DeploysEngine, "noteForgeUrl" | "setForgeProblem">;
    // The repository's CI project, with its connection's API base and token; undefined when none is connected.
    readonly projectOf: (repo: string) => Promise<CiProject | undefined>;
    readonly fetch: FetchFn;
    readonly store: DeployWatchStore;
    // The sandbox's public address, when it has one.
    readonly publicUrl: string | undefined;
    readonly logger: Pick<Logger, "warn">;
}

// GitHub's word for where a record is; undefined for one the forge is not told of (still waiting).
type ForgeState = "in_progress" | "success" | "failure" | "error" | "inactive";
const forgeStateOf = (record: DeployRecord): ForgeState | undefined => {
    switch (record.outcome) {
        case "running":
            return "in_progress";
        case "succeeded":
            return "success";
        case "failed":
        case "rolled-back":
            return "failure";
        case "refused":
            return "error";
        case "superseded":
            return "inactive";
        default:
            return undefined;
    }
};

// GitLab's words for the same.
const GITLAB_STATES = {
    in_progress: "running",
    success: "success",
    failure: "failed",
    error: "failed",
    inactive: "canceled",
} as const satisfies Readonly<Record<ForgeState, string>>;

// What the owner does about a refusal, per forge.
const PROBLEM = {
    github: "give the GitHub token Deployments: write to see deploys on GitHub",
    gitlab: "give the GitLab token the api scope to see deploys on GitLab",
} as const;

const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

// Where the stack answers from outside: the origin of its first health URL that is not loopback.
export const environmentUrlOf = (spec: Pick<StackSpec, "health"> | undefined): string | undefined => {
    for (const url of spec?.health?.http ?? []) {
        const parsed = URL.canParse(url) ? new URL(url) : undefined;
        if (parsed !== undefined && !LOOPBACK.test(parsed.hostname)) {
            return parsed.origin;
        }
    }
    return undefined;
};

// One line for the forge's status, at most what GitHub keeps (140 characters).
const descriptionOf = (record: DeployRecord): string => {
    const said = record.error?.split("\n")[0] ?? (record.outcome === "running" ? `Deploying ${record.commit.slice(0, 8)} by Intentic` : `Deploy ${record.outcome}`);
    return said.length > 140 ? `${said.slice(0, 139)}…` : said;
};

// What a report POSTs, as JSON; an absent field is left out.
type ForgeJson = string | number | boolean | readonly ForgeJson[] | { readonly [key: string]: ForgeJson | undefined };
const posted = (body: ForgeJson, headers: Readonly<Record<string, string>>): RequestInit => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...headers, "Content-Type": "application/json" },
});

// What GitHub answers a deployment created, narrowed to the id its statuses go to.
const CreatedSchema = z.object({ id: z.number() });

// A refusal the owner can mend with the token's scopes, rather than one about this commit or the forge being down.
const scopeRefusal = (error: Error): boolean => error instanceof CiRefused && (error.status === 401 || error.status === 403 || error.status === 404);

// What a report to either forge reads: the call, the engine for the record's forge URL, the stack's spec and the page.
interface ReportDeps extends Pick<ForgeDeps, "fetch" | "engine"> {
    readonly specOf: (record: DeployRecord) => Promise<StackSpec | undefined>;
    readonly logUrlOf: (record: DeployRecord) => string | undefined;
}

// The record's deployment on GitHub, created the first time, and its new status; the deployment's id.
const github = async (deps: ReportDeps, project: CiProject, record: DeployRecord, state: ForgeState, held: ForgeReport | undefined): Promise<number> => {
    const base = `${project.account.apiBase}/repos/${project.project}`;
    const headers = githubHeaders(project.account.token);
    const environmentUrl = environmentUrlOf(await deps.specOf(record));
    let deployment = held?.deployment;
    if (deployment === undefined) {
        const created = await throwOn(
            await deps.fetch(
                `${base}/deployments`,
                posted(
                    {
                        ref: record.commit,
                        environment: record.stack,
                        description: (record.trigger.detail ?? record.trigger.kind).slice(0, 140),
                        auto_merge: false,
                        required_contexts: [],
                        transient_environment: false,
                        production_environment: !record.stack.includes("staging"),
                    },
                    headers,
                ),
            ),
            `creating a GitHub deployment of ${record.stack}`,
        );
        deployment = CreatedSchema.parse(await created.json()).id;
        await deps.engine.noteForgeUrl(record.id, `https://github.com/${project.project}/deployments/${encodeURIComponent(record.stack)}`);
    }
    const status = { state, description: descriptionOf(record), environment_url: environmentUrl, log_url: deps.logUrlOf(record) };
    await throwOn(await deps.fetch(`${base}/deployments/${deployment}/statuses`, posted(status, headers)), `setting a GitHub deployment's status`);
    return deployment;
};

// The record's commit status on GitLab.
const gitlab = async (deps: ReportDeps, project: CiProject, record: DeployRecord, state: ForgeState, held: ForgeReport | undefined): Promise<void> => {
    const url = `${project.account.apiBase}/projects/${encodeURIComponent(project.project)}/statuses/${record.commit}`;
    const status = { state: GITLAB_STATES[state], name: `deploy/${record.stack}`, description: descriptionOf(record), ref: record.ref, target_url: deps.logUrlOf(record) };
    await throwOn(await deps.fetch(url, posted(status, { "PRIVATE-TOKEN": project.account.token })), "setting a GitLab commit status");
    if (held === undefined) {
        await deps.engine.noteForgeUrl(record.id, `${project.account.apiBase.replace(/\/api\/v4$/, "")}/${project.project}/-/commit/${record.commit}`);
    }
};

export const createForgeReports = (deps: ForgeDeps) => {
    // One record's reports in order: its deployment before its statuses.
    const inOrder = keyedLock<string>();
    // Repositories whose refusal is logged already, until a report there works.
    const refused = new Set<string>();

    const logUrlOf = (record: DeployRecord): string | undefined =>
        deps.publicUrl === undefined
            ? undefined
            : `${deps.publicUrl.replace(/\/+$/, "")}/ext/deployments?repo=${encodeURIComponent(record.repo)}&stack=${encodeURIComponent(record.stack)}`;

    // The stack as its record's commit declares it, for the URL it answers on; undefined when that cannot be read.
    const specOf = async (record: DeployRecord): Promise<StackSpec | undefined> => {
        const read = await repoFolder(deps.root, record.repo)
            .then((dir) => manifestAt(dir, record.commit))
            // allow(silent-catch): the URL is an extra on the forge's page; a status without it still says how the deploy went
            .catch(() => undefined);
        return read?.kind === "read" ? read.manifest.stacks.find((stack) => stack.name === record.stack) : undefined;
    };

    const failed = (project: CiProject, record: DeployRecord, error: Error): void => {
        const host = project.account.provider;
        if (scopeRefusal(error)) {
            deps.engine.setForgeProblem(record.repo, `${host === "github" ? "GitHub" : "GitLab"} refused this repository's deploy reports: ${PROBLEM[host]}.`);
        }
        if (!refused.has(record.repo)) {
            refused.add(record.repo);
            deps.logger.warn({ err: error, repo: record.repo, id: record.id }, `deploys: the forge was not told of a deploy: ${errorMessage(error)}`);
        }
    };

    const reporting: ReportDeps = { fetch: deps.fetch, engine: deps.engine, specOf, logUrlOf };
    const report = async (record: DeployRecord): Promise<void> => {
        const state = forgeStateOf(record);
        const held = (await deps.store.read()).forge.find((entry) => entry.id === record.id);
        // Told already, or replaced before it ever started there: nothing new for the forge.
        if (state === undefined || held?.reported === state || (held === undefined && state === "inactive")) {
            return;
        }
        const project = await deps.projectOf(record.repo);
        if (project === undefined) {
            return;
        }
        let deployment = held?.deployment;
        try {
            if (project.account.provider === "github") {
                deployment = await github(reporting, project, record, state, held);
            } else {
                await gitlab(reporting, project, record, state, held);
            }
        } catch (error) {
            failed(project, record, error instanceof Error ? error : new Error(errorMessage(error)));
            return;
        }
        refused.delete(record.repo);
        deps.engine.setForgeProblem(record.repo, undefined);
        const kept: ForgeReport = { id: record.id, ...opt("deployment", deployment), reported: state };
        await deps.store.update((current) => ({ ...current, forge: [...current.forge.filter((entry) => entry.id !== record.id), kept].slice(-FORGE_REPORTS_KEPT) }));
    };

    return {
        // Every record as the engine writes it (onDeployRecord); never rejects.
        recorded: (record: DeployRecord): Promise<void> =>
            inOrder(record.id, () => report(record)).catch((error: Error) => deps.logger.warn({ err: error, id: record.id }, "deploys: a forge report stopped on an error")),
    };
};
