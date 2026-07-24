import { type AgentProvider, type ModelMetadata, modelMetadataFor, PROVIDERS, providerLabel } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { acpProviders, modelOptionsFor } from "./conversation";

/* The unified model-picker list: every provider's models flattened into one searchable entry set. Pure
 * derivation over the live catalogs (conversation.ts) plus the curated metadata (sandbox-contract) — the
 * picker component owns only its transient UI state (query, rail filter, highlight). The harness (Default /
 * Claude Code) is a separate axis, chosen via the picker's footer chips — NOT a row here — because codex/grok
 * run the same subscription model ids under either harness, so the list no longer forks by harness. */

export interface PickerEntry {
    // `${provider}:${value}` — the model id is unique within a provider's (harness-independent) catalog.
    readonly key: string;
    readonly provider: AgentProvider;
    readonly value: string;
    readonly label: string;
    readonly metadata?: ModelMetadata;
}

const entryFor = (provider: AgentProvider, option: { label: string; value: string }): PickerEntry => {
    const metadata = modelMetadataFor(option.value);
    return {
        key: `${provider}:${option.value}`,
        provider,
        value: option.value,
        label: option.label,
        ...(metadata !== undefined ? { metadata } : {}),
    };
};

// Every pickable model across providers, in PROVIDERS order: each provider's catalog (live, with the static
// floor pre-load). Installed ACP agents append one row each: the agent owns its own model, so the row IS the
// provider (empty model id).
export const pickerEntries = computed<readonly PickerEntry[]>(() => [
    ...PROVIDERS.flatMap(({ value: provider }) => modelOptionsFor(provider).map((option) => entryFor(provider, option))),
    ...acpProviders.value.map((agent) => entryFor(agent.id, { label: agent.label, value: `` })),
]);

// Strong→weak ordering within one provider. Primary: the curated capability rank (model-metadata.ts) — an
// unranked (brand-new) id floors just under BALANCED so it surfaces rather than sinks. Secondary: the version
// number descending, so within a tier the newest generation leads (GPT 5.6 over 5.5). Full ties keep the
// catalog's own order (toSorted is stable) — deterministic, never the daemon's arbitrary sequence.
const UNRANKED = 75;
const strengthOf = (entry: PickerEntry): number => entry.metadata?.rank ?? UNRANKED;
// The first number in the label/id: "GPT 5.6 Sol" → 5.6, "Grok 4" → 4, aliased "Opus" → 0 (tier rank leads).
const versionOf = (entry: PickerEntry): number => Number(`${entry.label} ${entry.value}`.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
const byStrength = (a: PickerEntry, b: PickerEntry): number => strengthOf(b) - strengthOf(a) || versionOf(b) - versionOf(a);

// Lowercase and strip separators on both sides, so "gpt5" matches "GPT-5" and "45" matches "4.5".
const normalize = (text: string): string => text.toLowerCase().replace(/[\s.\-_]/g, ``);

const haystackFor = (entry: PickerEntry): string =>
    normalize(`${entry.label} ${entry.value} ${providerLabel(entry.provider)} ${(entry.metadata?.badges ?? []).join(` `)}`);

// Label-prefix hits outrank label-infix hits, which outrank id/provider/badge-only hits; ties keep the
// stable provider order (sort is stable).
const rankFor = (entry: PickerEntry, tokens: readonly string[]): number => {
    const label = normalize(entry.label);
    if (tokens.some((token) => label.startsWith(token))) {
        return 0;
    }
    if (tokens.some((token) => label.includes(token))) {
        return 1;
    }
    return 2;
};

// Case-insensitive substring search, multi-token AND: every whitespace-separated token must match somewhere
// in the entry's label/id/provider/badges. `rail` scopes to one provider first (the rail filter persists
// while searching). Descriptions are deliberately not matched — copy produces baffling hits.
export const filterEntries = (entries: readonly PickerEntry[], query: string, rail: AgentProvider | undefined): readonly PickerEntry[] => {
    const scoped = rail === undefined ? entries : entries.filter((entry) => entry.provider === rail);
    const tokens = query
        .split(/\s+/)
        .map(normalize)
        .filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return scoped;
    }
    const matched = scoped.filter((entry) => tokens.every((token) => haystackFor(entry).includes(token)));
    // Match quality leads; equal-quality hits fall back to strongest-first so the ranking is consistent with browse.
    return matched.toSorted((a, b) => rankFor(a, tokens) - rankFor(b, tokens) || byStrength(a, b));
};

// Browse-mode grouping: one section per provider (respecting the rail filter), the active provider hoisted
// first — the models pickable without a session restart sit nearest — and the rest in stable PROVIDERS order.
// Empty sections are kept: the component renders their loading/error/empty state row under the header.
export const pickerSections = (
    entries: readonly PickerEntry[],
    activeProvider: AgentProvider,
    rail: AgentProvider | undefined,
): readonly { provider: AgentProvider; entries: readonly PickerEntry[] }[] => {
    const providers: AgentProvider[] = [...PROVIDERS.map((option) => option.value), ...acpProviders.value.map((agent) => agent.id)].filter(
        (provider) => rail === undefined || provider === rail,
    );
    const order = providers.includes(activeProvider) ? [activeProvider, ...providers.filter((provider) => provider !== activeProvider)] : providers;
    // Each provider's rows are sorted strongest-first; the group order (active hoisted, then PROVIDERS) is unchanged.
    return order.map((provider) => ({ provider, entries: entries.filter((entry) => entry.provider === provider).toSorted(byStrength) }));
};
