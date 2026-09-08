import { modelsFor } from "./agent-catalog.js";
import type { AgentProvider, ModelPin } from "../schemas/agent.js";

// The order to try models in for a role or job (settings.modelRoles), shared by daemon and browser so both agree what a
// job will spend before it runs. An empty list resolves to nothing for every role: nothing is derived or auto-selected.
// The caller decides what an empty answer means (a helper is off; a run falls back to the chat's own pick).

// One provider's standing in the decision: can a turn go, and what its catalog holds. ACP agents have no rung here (an
// empty model id), but endpoint/<id> providers must be included, matching the picker's own options.
export interface ModelSource {
    // AgentProvider, not NativeProvider: an endpoint's id is user-created, no fixed union; nothing here ranks cost.
    readonly provider: AgentProvider;
    // Same connection predicate every surface gates on; a nonempty catalog does not imply ready to send.
    readonly ready: boolean;
    // Nothing here reads this (a pin is verbatim); kept because it's what a source is, and callers still gather it.
    readonly models: readonly string[];
}

export interface ModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
}

// A (provider, model) pair on the wire: `${provider}:${modelId}`, the same key shape the picker mints. Used to compare
// entries, dedupe a role list, and store autoFastModels.
export const modelPinKey = (choice: ModelChoice): string => `${choice.provider}:${choice.model}`;

// Splits on the first colon only: a provider id never contains one, a model id might. Exported since autoFastModels
// stores these keys.
export const parsePinned = (pinned: string): ModelChoice | undefined => {
    const separator = pinned.indexOf(`:`);
    if (separator <= 0 || separator === pinned.length - 1) {
        return undefined;
    }
    return { provider: pinned.slice(0, separator), model: pinned.slice(separator + 1) };
};

// A pin as a person reads it: the catalog's own label, or the raw id when the static catalog has not caught up with it
// (a real case, via the picker's custom-id escape hatch).
export const pinnedModelLabel = (choice: ModelChoice): string =>
    modelsFor(choice.provider).find((option) => option.value === choice.model)?.label ?? choice.model;

// Filters pinned entries to ready providers only; there is no floor beneath a written list, so an account left unnamed
// is never reached. Returns whole pins, not bare pairs, since effort, thinking and harness must survive with the pick.
export const readyChain = (sources: readonly ModelSource[], pinned: readonly ModelPin[]): readonly ModelPin[] => {
    const ready = new Set(sources.filter((source) => source.ready).map((source) => source.provider));
    // Taken verbatim, unvalidated: the picker's custom-id escape hatch must run exactly the id it names.
    const requested = pinned.filter((pin) => ready.has(pin.provider));
    // First occurrence wins, whole: two entries can name one model with different knobs, and the earlier is meant.
    const chain: ModelPin[] = [];
    for (const pin of requested) {
        if (!chain.some((held) => modelPinKey(held) === modelPinKey(pin))) {
            chain.push(pin);
        }
    }
    return chain;
};
