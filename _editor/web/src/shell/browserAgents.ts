import { turnWorking } from "../features/agents/fleet/agentStatus";
import { agentById } from "../features/agents/fleet/useAgents-fleet";
import { provideAgentTurns } from "../features/browsers/agentTurns";

/**
 * Tells the browser view about the agents behind its windows, from the board: whose turn is running and what each
 * conversation is called. Wired here, above both features, because the two reach each other the other way round.
 */
export const startBrowserAgents = (): void =>
    provideAgentTurns({
        running: (conversation) => {
            const agent = agentById(conversation);
            return agent !== undefined && turnWorking(agent);
        },
        title: (conversation) => agentById(conversation)?.title,
    });
