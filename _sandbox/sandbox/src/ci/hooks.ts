import type { Logger } from "pino";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { CiStore } from "./ci-store.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

/* The webhook reconciler: every mapped repo gets a hook delivering completed pipelines to this sandbox's
 * public receiver, so `ci` automations wake instantly and the runs cache stays fresh without polling. Runs on
 * an interval (and once at boot) because the things it reconciles against all drift on their own clock, repos
 * appear via clone, capabilities connect/disconnect, a hook gets hand-deleted on the provider.
 *
 * Registration is best-effort per repo, the setupGitAccess posture: a refusal (github classic PAT without
 * admin:repo_hook / fine-grained without "Webhooks: write"; gitlab below Maintainer) or a sandbox with no
 * public URL degrades that repo to a WARNING carrying the manual recipe, the exact URL + secret to paste into
 * the repo's webhook settings, surfaced on GET /ci/runs where the Pipelines view renders it inline.
 *
 * A repo that unmaps while its account is still connected gets its hook removed on the next pass. A REMOVED
 * capability keeps its hooks on the provider (no token left to delete them with); deliveries then fail and the
 * provider auto-disables the hook, the same "stale key on the account" trade teardownGitAccess accepts when
 * the network is gone. */

const RECONCILE_INTERVAL_MS = 10 * 60_000;

// One vendor-kind receiver path, the webhook route verifies per vendor, and the project is identified from
// the payload, so every repo of a host shares the same delivery URL (which is also each hook's identity).
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

export interface CiHookReconciler {
    readonly start: () => void;
    readonly stop: () => void;
    // One reconcile pass; `start` runs it immediately and then on the interval. Exposed for tests and callers
    // that just changed what a pass reconciles against (a capability apply).
    readonly reconcile: () => Promise<void>;
    // repo → why its hook isn't live + the manual recipe. Empty ⇒ every mapped repo is wired.
    readonly warnings: () => ReadonlyMap<string, string>;
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
    const warnings = new Map<string, string>();
    // What the previous pass had wired, keyed host+project, how an unmapped repo's hook gets noticed.
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
                warnings.set(project.repo, `Pipeline webhooks are off: this sandbox has no public URL for the provider to deliver to.`);
                continue;
            }
            const url = webhookUrlFor(publicUrl, project.account.provider);
            try {
                await ciClientFor(project.account.provider, fetchFn).ensureHook(project, { url, secret });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                warnings.set(
                    project.repo,
                    `Pipeline webhook registration failed: ${reason}. ${scopeHint(project)}. ${manualRecipe(project, url, secret)}`,
                );
            }
        }
        // Unmapped while the account survived: the hook would keep delivering events for a repo the workspace
        // no longer has, so it goes. Account gone too ⇒ nothing to delete with; the provider disables it.
        for (const [key, project] of wired) {
            if (!next.has(key) && publicUrl !== "") {
                await ciClientFor(project.account.provider, fetchFn)
                    .removeHook(project, webhookUrlFor(publicUrl, project.account.provider))
                    .catch((error: unknown) => services.logger.warn({ err: error, repo: project.repo }, "ci: stale hook removal failed"));
            }
        }
        wired = next;
    };

    // Serialized: a manual reconcile during the interval's pass must not race two hook lists.
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
