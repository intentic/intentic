import {
    type AgentHarness,
    type AgentProvider,
    type ModelMetadata,
    modelMetadataFor,
    modelsFor,
    PROVIDERS,
    providerLabel,
} from "@intentic/sandbox-contract";
import { computed } from "vue";
import { modelOptionsFor } from "./conversation";

/* The unified model-picker list: every provider's models flattened into one searchable entry set. Pure
 * derivation over the live catalogs (conversation.ts) plus the curated metadata (sandbox-contract) — the
 * picker component owns only its transient UI state (query, rail filter, highlight). */

export interface PickerEntry {
    // `${provider}:${harness}:${value}` — unique even when an id repeats across harnesses (gpt-5-codex can be
    // both a native catalog entry and the translator's claude-code mapping).
    readonly key: string;
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly value: string;
    readonly label: string;
    readonly metadata?: ModelMetadata;
}

const entryFor = (provider: AgentProvider, harness: AgentHarness, option: { label: string; value: string }): PickerEntry => {
    const metadata = modelMetadataFor(option.value);
    return {
        key: `${provider}:${harness}:${option.value}`,
        provider,
        harness,
        value: option.value,
        label: option.label,
        ...(metadata !== undefined ? { metadata } : {}),
    };
};

// Every pickable model across providers, in PROVIDERS order: each provider's native catalog (live, with the
// static floor pre-load), then — for codex/grok — its deterministic "via Claude Code" translator row. Claude
// is always its own Claude Code loop, so it contributes native entries only.
export const pickerEntries = computed<readonly PickerEntry[]>(() =>
    PROVIDERS.flatMap(({ value: provider }) => [
        ...modelOptionsFor(provider, `native`).map((option) => entryFor(provider, `native`, option)),
        ...(provider === `claude` ? [] : modelsFor(provider, `claude-code`).map((option) => entryFor(provider, `claude-code`, option))),
    ]),
);

// Lowercase and strip separators on both sides, so "gpt5" matches "GPT-5" and "45" matches "4.5".
const normalize = (text: string): string => text.toLowerCase().replace(/[\s.\-_]/g, ``);

const haystackFor = (entry: PickerEntry): string =>
    normalize(
        `${entry.label} ${entry.value} ${providerLabel(entry.provider)} ${(entry.metadata?.badges ?? []).join(` `)}` +
            (entry.harness === `claude-code` ? ` claude code harness` : ``),
    );

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
    const tokens = query.split(/\s+/).map(normalize).filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return scoped;
    }
    const matched = scoped.filter((entry) => tokens.every((token) => haystackFor(entry).includes(token)));
    return [...matched].sort((a, b) => rankFor(a, tokens) - rankFor(b, tokens));
};

// Browse-mode grouping: one section per provider (respecting the rail filter), the active provider hoisted
// first — the models pickable without a session restart sit nearest — and the rest in stable PROVIDERS order.
// Empty sections are kept: the component renders their loading/error/empty state row under the header.
export const pickerSections = (
    entries: readonly PickerEntry[],
    activeProvider: AgentProvider,
    rail: AgentProvider | undefined,
): readonly { provider: AgentProvider; entries: readonly PickerEntry[] }[] => {
    const providers = PROVIDERS.map((option) => option.value).filter((provider) => rail === undefined || provider === rail);
    const order = providers.includes(activeProvider) ? [activeProvider, ...providers.filter((provider) => provider !== activeProvider)] : providers;
    return order.map((provider) => ({ provider, entries: entries.filter((entry) => entry.provider === provider) }));
};
