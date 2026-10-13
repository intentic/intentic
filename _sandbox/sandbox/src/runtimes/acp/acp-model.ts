import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { EFFORT_TIERS } from "@intentic/sandbox-contract";

// An ACP session's model and reasoning-depth choices, read off the config options its agent answers session/new,
// session/load and session/set_config_option with and pushes as config_option_update. The protocol names no model or
// effort field of its own: an agent that lets its client pick one offers a select option in the `model` (or
// `thought_level`) category, values grouped or flat.

export interface ModelChoice {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
}

// One select option as the agent last stated it.
export interface SessionModels {
    // The option's id, which session/set_config_option addresses; Devin's is `model`, the protocol does not fix it.
    readonly configId: string;
    // What the session runs on now.
    readonly current: string;
    // What this session may switch to: the agent's own list for its own login, so it is the account's entitlement.
    readonly choices: readonly ModelChoice[];
}

// Where a connection keeps both options per session: the model, and the reasoning depth where the agent offers one.
export interface SessionOptions {
    readonly models: Map<string, SessionModels>;
    readonly thoughts: Map<string, SessionModels>;
}

const selectOf = (options: readonly SessionConfigOption[] | null | undefined, category: string): SessionModels | undefined => {
    const option = options?.find((candidate) => candidate.type === "select" && (candidate.category === category || candidate.id === category));
    if (option?.type !== "select") {
        return undefined;
    }
    const choices = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
    return {
        configId: option.id,
        current: option.currentValue,
        choices: choices.map((choice) => ({
            value: choice.value,
            name: choice.name,
            ...(typeof choice.description === "string" && choice.description !== "" ? { description: choice.description } : {}),
        })),
    };
};

// Undefined when the agent offers no model option: it keeps its model to itself, as the installed ACP floor assumes.
export const sessionModelsOf = (options: readonly SessionConfigOption[] | null | undefined): SessionModels | undefined => selectOf(options, "model");

// Undefined when the agent offers no reasoning-depth option (the protocol's `thought_level` category).
export const sessionThoughtsOf = (options: readonly SessionConfigOption[] | null | undefined): SessionModels | undefined =>
    selectOf(options, "thought_level");

const written = (map: Map<string, SessionModels>, sessionId: string, stated: SessionModels | undefined): SessionModels | undefined => {
    if (stated === undefined) {
        map.delete(sessionId);
    } else {
        map.set(sessionId, stated);
    }
    return stated;
};

// What one of the agent's answers says about a session's model, written over what was known; an answer whose options
// name no model leaves the session without one, since the agent no longer offers the choice.
export const recordModels = (
    models: Map<string, SessionModels>,
    sessionId: string,
    options: readonly SessionConfigOption[] | null | undefined,
): SessionModels | undefined => written(models, sessionId, sessionModelsOf(options));

// Both options from one answer, since every answer restates the whole set. Answers the model, the one a caller reads.
export const recordOptions = (
    state: SessionOptions,
    sessionId: string,
    options: readonly SessionConfigOption[] | null | undefined,
): SessionModels | undefined => {
    written(state.thoughts, sessionId, sessionThoughtsOf(options));
    return recordModels(state.models, sessionId, options);
};

const tierOf = (choice: ModelChoice): number => {
    const value = EFFORT_TIERS.indexOf(choice.value.toLowerCase());
    return value === -1 ? EFFORT_TIERS.indexOf(choice.name.toLowerCase()) : value;
};

// The shared ladder's names for the levels an agent offers, weakest first; a level that names no tier is left out.
export const thoughtTiers = (thoughts: SessionModels): string[] =>
    thoughts.choices
        .map(tierOf)
        .filter((tier) => tier !== -1)
        .toSorted((a, b) => a - b)
        .flatMap((tier) => EFFORT_TIERS[tier] ?? []);

// The agent's level for the turn's effort: one spelled as the tier itself, else the nearest the agent names on the
// shared ladder, at or below before above, since a depth nobody asked for costs more than one short of it. Undefined
// when the effort is no tier, or the agent's levels name none: reasoning depth is advisory, never guessed at.
export const thoughtFor = (thoughts: SessionModels, effort: string): string | undefined => {
    const wanted = EFFORT_TIERS.indexOf(effort);
    if (wanted === -1) {
        return undefined;
    }
    const ranked = thoughts.choices.flatMap((choice) => {
        const tier = tierOf(choice);
        return tier === -1 ? [] : [{ value: choice.value, tier }];
    });
    const exact = ranked.find((choice) => choice.tier === wanted);
    if (exact !== undefined) {
        return exact.value;
    }
    const below = ranked.filter((choice) => choice.tier < wanted).toSorted((a, b) => b.tier - a.tier)[0];
    return below?.value ?? ranked.filter((choice) => choice.tier > wanted).toSorted((a, b) => a.tier - b.tier)[0]?.value;
};
