import { type AgentProvider, type CatalogOption, effortAllowed, NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract";
import { providerModels } from "./providerCatalog";

/* WHICH REASONING TIERS A MODEL OFFERS, AND WHAT A PICK RUNS AT ON IT. A tier scale is a property of the MODEL,
 * not of the provider. Kimi K3 stops at 'high' while Claude goes to 'max', and 'max' leaves Claude's own scale
 * the moment thinking is switched off, so a pick made on one model is routinely off-scale on the next. Both
 * halves of the answer live here: what the segments OFFER, and what a selection actually RUNS at.
 *
 * Read at every use (the composer's segments, Conversation.effort) rather than written back over the user's
 * pick, so a trip through a smaller model never ratchets the choice down. */

const EFFORT_LABELS: Record<string, string> = { minimal: `Minimal`, low: `Low`, medium: `Medium`, high: `High`, xhigh: `X-High`, max: `Max` };

// Every reasoning tier any provider has, weakest first. Only an ORDER, nothing is offered because it appears
// here; it is what lets a clamp say "the strongest tier this model has that is no stronger than the pick".
const EFFORT_SCALE: readonly string[] = [`minimal`, `low`, `medium`, `high`, `xhigh`, `max`];

// The scale a model is offered on when its provider published none, the four tiers every non-Claude runtime
// has historically accepted. 'max' rides the same effortAllowed filter as a live scale's would.
const STATIC_EFFORTS: readonly string[] = [`low`, `medium`, `high`, `xhigh`, `max`];

// Reasoning effort levels for a provider+model: the live catalog's per-model tiers when the daemon reported
// them (Claude's and Kimi's catalogs carry each model's supported levels), else the static scale above.
// Model-aware so a release with a different scale adjusts the picker with no code change. `thinking` filters
// the top tier the same way effortAllowed does, the daemon reports a model's tiers without knowing this turn's
// thinking setting, so the filter applies to BOTH the live list and the static fallback. Empty only for an ACP
// provider, which owns its own reasoning settings and has no scale to offer.
export const effortsFor = (provider: AgentProvider, modelId: string | undefined, thinking: boolean): CatalogOption[] => {
    if (!NATIVE_PROVIDERS.includes(provider as NativeProvider)) {
        return [];
    }
    const published = (providerModels.value[provider] ?? []).find((option) => option.value === modelId)?.efforts;
    const scale = published !== undefined && published.length > 0 ? published : STATIC_EFFORTS;
    return scale.filter((value) => effortAllowed(value, provider, thinking)).map((value) => ({ label: EFFORT_LABELS[value] ?? value, value }));
};

// The tier a selection actually RUNS at for a provider+model+thinking triple: the pick itself when that model
// offers it, else the strongest weaker tier it does offer (the weakest it has, if the pick is below all of
// them). An off-scale effort both leaves the composer's segments with nothing lit and sends a tier the runtime
// never accepted.
export const clampEffort = (effort: string, provider: AgentProvider, modelId: string | undefined, thinking: boolean): string => {
    const offered = effortsFor(provider, modelId, thinking).map((option) => option.value);
    if (offered.length === 0 || offered.includes(effort)) {
        return effort;
    }
    const wanted = EFFORT_SCALE.indexOf(effort);
    const ranked = offered.toSorted((left, right) => EFFORT_SCALE.indexOf(left) - EFFORT_SCALE.indexOf(right));
    return ranked.findLast((value) => EFFORT_SCALE.indexOf(value) <= wanted) ?? ranked[0]!;
};

/* WHAT TO CALL THE TIER A SELECTION RUNS AT, the two rules above read as one word: clamp to what this model
 * actually offers, then name the rung. Undefined for a selection that pinned no tier, which is a state its own
 * caller words ("Default" beside a meter, nothing at all on a run button), not a word this file invents.
 *
 * Shared because three surfaces now name the same fact and none of them holds the scale: the settings row beside
 * a pinned entry, the caret on every run button, and the extension API's `describe`. */
export const effortLabelOf = (
    effort: string | undefined,
    provider: AgentProvider,
    modelId: string | undefined,
    thinking: boolean,
): string | undefined => {
    if (effort === undefined || effort === ``) {
        return undefined;
    }
    const running = clampEffort(effort, provider, modelId, thinking);
    return effortsFor(provider, modelId, thinking).find((option) => option.value === running)?.label ?? running;
};
