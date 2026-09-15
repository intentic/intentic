// Identity every daemon-authored commit carries; one source so history reads consistently across routes.
// Above the subsystems rather than inside git/, because seven of them commit as the agent (workspace, history,
// inventory, portability, agents/land, scaffold, git) and a constant owned by one of them makes the others import it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;
