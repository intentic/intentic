import type { SessionConfigOption } from "@agentclientprotocol/sdk";

// An ACP session's model choice, read off the config options its agent answers session/new, session/load and
// session/set_config_option with and pushes as config_option_update. The protocol names no model field of its own: an
// agent that lets its client pick one offers a select option in the `model` category, values grouped or flat.

export interface ModelChoice {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
}

export interface SessionModels {
    // The option's id, which session/set_config_option addresses; Devin's is `model`, the protocol does not fix it.
    readonly configId: string;
    // What the session runs on now.
    readonly current: string;
    // What this session may switch to: the agent's own list for its own login, so it is the account's entitlement.
    readonly choices: readonly ModelChoice[];
}

// Undefined when the agent offers no model option: it keeps its model to itself, as the installed ACP floor assumes.
export const sessionModelsOf = (options: readonly SessionConfigOption[] | null | undefined): SessionModels | undefined => {
    const option = options?.find((candidate) => candidate.type === "select" && (candidate.category === "model" || candidate.id === "model"));
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

// What one of the agent's answers says about a session's model, written over what was known; an answer whose options
// name no model leaves the session without one, since the agent no longer offers the choice.
export const recordModels = (
    models: Map<string, SessionModels>,
    sessionId: string,
    options: readonly SessionConfigOption[] | null | undefined,
): SessionModels | undefined => {
    const stated = sessionModelsOf(options);
    if (stated === undefined) {
        models.delete(sessionId);
    } else {
        models.set(sessionId, stated);
    }
    return stated;
};
