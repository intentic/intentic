import { compareCheapestFirst, isCheaperRung } from "./model-order.js";
import { parsePinned } from "./model-pins.js";
import type { AgentProvider } from "../schemas/agent.js";

// Picks which model a downgraded turn runs on, once prompt-complexity.ts decides a turn could be cheaper. Only routes
// down to a cheaper rung of the model the user already picked; ambiguous cases resolve to undefined, meaning run their
// pick. Never crosses provider: that retires the session and loses the context that made the follow-up cheap.

export interface FastTierInput {
    readonly provider: AgentProvider;
    // Empty means the composer has not resolved a pick yet; that resolves to no downgrade, not a guess.
    readonly model: string;
    // Empty is a real state (catalog not loaded yet), and resolves to no downgrade rather than a guess.
    readonly models: readonly string[];
    // settings.autoFastModels: ordered `${provider}:${modelId}` keys, empty for Auto; other providers drop.
    readonly pinned: readonly string[];
}

// A pin is taken verbatim but must still be cheaper than the pick; Auto falls back to the cheapest rung, in the same
// cheap-first order the quick model uses. Undefined means nothing is cheaper.
export const fastTierModel = (input: FastTierInput): string | undefined => {
    if (input.model === "") {
        return undefined;
    }
    const pinned = input.pinned
        .flatMap((key) => {
            const choice = parsePinned(key);
            return choice === undefined || choice.provider !== input.provider ? [] : [choice.model];
        })
        .find((model) => isCheaperRung(model, input.model));
    if (pinned !== undefined) {
        return pinned;
    }
    const cheapest = input.models.toSorted(compareCheapestFirst)[0];
    return cheapest !== undefined && isCheaperRung(cheapest, input.model) ? cheapest : undefined;
};
