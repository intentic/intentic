import type { AgentDomainPolicy } from "@intentic/sandbox-contract";

export const AGENT_DOMAIN_NOT_READY =
    "The unprivileged agent domain is not available in this build yet. Turns, Bash panes and the agent's home are placed in it, but it has not been verified in a live sandbox, and the daemon still runs some agent-reachable work as root: condition watches, panels, the desktop, and git in repositories an agent creates. Agent execution is refused rather than run as root.";

// Remove this stop only once every way agent work reaches a process runs inside the domain, and a live sandbox has shown
// it (plan: omen, a throwaway container). Placement alone is not a boundary: accepting the policy while any of these
// still run as root would promise a protection that does not exist. What is placed: a turn's runtime (Claude Code only;
// stream-agent.ts refuses the rest), its Bash panes (terminal/pane-door.ts) and its HOME (agent-home.ts). What is not:
//   - condition watches and checks the daemon re-runs after a turn (agent/verification/watch-check.ts);
//   - panels, the desktop's `open`, the tsgo checker, the peer runner and extension processes an agent starts;
//   - the title namer and cache keep-warm, which refuse unprivileged execution instead (agent-execution.ts);
//   - the daemon's own git in a repository the agent created after its domain was built: its config and hooks are the
//     agent's to write, and the daemon's `git status` runs the filters such a config names (agent-domain-view.ts).
export const requireAgentDomainRollout = (policy: AgentDomainPolicy): void => {
    if (policy.agentDomain !== "root") {
        throw new Error(AGENT_DOMAIN_NOT_READY);
    }
};
