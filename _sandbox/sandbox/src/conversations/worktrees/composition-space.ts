import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import { fencedComposition } from "./worktree-cone.js";
import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import type { GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { branchSha } from "../../git/agent-refs.js";
import { checkoutCost } from "../../system/resources/storage/checkout-cost.js";
import { reserveCheckoutSpace } from "../../system/resources/storage/checkout-admission.js";
import { CheckoutSpaceRefused, type HistorySpace } from "../../system/resources/storage/checkout-space.js";

interface CompositionRepo {
    readonly repo: string;
    readonly base: string | undefined;
}

interface CompositionSpaceOptions {
    readonly mainDir: (repo: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly head: (repo: string) => Promise<string | undefined>;
    readonly git: GitRunner;
    readonly logger: Logger;
    readonly historyRoot: string;
    readonly historySpace?: () => Promise<HistorySpace>;
}

// Reserve only the checkouts ensure will write. Standing ones need no space reading or tree-size walk.
export const reserveCompositionSpace = async (
    id: string,
    recorded: readonly { repo: string }[],
    live: readonly CompositionRepo[],
    options: CompositionSpaceOptions,
): Promise<() => void> => {
    const { mainDir, worktreeDir, git, logger, head, historyRoot, historySpace } = options;
    const candidates = [...new Set([...recorded.map(({ repo }) => repo), ...live.map(({ repo }) => repo)])];
    const missing = (
        await Promise.all(
            candidates.map(async (repo) =>
                (await pathExists(recorded.some((entry) => entry.repo === repo) ? worktreeDir(id, repo) : join(worktreeDir(id, repo), ".git")))
                    ? undefined
                    : repo,
            ),
        )
    ).filter((repo): repo is string => repo !== undefined);
    if (missing.length > 0) {
        const costs = await Promise.all(
            missing.map(async (repo) => {
                // A retired branch can hold more than today's HEAD; size the commit that will actually attach.
                const own = await branchSha(mainDir(repo), `agent/${id}`, git).catch((error) => {
                    logger.warn({ err: error, repo }, "agents: could not size a retired checkout's branch");
                    return undefined;
                });
                const sha = own ?? live.find((entry) => entry.repo === repo)?.base ?? (await head(repo));
                if (sha === undefined) {
                    return undefined;
                }
                // A size that could not be read is left out rather than failing the turn: the guard is for a disk known
                // to be short, and a checkout of unknown size still meets the floor below.
                return await checkoutCost(mainDir(repo), sha, git).catch((error: Error) => {
                    logger.warn({ err: error, repo }, "agents: could not size a checkout before writing it");
                    return undefined;
                });
            }),
        );
        const known = costs.filter((cost) => cost !== undefined);
        try {
            return await reserveCheckoutSpace(
                historyRoot,
                known.reduce((total, cost) => total + cost, 0),
                historySpace,
            );
        } catch (error) {
            if (error instanceof CheckoutSpaceRefused) {
                throw error;
            }
            // A volume that could not be measured is not known to be full: the turn goes ahead, and says why in the log.
            logger.warn({ err: error }, "agents: could not read the history volume's free space; checking out anyway");
        }
    }
    return () => {};
};

export const selectedComposition = (
    available: readonly CompositionRepo[],
    selection: readonly string[] | undefined,
    fence: Fence,
): readonly CompositionRepo[] => {
    const picked = selection === undefined ? available : available.filter(({ repo }) => repo === "root" || selection.includes(repo));
    const reachable = new Set(
        fencedComposition(
            fence,
            picked.map(({ repo }) => repo),
        ),
    );
    return picked.filter(({ repo }) => reachable.has(repo));
};
