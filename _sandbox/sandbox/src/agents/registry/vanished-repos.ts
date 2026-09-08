import type { Logger } from "pino";
import { pathExists } from "../../path-exists.js";
import type { AgentsRegistry } from "./agents-registry.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Drops a repo from every conversation once its directory is gone; composition is frozen at first turn, so deletion is
// the one change it can't absorb. Only this pass decides gone, by checking disk for named repos; a repo-set change just
// triggers a re-check, and root is never a candidate. A repo whose `.git` alone vanishing still counts as present.

export interface VanishedRepoDeps {
    readonly agents: Pick<AgentsRegistry, "ids" | "entry" | "dropRepos">;
    readonly agentWorktrees: Pick<AgentWorktrees, "mainDir" | "reapRepoCheckout">;
    readonly logger: Logger;
}

// "root" is the workspace repo itself (worktrees.mainDir); it can never vanish.
const ROOT = "root";

// One pass; returns the repos it dropped. Costs one `access` per distinct named repo when nothing is gone. Archived
// conversations are swept alongside live ones, since an archived agent is a likely holder of an unused repo's row.
export const dropVanishedRepos = async (deps: VanishedRepoDeps): Promise<string[]> => {
    const { agents, agentWorktrees, logger } = deps;
    const named = new Map<string, string[]>();
    for (const id of agents.ids()) {
        for (const { repo } of agents.entry(id)?.repos ?? []) {
            if (repo !== ROOT) {
                named.set(repo, [...(named.get(repo) ?? []), id]);
            }
        }
    }
    const gone: string[] = [];
    for (const [repo, ids] of named) {
        if (await pathExists(agentWorktrees.mainDir(repo))) {
            continue;
        }
        gone.push(repo);
        // Reap checkouts before the row drops, so nothing else touches a dead checkout meanwhile.
        for (const id of ids) {
            await agentWorktrees.reapRepoCheckout(id, repo);
        }
    }
    if (gone.length === 0) {
        return [];
    }
    const touched = await agents.dropRepos(gone);
    logger.warn({ repos: gone, conversations: touched }, "agents: dropped repos that have left the workspace from every composition");
    return gone;
};

// Runs at startup and on every repo-set change, converging a deletion within seconds. Chained, not concurrent, so
// passes cannot race the same reap; `.then(run, run)` stops a failed pass poisoning the chain. Returns the unsubscribe.
export const startVanishedRepoSweep = (
    deps: VanishedRepoDeps,
    subscribe: (listener: (repos: readonly string[]) => void) => () => void,
): (() => void) => {
    let sweeps: Promise<unknown> = Promise.resolve();
    const run = (): Promise<unknown> =>
        dropVanishedRepos(deps).catch((error: unknown) => deps.logger.warn({ err: error }, "agents: vanished-repo sweep failed"));
    const sweep = (): void => {
        sweeps = sweeps.then(run, run);
    };
    sweep();
    return subscribe(sweep);
};
