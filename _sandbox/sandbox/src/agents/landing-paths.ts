import type { Services } from "../composition.js";
import { agentRepoChanges } from "./agent-changes.js";
import type { IsolatedAgent } from "./agents-store.js";

/* WHAT A FINISHED AGENT CHANGED, as workspace-relative paths, the fact a landing rule narrows on when it says
 * "hold anything that touches the database".
 *
 * WORKSPACE-RELATIVE, not repo-relative, and that is the whole reason this is a function rather than a `.map`
 * at the call site. Git answers in paths relative to the repo it was asked about, so the same file is
 * `src/db/schema.ts` in a sub-repo and `api/src/db/schema.ts` from where the owner is standing. A rule table
 * where `api/**` matched at one moment and not at another would be worse than no conditions at all, so every
 * moment feeds conditions the same spelling: the one the owner sees in their own file tree. Repo ids ARE their
 * directory under the workspace root (worktrees.mainDir), which is what makes the join exact rather than a
 * guess.
 *
 * ONLY CALLED WHEN A RULE ACTUALLY NARROWS BY PATH. It is a git pass per repo of the composition, so an empty
 * table and the ordinary "land everything" rule never pay for it. */
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
                /* A repo that cannot be read answers with NO paths, which fails every path condition and so
                 * leaves the work held. Deliberate: the alternative is a git failure quietly widening a rule
                 * that exists to hold things back, and of the two ways to be wrong here, holding work the owner
                 * then releases by hand is the one they can undo. */
                services.logger.warn({ err: error, repo, agent: agent.id }, "landing paths: repo unreadable, treating as no match");
                return [];
            }
        }),
    );
    return perRepo.flat();
};
