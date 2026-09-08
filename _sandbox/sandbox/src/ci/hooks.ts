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
        project.account.provider === "github" ? `content type application/json, the "Workflow runs" event` : `the "Pipeline events" trigger`;
    return `Add it manually at ${settings}: payload URL ${url}, secret ${secret}, ${events}.`;
};

const scopeHint = (project: CiProject): string =>
    project.account.provider === "github"
        ? `creating webhooks needs admin:repo_hook on a classic PAT (or the "Webhooks: write" repo permission on a fine-grained token)`
        : `creating webhooks needs the api scope and at least the Maintainer role on the project`;

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
    let pass: Promise<void> = Promise.resolve();

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
                warnings.set(project.repo, {
                    reason: `Pipeline webhook registration failed: ${errorMessage(error)}. ${scopeHint(project)}.`,
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
    const reconcile = (): Promise<void> => {
        const run = pass.then(reconcileOnce, reconcileOnce);
        pass = run.catch(() => undefined);
        return run;
    };

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
