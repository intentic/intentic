import type { Services } from "../../composition.js";
import { agentRepoChanges } from "./agent-changes.js";
import type { IsolatedAgent } from "../registry/agents-store.js";

// Workspace-relative, not repo-relative: git answers per repo, so joining onto the repo id (its own directory) is what
// lets a path rule see the owner's own file tree. Only called when a rule actually narrows by path.
export const landingPaths = async (
    services: Pick<Services, "agentWorktrees" | "logger">,
    agent: IsolatedAgent,
    span: readonly { readonly repo: string }[],
): Promise<readonly string[]> => {
    const perRepo = await Promise.all(
        span.map(async ({ repo }) => {
            const composed = agent.repos.find((entry) => entry.repo === repo);
            if (composed === undefined) {
                return [];
            }
            try {
                const changes = await agentRepoChanges(services.agentWorktrees, agent, composed, "outstanding");
                return changes.map((change) => (repo === "root" ? change.path : `${repo}/${change.path}`));
            } catch (error) {
                // No paths for an unreadable repo: every condition fails, holding work the owner can release by hand.
                services.logger.warn({ err: error, repo, agent: agent.id }, "landing paths: repo unreadable, treating as no match");
                return [];
            }
        }),
    );
    return perRepo.flat();
};
