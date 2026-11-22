import { defaultGit } from "@intentic/base/git";
import type { Services } from "../../../composition.js";
import { worktreeOf } from "../../../conversations/registry/agents-store.js";
import { conversationFence } from "../../../areas/area-scope.js";
import { readHistorySpace } from "../../../system/resources/storage/checkout-admission.js";
import { largestCheckoutFolders } from "../../../system/resources/storage/checkout-cost.js";
import { buildOutputEstimate } from "../../../conversations/worktrees/build-outputs/build-output-estimate.js";
import { estimateCompositionCosts, selectedComposition } from "../../../conversations/worktrees/composition-space.js";
import { fanOutCostNote } from "../../../conversations/worktrees/build-outputs/fan-out-cost-note.js";
import type { ChildSpawnSpec } from "../children.js";

const NOTE_BUDGET_MS = 2_000;

const calculateNote = async (services: Services, parent: string, id: string, spec: ChildSpawnSpec): Promise<string | undefined> => {
    const parentEntry = services.agents.entry(parent);
    const parentWorktree = worktreeOf(parentEntry);
    const available = parentWorktree?.repos.length ? parentWorktree.repos : await services.agentWorktrees.snapshot();
    const selection = parentWorktree?.composition?.repos;
    const fence = conversationFence(await services.areas.list(), parentEntry?.identity);
    const live = selectedComposition(available, selection, fence, spec.paths);
    const { agentWorktrees, config, logger } = services;
    const costs = await estimateCompositionCosts(id, [], live, {
        mainDir: agentWorktrees.mainDir,
        worktreeDir: agentWorktrees.worktreeDir,
        head: async (repo) => available.find((entry) => entry.repo === repo)?.base,
        git: defaultGit,
        logger,
        historyRoot: config.historyRoot,
        buildsHere: true,
        buildOutputs: buildOutputEstimate,
    }, fence, spec.paths, true, true);
    const bytes = costs.reduce((sum, cost) => sum + cost.bytes, 0);
    const space = await readHistorySpace(config.historyRoot);
    if (fanOutCostNote({ bytes, space, largestFolders: [], pathsGiven: spec.paths !== undefined }) === undefined) {
        return undefined;
    }
    const shaByRepo = new Map(available.map(({ repo, base }) => [repo, base]));
    const largest = (await Promise.all(costs.map(async ({ repo }) => {
        const sha = shaByRepo.get(repo);
        if (sha === undefined) {return [];}
        return (await largestCheckoutFolders(agentWorktrees.mainDir(repo), sha, defaultGit)).map((folder) => ({
            path: repo === "root" ? folder.path : `${repo}/${folder.path}`,
            bytes: folder.bytes,
        }));
    }))).flat().sort((left, right) => right.bytes - left.bytes).slice(0, 3);
    return fanOutCostNote({ bytes, space, largestFolders: largest, pathsGiven: spec.paths !== undefined });
};

/** Adds a bounded, best-effort estimate to an accepted local spawn; storage trouble never holds the spawn. */
export const spawnCheckoutCostNote = async (services: Services, parent: string, id: string, spec: ChildSpawnSpec): Promise<string | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            calculateNote(services, parent, id, spec),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), NOTE_BUDGET_MS);
                timer.unref?.();
            }),
        ]);
    } catch (err) {
        services.logger.warn({ err, parent, id }, "agents: checkout cost note could not be calculated");
        return undefined;
    } finally {
        if (timer !== undefined) {clearTimeout(timer);}
    }
};
