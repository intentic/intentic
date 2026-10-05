import { join } from "node:path";
import { type GitRunner, politeGit } from "@intentic/scaffold";
import type { Logger } from "pino";
import type { Chore } from "../../system/chore-clock.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";
import { maintenanceMayRun } from "./maintenance.js";
import { type GitQuietProbe, waitForNoGit } from "./stale-git-locks.js";

// THE DAILY GC (2026-10-05). The hourly maintenance (maintenance.ts) packs and indexes but never prunes, so objects
// nothing reaches any more (a dropped branch's, a parked ref's once its retention lets it go:
// conversations/land/parked-ref-retention.ts) stayed for good. Once a day per repo, only while no turn is live (a gc
// rewrites every pack and can stall a live git), and only at a moment no other git is running, if /proc can say. It goes
// through `maintenance run --task=gc` so it takes the same maintenance.lock as the hourly tasks instead of racing them.
// Unreachable objects are kept for two weeks: git's own default, said here so a repo's config cannot shorten it.

// The clock's unit, spelled here: a value import from system/ would close a cycle (system/ imports git/).
const DAY_MS = 24 * 60 * 60_000;

export const GC_PRUNE_EXPIRE = "2.weeks.ago";

// How long to look for a moment with no git running before this repo waits for tomorrow.
const QUIET_POLLS = 10;
const QUIET_POLL_MS = 3000;

export interface GitGcDeps extends GitQuietProbe {
    readonly workspace: WorkspacePaths;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly conversations: { readonly liveSessionIds: () => readonly string[] };
    readonly git?: GitRunner;
    readonly pollMs?: number;
}

const idle = (deps: GitGcDeps): boolean => deps.conversations.liveSessionIds().length === 0;

export const gcArgs = (): readonly string[] => ["-c", `gc.pruneExpire=${GC_PRUNE_EXPIRE}`, "maintenance", "run", "--task=gc", "--quiet"];

// One pass over the root repo and every nested one, sequential; one repo's failure costs only itself.
export const runGitGc = async (deps: GitGcDeps): Promise<void> => {
    const { logger } = deps;
    const now = deps.now ?? Date.now;
    const repos = ["root", ...(await discoverRepos(deps.workspace.root))];
    for (const [index, repo] of repos.entries()) {
        // Read again before each repo: a turn that started during the last one's gc has the machine now.
        if (!idle(deps)) {
            logger.info({ left: repos.slice(index) }, "git gc: a turn started, the remaining repos wait for the next run");
            return;
        }
        const dir = repo === "root" ? deps.workspace.root : join(deps.workspace.root, repo);
        let from: number | undefined;
        try {
            if (!(await maintenanceMayRun(dir, repo, logger, deps))) {
                continue;
            }
            if ((await waitForNoGit(deps, QUIET_POLLS, deps.pollMs ?? QUIET_POLL_MS)) === true) {
                logger.info({ repo }, "git gc: another git kept running, this repo waits for the next run");
                continue;
            }
            from = now();
            await (deps.git ?? politeGit)(dir, gcArgs());
            logger.info({ repo, ms: now() - from, prune: GC_PRUNE_EXPIRE }, "git gc: ran");
        } catch (error) {
            logger.warn({ err: error, repo, ...(from === undefined ? {} : { ms: now() - from }) }, "git gc: failed");
        }
    }
};

export const gitGcChore = (deps: GitGcDeps): Chore => ({
    name: "git-gc",
    everyMs: DAY_MS,
    when: () => idle(deps),
    run: () => runGitGc(deps),
});
