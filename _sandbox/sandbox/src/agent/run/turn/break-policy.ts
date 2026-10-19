import type { TurnBreak, TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../composition.js";

// The one reader for every ending's question. Two callers must agree about the same turn — the failure frame promises
// what happens next, and the pass below performs it — so both come through here. Per-conversation override wins;
// absent, the sandbox-wide policy answers. Asked fresh at the moment it matters (the window opening, the rung falling
// due), never snapshotted at the failure, so a mind changed in between is honoured; the one exception is the limit's
// move, booked once at the failure (agent.routes) so the request's message and the fire cannot disagree.
export const breakPolicyFor = async (
    services: Pick<Services, "agents" | "sandboxSettings">,
    conversationId: string,
    ending: TurnBreak,
): Promise<TurnBreakPolicy> => {
    const override = services.agents.entry(conversationId)?.postures[ending];
    return override ?? (await sandboxBreakPolicy(services, ending));
};

// The sandbox-wide answer, which a conversation with no answer of its own inherits.
export const sandboxBreakPolicy = async (services: Pick<Services, "sandboxSettings">, ending: TurnBreak): Promise<TurnBreakPolicy> => {
    const settings = await services.sandboxSettings.get();
    switch (ending) {
        case "limit":
            return settings.limitPolicy;
        case "outage":
            return settings.outagePolicy;
        case "memory":
            return settings.memoryPolicy;
        default:
            return settings.stopPolicy;
    }
};
