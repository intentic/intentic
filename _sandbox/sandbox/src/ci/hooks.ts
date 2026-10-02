import { serialLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { CiStore } from "./ci-store.js";
import { ciClientFor, CiRateLimited, type FetchFn } from "./providers.js";
import { ciProjects, type CiProject } from "./projects.js";

// Reconciles each mapped repo's CI webhook against this sandbox's public receiver, on an interval and at boot since
// repos, accounts and hooks drift independently. A failed registration or missing public URL degrades a repo to a
// WARNING with the manual recipe (GET /ci/runs); an unmapped repo's hook is removed only while its account stays
// connected. Each pass also learns what the forge says of each repository (its id, where it lives now, its default
// branch) into the CI store, which deliveries are matched by (webhook.routes.ts) and main's line is read from
// (main-line.ts).

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

// When a spent rate limit lifts, in the words a warning reads it by.
const liftsAt = (until: number): string => `${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// Why the vendor refused, in words: its status, never its response body. A 404 or 403 on the hooks API is almost always
// a token without admin rights on the repository (or a repository that is not yours), which the vendor will not say;
// a spent rate limit is the one 403 that says so in its headers (providers.ts), and is nothing about rights.
const refusalOf = (error: unknown): string => {
    if (error instanceof CiRateLimited) {
        return `the connected token's API rate limit is spent until ${liftsAt(error.until)}`;
    }
    const status = /\((\d{3})\)/.exec(errorMessage(error))?.[1];
    if (status === "401") {
        return "the connected token was refused";
    }
    if (status === "403" || status === "404") {
        return "the connected token has no admin rights on it";
    }
    return status === undefined ? "the request did not go through" : `the request was refused (${status})`;
};

// The warning a refused registration leaves. A spent limit says nothing of the token's rights, so the scope hint would
// send the owner the wrong way.
const refused = (project: CiProject, refusal: string, limited: boolean, url: string, secret: string): HookWarning => ({
    reason: `Can't register a pipeline webhook on ${project.project}: ${refusal}${limited ? "" : `; ${scopeHint(project)}`}. Its runs are polled instead, so they show up a little later.`,
    recipe: manualRecipe(project, url, secret),
});

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

    // What the forge says of the repository now, kept for the deliveries to be matched by; best-effort, since the hook
    // itself does not need it. A remote naming an old path still works through the forge's redirects, which is exactly
    // why nothing else would ever say so.
    const learn = async (project: CiProject): Promise<void> => {
        try {
            const repository = await ciClientFor(project.account.provider, fetchFn).repository(project);
            await services.ciStore.learnForge(project.repo, project.project, repository);
            if (repository.path.toLowerCase() !== project.project.toLowerCase()) {
                services.logger.warn(
                    { repo: project.repo, remote: project.project, path: repository.path },
                    "ci: the repository's remote names it by an old path",
                );
            }
        } catch (error) {
            services.logger.warn({ err: error, repo: project.repo }, "ci: the repository could not be read");
        }
    };

    const reconcileOnce = async (): Promise<void> => {
        const projects = await ciProjects(services);
        const publicUrl = services.config.sandbox.publicUrl;
        const secret = await services.ciStore.secret();
        // A repo the last pass covered keeps what it found while the limit is spent: nothing new is known of it.
        const before = new Map(warnings);
        const covered = new Set([...wired.values()].map((project) => project.repo));
        warnings.clear();
        const next = new Map<string, CiProject>();
        for (const project of projects) {
            next.set(`${project.account.provider}\n${project.project}`, project);
            await learn(project);
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
                const limited = error instanceof CiRateLimited;
                const warning =
                    limited && covered.has(project.repo) ? before.get(project.repo) : refused(project, refusalOf(error), limited, url, secret);
                if (warning !== undefined) {
                    warnings.set(project.repo, warning);
                }
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
