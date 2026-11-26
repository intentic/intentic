import { CiRateLimited } from "./refusals.js";
import type { ForgeProject } from "./projects.js";
import type { ForgeClient } from "./client.js";
import type { FetchFn } from "./http.js";

// CI operations share the account's rate limit. Repository creation and deployment reports handle each request independently.

// When each account's limit lifts, kept per transport like the job lists, so one test's stand-in never cools another's.
// An account is its API and its token: the limit is the token's, whichever repository asked.
const cooldowns = new WeakMap<FetchFn, Map<string, number>>();

// The client with the cooldown in front: while an account's limit is spent, every call on it fails at once with the same
// typed refusal instead of spending a request the forge will refuse, so the poller, the hook reconcile and the board's
// backfill all wait it out without each knowing about it.
export const cooled = (client: ForgeClient, fetchFn: FetchFn): ForgeClient => {
    const held = cooldowns.get(fetchFn) ?? new Map<string, number>();
    cooldowns.set(fetchFn, held);
    const guard =
        <A extends unknown[], R>(call: (project: ForgeProject, ...rest: A) => Promise<R>) =>
        async (project: ForgeProject, ...rest: A): Promise<R> => {
            const account = `${project.account.apiBase}\n${project.account.token}`;
            const until = held.get(account);
            if (until !== undefined && Date.now() < until) {
                throw new CiRateLimited(`${project.account.host}'s API`, until);
            }
            held.delete(account);
            try {
                return await call(project, ...rest);
            } catch (error) {
                if (error instanceof CiRateLimited) {
                    held.set(account, Math.max(held.get(account) ?? 0, error.until));
                }
                throw error;
            }
        };
    return {
        createRepository: client.createRepository,
        reportDeployment: client.reportDeployment,
        listRuns: guard(client.listRuns),
        failedJobs: guard(client.failedJobs),
        failedSteps: guard(client.failedSteps),
        passedJobs: guard(client.passedJobs),
        run: guard(client.run),
        dispatch: guard(client.dispatch),
        allJobs: guard(client.allJobs),
        workflowSource: guard(client.workflowSource),
        jobLog: guard(client.jobLog),
        rerun: guard(client.rerun),
        rerunFailed: guard(client.rerunFailed),
        annotations: guard(client.annotations),
        cancel: guard(client.cancel),
        ensureHook: guard(client.ensureHook),
        removeHook: guard(client.removeHook),
        repository: guard(client.repository),
        projectUrl: client.projectUrl,
    };
};
