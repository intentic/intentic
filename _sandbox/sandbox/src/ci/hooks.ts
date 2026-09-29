import { serialLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { CiStore } from "./ci-store.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

// Reconciles each mapped repo's CI webhook against this sandbox's public receiver, on an interval and at boot since
// repos, accounts and hooks drift independently. A failed registration or missing public URL degrades a repo to a
// WARNING with the manual recipe (GET /ci/runs); an unmapped repo's hook is removed only while its account stays
// connected.

const RECONCILE_INTERVAL_MS = 10 * 60_000;

// One receiver URL per vendor host; every repo of that host shares it, and it doubles as the hook's identity.
export const webhookUrlFor = (publicUrl: string, host: "github" | "gitlab"): string => `${publicUrl.replace(/\/+$/, "")}/ci/webhook/${host}`;

const manualRecipe = (project: CiProject, url: string, secret: string): string => {
    const settings =
        project.account.provider === "github"
            ? `https://${project.account.host}/${project.project}/settings/hooks`
            : `${project.account.apiBase.replace(/\/api\/v4$/, "")}/${project.project}/-/hooks`;
    const events =
        project.account.provider === "github"
            ? `content type application/json, the "Workflow runs" and "Workflow jobs" events`
            : `the "Pipeline events" and "Job events" triggers`;
    return `Add it manually at ${settings}: payload URL ${url}, secret ${secret}, ${events}.`;
};

const scopeHint = (project: CiProject): string =>
    project.account.provider === "github"
        ? `creating webhooks needs admin:repo_hook on a classic PAT (or the "Webhooks: write" repo permission on a fine-grained token)`
        : `creating webhooks needs the api scope and at least the Maintainer role on the project`;

// Why the vendor refused, in words: its status, never its response body. A 404 or 403 on the hooks API is almost always
// a token without admin rights on the repository (or a repository that is not yours), which the vendor will not say.
const refusalOf = (error: unknown): string => {
    const status = /\((\d{3})\)/.exec(errorMessage(error))?.[1];
    if (status === "401") {
        return "the connected token was refused";
    }
    if (status === "403" || status === "404") {
        return "the connected token has no admin rights on it";
    }
    return status === undefined ? "the request did not go through" : `the request was refused (${status})`;
};

// reason (why the hook isn't live) is visible to any viewer; recipe carries the signing secret and is operator-only
// (ci.routes.ts gates it), absent when there is no public URL to paste it into.
export interface HookWarning {
    readonly reason: string;
    readonly recipe?: string;
}

export interface CiHookReconciler {
    readonly start: () => void;
    readonly stop: () => void;
    // One reconcile pass; start runs it immediately then on the interval, also for tests and capability changes.
    readonly reconcile: () => Promise<void>;
    // repo → why its hook isn't live (+ the manual recipe). Empty ⇒ every mapped repo is wired.
    readonly warnings: () => ReadonlyMap<string, HookWarning>;
}

export const createCiHookReconciler = (
    services: {
        readonly workspace: { readonly root: string };
        readonly capabilities: CapabilitiesStore;
        readonly ciStore: CiStore;
        readonly config: { readonly sandbox: { readonly publicUrl: string } };
        readonly logger: Logger;
    },
    fetchFn: FetchFn = fetch,
): CiHookReconciler => {
    const warnings = new Map<string, HookWarning>();
    // Previous pass's wired hooks, keyed by host+project; diffing against it finds an unmapped repo's hook.
    let wired = new Map<string, CiProject>();
    let timer: NodeJS.Timeout | undefined;
    const serially = serialLock();

    const reconcileOnce = async (): Promise<void> => {
        const projects = await ciProjects(services);
        const publicUrl = services.config.sandbox.publicUrl;
        const secret = await services.ciStore.secret();
        warnings.clear();
        const next = new Map<string, CiProject>();
        for (const project of projects) {
            next.set(`${project.account.provider}\n${project.project}`, project);
            if (publicUrl === "") {
                warnings.set(project.repo, { reason: `Pipeline webhooks are off: this sandbox has no public URL for the provider to deliver to.` });
                continue;
            }
            const url = webhookUrlFor(publicUrl, project.account.provider);
            try {
                await ciClientFor(project.account.provider, fetchFn).ensureHook(project, { url, secret });
            } catch (error) {
                // The plain reason leads and the vendor's raw answer stays in the log: a JSON body in the page header
                // read as a crash, with the one useful sentence after it.
                services.logger.warn({ err: error, repo: project.repo }, "ci: webhook registration failed");
                warnings.set(project.repo, {
                    reason: `Can't register a pipeline webhook on ${project.project}: ${refusalOf(error)}; ${scopeHint(project)}. Its runs are polled instead, so they show up a little later.`,
                    recipe: manualRecipe(project, url, secret),
                });
            }
        }
        // Removes the hook only if its account is still connected; otherwise there is no token to delete it with.
        for (const [key, project] of wired) {
            if (!next.has(key) && publicUrl !== "") {
                await ciClientFor(project.account.provider, fetchFn)
                    .removeHook(project, webhookUrlFor(publicUrl, project.account.provider))
                    .catch((error: unknown) => services.logger.warn({ err: error, repo: project.repo }, "ci: stale hook removal failed"));
            }
        }
        wired = next;
    };

    // Serializes reconcile calls; a manual call during the interval's pass chains after it instead of racing two hook
    // lists.
    const reconcile = (): Promise<void> => serially(reconcileOnce);

    return {
        reconcile,
        warnings: () => warnings,
        start: () => {
            void reconcile().catch((error: unknown) => services.logger.warn({ err: error }, "ci: hook reconcile failed"));
            timer = setInterval(
                () => void reconcile().catch((error: unknown) => services.logger.warn({ err: error }, "ci: hook reconcile failed")),
                RECONCILE_INTERVAL_MS,
            );
        },
        stop: () => clearInterval(timer),
    };
};
