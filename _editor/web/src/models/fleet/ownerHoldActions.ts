import { keepDeletedPrompt } from "@intentic/sandbox-contract/events/land-conflict";
import type { LandResult } from "@intentic/sandbox-contract/schemas/agents";
import { t } from "@intentic/ui/i18n";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { fileName, pathsByRepo, type OwnerHold } from "../conversations/review/ownerHold";
import { askAgentToResolve, invalidateAgentAction, landAgent, type ResolveAsk } from "./agentActions";

type Reach = string | undefined;

// Exactly these paths of one repo, committed as they stand. A commit records the whole index (git.routes.ts), so
// anything else already staged would ride along under this commit's message: refused before anything is staged, for
// the owner to commit or unstage first.
// `otherStaged` words that refusal for the press that made it.
export const commitOnly = async (
    repo: string,
    paths: readonly string[],
    message: string,
    at: Reach,
    otherStaged: (count: number) => string = (count) => t(`agents.useAgentChanges.otherStaged`, { count }, count),
): Promise<void> => {
    if (paths.length === 0) {
        return;
    }
    const { repos } = await sandboxRpc.git.changes(undefined, { context: { at } });
    const entry = repos.find((held) => held.repo === repo);
    const wanted = new Set(paths);
    const others = (entry?.staged ?? []).filter((change) => !wanted.has(change.path)).length + (entry?.truncated?.staged ?? 0);
    if (others > 0) {
        throw new Error(otherStaged(others));
    }
    await sandboxRpc.git.commit({ repo, message, stage: { paths: [...paths] } }, { context: { at } });
};

// "Keep deleted": the owner's deletion committed, file for file and nothing else, then the agent asked to drop its own
// changes to those files on its copy (keepDeletedPrompt), and the turn's end lands the rest. The commit comes first so
// the agent rebases onto a main line that already says the files are gone; a send that then fails leaves only a
// deletion the owner chose, and a card whose next land names the clash for the agent to resolve.
export const keepDeleted = async (id: string, hold: OwnerHold, mainBranch: string | undefined): Promise<ResolveAsk> => {
    for (const [repo, paths] of pathsByRepo(hold.blockers)) {
        const [only] = paths;
        const message = paths.length === 1 && only !== undefined ? `Delete ${fileName(only)}` : `Delete ${paths.length} files`;
        await commitOnly(repo, paths, message, undefined, (count) => t(`agents.agentCard.otherStagedDeletion`, { count }, count));
    }
    await invalidateAgentAction(id);
    return askAgentToResolve(id, keepDeletedPrompt(hold.blockers, mainBranch));
};

// "Restore & land": the deleted files put back as last committed (the daemon checkpoints the tree first, so even this
// is on the timeline), then the land the deletion was holding, the agent's edits to them included.
export const restoreAndLand = async (id: string, hold: OwnerHold, at: Reach): Promise<LandResult> => {
    for (const [repo, paths] of pathsByRepo(hold.blockers)) {
        await sandboxRpc.git.discard({ repo, paths: [...paths] }, { context: { at } });
    }
    const result = await landAgent(id, `check`, undefined, false, at);
    await invalidateAgentAction(id, at);
    return result;
};
