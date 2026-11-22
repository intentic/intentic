import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import { coneForScope, scopedComposition } from "./worktree-cone.js";
import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import type { GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { branchSha } from "../../git/agent-refs.js";
import { checkoutCost } from "../../system/resources/storage/checkout-cost.js";
import { buildOutputEstimate } from "./build-outputs/build-output-estimate.js";
import { reserveCheckoutSpace } from "../../system/resources/storage/checkout-admission.js";
import { CheckoutSpaceRefused, type HistorySpace } from "../../system/resources/storage/checkout-space.js";

interface CompositionRepo {
    readonly repo: string;
    readonly base: string | undefined;
}

export interface CompositionSpaceOptions {
    readonly mainDir: (repo: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly head: (repo: string) => Promise<string | undefined>;
    readonly git: GitRunner;
    readonly logger: Logger;
    readonly historyRoot: string;
    readonly historySpace?: () => Promise<HistorySpace>;
    // What a checkout of the repository at main's dir grows to in build output; build-output-estimate.ts by default.
    readonly buildOutputs?: (mainDir: string) => Promise<number>;
    // Whether the checkout's builds run on this disk. A runner's mirror (false) holds only the files the runner sends
    // back: its builds fill the runner's disk, and the runner prices its own checkout against that disk when it opens
    // it. On 2026-11-12 a turn sent to omen was refused for rog's disk, because rog's own main `target/` (about 115 GB)
    // was counted for a mirror that never builds.
    readonly buildsHere?: boolean | undefined;
    // Null disables the warn-once escape for automated starts; undefined preserves the conversation's owner key.
    readonly admissionOwner?: string | null | undefined;
}

export interface CompositionCost {
    readonly repo: string;
    readonly files: number;
    readonly buildOutput: number;
    readonly bytes: number;
}

/** The same per-repository bytes used by admission, exposed for the spawn note. */
export const estimateCompositionCosts = async (
    id: string,
    recorded: readonly { repo: string }[],
    live: readonly CompositionRepo[],
    options: CompositionSpaceOptions,
    fence?: Fence,
    scope?: Fence,
    forceMissing = false,
    preferLiveBase = false,
): Promise<readonly CompositionCost[]> => {
    const { mainDir, worktreeDir, git, logger, head } = options;
    const buildOutputs = options.buildOutputs ?? ((dir: string) => buildOutputEstimate(dir));
    const buildsHere = options.buildsHere ?? true;
    const candidates = [...new Set([...recorded.map(({ repo }) => repo), ...live.map(({ repo }) => repo)])];
    const missing = forceMissing ? candidates : await Promise.all(candidates.map(async (repo) => {
        const present = await pathExists(recorded.some((entry) => entry.repo === repo) ? worktreeDir(id, repo) : join(worktreeDir(id, repo), ".git"));
        return present ? undefined : repo;
    }));
    const costs = await Promise.all(missing.filter((repo): repo is string => repo !== undefined).map(async (repo) => {
        const own = preferLiveBase ? undefined : await branchSha(mainDir(repo), `agent/${id}`, git).catch((error) => {
            logger.warn({ err: error, repo }, "agents: could not size a retired checkout's branch");
            return undefined;
        });
        const sha = own ?? live.find((entry) => entry.repo === repo)?.base ?? (await head(repo));
        if (sha === undefined) {
            return undefined;
        }
        const cone = coneForScope(fence, scope, repo);
        const files = await checkoutCost(mainDir(repo), sha, git, cone).catch((error: Error) => {
            logger.warn({ err: error, repo }, "agents: could not size a checkout before writing it");
            return undefined;
        });
        if (files === undefined) {
            return undefined;
        }
        const buildOutput = buildsHere ? await buildOutputs(mainDir(repo)) : 0;
        return { repo, files, buildOutput, bytes: files + buildOutput };
    }));
    return costs.filter((cost): cost is CompositionCost => cost !== undefined);
};

// Reserve only the checkouts ensure will write. Standing ones need no space reading or tree-size walk.
export const reserveCompositionSpace = async (
    id: string,
    recorded: readonly { repo: string }[],
    live: readonly CompositionRepo[],
    options: CompositionSpaceOptions,
    fence?: Fence,
    scope?: Fence,
): Promise<() => void> => {
    const { historyRoot, historySpace, logger } = options;
    const costs = await estimateCompositionCosts(id, recorded, live, options, fence, scope);
    if (costs.length > 0) {
        try {
            return await reserveCheckoutSpace(
                historyRoot,
                costs.reduce((total, cost) => total + cost.bytes, 0),
                historySpace,
                options.admissionOwner === undefined ? id : options.admissionOwner ?? undefined,
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
    scope?: Fence,
): readonly CompositionRepo[] => {
    const picked = selection === undefined ? available : available.filter(({ repo }) => repo === "root" || selection.includes(repo));
    const reachable = new Set(scopedComposition(fence, scope, picked.map(({ repo }) => repo)));
    return picked.filter(({ repo }) => reachable.has(repo));
};
