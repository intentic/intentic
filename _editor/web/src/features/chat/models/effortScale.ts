import { type AgentProvider, type CatalogOption, effortAllowed, NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract";
import { providerModels } from "../accounts/providerCatalog";

// Which reasoning tiers a model offers, and what a pick runs at: a scale is a property of the model, not the provider
// (Kimi K2.7 stops at 'high', K3 at 'max'). Read at every use (composer segments, Conversation.effort) rather than
// written back, so a smaller model never ratchets the pick down.

const EFFORT_LABELS: Record<string, string> = { minimal: `Minimal`, low: `Low`, medium: `Medium`, high: `High`, xhigh: `X-High`, max: `Max` };

// Every tier any provider has, weakest first; an order only, not an offer.
const EFFORT_SCALE: readonly string[] = [`minimal`, `low`, `medium`, `high`, `xhigh`, `max`];

// Default floor tiers, deliberately without 'max' (a provider must claim it); Claude's is the exception.
const STATIC_EFFORTS: readonly string[] = [`low`, `medium`, `high`, `xhigh`];
const CLAUDE_EFFORTS: readonly string[] = [...STATIC_EFFORTS, `max`];
const floorFor = (provider: AgentProvider): readonly string[] => (provider === `claude` ? CLAUDE_EFFORTS : STATIC_EFFORTS);

// Reasoning levels for a provider+model: live catalog tiers when reported, else the floor. `thinking` undefined is a
// third state (unpinned, not off); empty only for an ACP provider.
export const effortsFor = (provider: AgentProvider, modelId: string | undefined, thinking: boolean | undefined): CatalogOption[] => {
    if (!NATIVE_PROVIDERS.includes(provider as NativeProvider)) {
        return [];
    }
    const published = (providerModels.value[provider] ?? []).find((option) => option.value === modelId)?.efforts;
    const scale = published !== undefined && published.length > 0 ? published : floorFor(provider);
    return scale.filter((value) => effortAllowed(value, provider, thinking)).map((value) => ({ label: EFFORT_LABELS[value] ?? value, value }));
};

// The tier a selection actually runs at: the pick itself if offered, else the strongest weaker tier the model has (or
// its weakest). An off-scale effort lights no segment and sends a tier the runtime never accepted.
export const clampEffort = (effort: string, provider: AgentProvider, modelId: string | undefined, thinking: boolean | undefined): string => {
    const offered = effortsFor(provider, modelId, thinking).map((option) => option.value);
    if (offered.length === 0 || offered.includes(effort)) {
        return effort;
    }
    const wanted = EFFORT_SCALE.indexOf(effort);
    const ranked = offered.toSorted((left, right) => EFFORT_SCALE.indexOf(left) - EFFORT_SCALE.indexOf(right));
    return ranked.findLast((value) => EFFORT_SCALE.indexOf(value) <= wanted) ?? ranked[0]!;
};

// Label for the tier a selection runs at: clamp first, then name the rung. Undefined for a pick with no tier pinned.
// Shared since the settings row, every run button, and the extension API all name the same fact.
export const effortLabelOf = (
    effort: string | undefined,
    provider: AgentProvider,
    modelId: string | undefined,
    thinking: boolean | undefined,
): string | undefined => {
    if (effort === undefined || effort === ``) {
        return undefined;
    }
    const running = clampEffort(effort, provider, modelId, thinking);
    return effortsFor(provider, modelId, thinking).find((option) => option.value === running)?.label ?? running;
};
