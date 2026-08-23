import { access } from "node:fs/promises";
import type { Logger } from "pino";
import type { AgentsRegistry } from "./agents-registry.js";
import type { AgentWorktrees } from "./worktrees.js";

/* WHEN A REPO LEAVES THE WORKSPACE, taking it out of every conversation that still names it.
 *
 * A conversation's composition is FROZEN at its first turn (worktrees.ts): repos cloned later never join it,
 * which is what keeps a long-running conversation's diff, land and standing all talking about the same set of
 * repos. Deletion is the one change that freeze cannot absorb. The row stays, so every per-repo pass keeps
 * running git in a directory that is not there, and each pass fails in its own way:
 *
 *   · the Changes review logs one warning per repo per poll and shows the agent nothing
 *   · archiving has nothing it can preserve, so it says so per repo and reclaims the rest (worktrees.ts
 *     repoBehind), which is the right answer for one archive and no answer at all for the row itself
 *   · the fleet's standing sweep threw, and since every turn's `finally` awaits it, ONE deleted repo named by
 *     ONE conversation ended every conversation's turn with `fatal: cannot change to` that repo's path
 *
 * That last one is what a workspace actually experiences: hours after deleting a clone nobody was using, every
 * session in the fleet dies at the end of its turn, naming a repo the conversation had never touched. Each of
 * those passes is now tolerant on its own (that is the fix for the blast radius), and this is the fix for the
 * cause: the row goes, once, and none of them is ever asked the question again.
 *
 * WHO DECIDES A REPO IS GONE. Not the repo-set frame that triggers this, and deliberately so: discovery is a
 * filesystem walk that answers with what it could read, so a momentary failure would report a shrunken
 * workspace, and acting on that reading would strip live repos out of every conversation on the board. The
 * trigger only says "look again"; the authority is this pass asking the DISK about the specific repos
 * conversations name. Root is never a candidate: it is the workspace itself, so its absence is never a
 * deleted repo.
 *
 * The test is DELETION, the directory itself being gone, and not the weaker "git will not answer in it": those
 * are different events with different right answers. A repo whose `.git` went while its files stayed has not
 * left the workspace, it has dissolved into the root scope (history.ts says so about the same case), and its
 * files are still the agent's to work on; every per-repo pass tolerates it now, so nothing is broken by
 * leaving the row alone. Whereas a directory that is not there cannot come back as the same repo. It is the
 * same line history.ts draws one layer down, and it draws it first: a worktree that is gone means the repo is
 * gone, and the real git dir is moved to the trash rather than deleted (reapGitDir). So by the time this runs
 * there is normally no object store left to be careful about, and the checkouts it reclaims go to the same
 * trash for the same reason.
 */

export interface VanishedRepoDeps {
    readonly agents: Pick<AgentsRegistry, "ids" | "entry" | "dropRepos">;
    readonly agentWorktrees: Pick<AgentWorktrees, "mainDir" | "reapRepoCheckout">;
    readonly logger: Logger;
}

// "root" is the /work workspace repo itself (worktrees.mainDir), never a repo that can vanish.
const ROOT = "root";

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

/* One pass. Returns the repos it dropped, empty in the steady state, which is every run but the one after a
 * deletion: the cost of finding nothing is one `access` per distinct repo any conversation names, and no git
 * at all.
 *
 * Archived conversations are swept alongside live ones. Their rows are what a restore, a land or the archive's
 * own purge would read next, and an archived agent is the most likely holder of a row for a repo nobody has
 * used in a while, which is exactly the repo somebody deletes. */
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
        if (await exists(agentWorktrees.mainDir(repo))) {
            continue;
        }
        gone.push(repo);
        // The checkouts go BEFORE the rows do. While a row still names the repo, nothing else will touch its
        // dead checkout; the moment the row is gone, the only thing left that knows the directory exists is
        // the root branch's `add -A` (see worktrees.reapRepoCheckout on what that would commit).
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

/* The trigger, and the serialization the trigger needs. Runs once now, for a deletion that happened while this
 * daemon was not running, and again on every repo-set change (workspace/repo-watch.ts), which is what makes a
 * deletion converge in seconds rather than at the next boot.
 *
 * Chained rather than concurrent: two passes over the same conversations would both find the same dead repo,
 * and the second's reap would race the first's. `.then(run, run)` so one failed pass does not poison the chain.
 * Returns the unsubscribe, for the daemon's shutdown list. */
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
