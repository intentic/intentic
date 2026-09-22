import type { WakeFn } from "../../../automations/scheduler.js";
import type { Services } from "../../../composition.js";
import type { PersistedAgent } from "../../../agents/registry/agents-store.js";
import { steerTurn } from "../../checkpoints/agent-steering.js";
import type { TurnInput } from "./turn-actor.js";
import { startConversationTurn } from "./turn-resume.js";
import type { WakeDoors } from "./wake-delivery.js";

// The steering registry, and the journalled detached start every daemon-started turn uses.
export const conversationDoors = (services: Services, wake: WakeFn): WakeDoors => ({
    steer: steerTurn,
    start: async (turn) => (await startConversationTurn(services, wake, turn)) !== undefined,
    sessionIdOf: (conversationId) => services.agents.sessionIdOf(conversationId),
});

// What the conversation runs on now, as the registry persisted its last turn; absent stays absent.
export type ConversationRouting = Pick<TurnInput, "agent" | "harness" | "model" | "effort" | "thinking" | "fast" | "account" | "actsAs">;

export const conversationRouting = (entry: PersistedAgent): ConversationRouting => ({
    agent: entry.provider,
    harness: entry.harness,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
    ...(entry.fast === undefined ? {} : { fast: entry.fast }),
    ...(entry.account === undefined ? {} : { account: entry.account }),
    ...(entry.actsAs === undefined ? {} : { actsAs: entry.actsAs }),
});
