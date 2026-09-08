import {
    ACCESS_COST,
    type AgentProvider,
    type ModelBadge,
    PROVIDERS,
    accessFor,
    compareModelIds,
    familyOf,
    providerLabel,
} from "@intentic/sandbox-contract";
import { computed } from "vue";
import { type ModelOption, acpProviders, endpointProviders, modelOptionsFor, providerGroup, providerGroupLabel } from "../accounts/providerCatalog";
import type { TurnPick } from "../run/turnDefaults";

// Every provider's models flattened into one searchable list; pure derivation over the live catalogs, the picker
// owns only transient UI state. Harness is a separate axis (footer chips), not a row here. Tier and recency come
// from the model id via model-order.ts; catalog order is only the tiebreak.

// A picker row is a TurnPick (provider + model id) plus its display words; select via `selectModel(entry)`.
export interface PickerEntry extends TurnPick {
    // `${provider}:${value}`; model id is unique within a provider's harness-independent catalog.
    readonly key: string;
    readonly label: string;
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
}

const entryFor = (provider: AgentProvider, option: ModelOption): PickerEntry => ({
    key: `${provider}:${option.value}`,
    provider,
    value: option.value,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
    ...(option.badges !== undefined ? { badges: option.badges } : {}),
});

// Every pickable model across providers, in PROVIDERS order, then endpoint providers' full catalogs, then one row
// per ACP agent (empty model id: the agent owns its own model).
export const pickerEntries = computed<readonly PickerEntry[]>(() => [
    ...PROVIDERS.flatMap(({ value: provider }) => modelOptionsFor(provider).map((option) => entryFor(provider, option))),
    ...endpointProviders.value.flatMap((endpoint) => modelOptionsFor(endpoint.id).map((option) => entryFor(endpoint.id, option))),
    ...acpProviders.value.map((agent) => entryFor(agent.id, { label: agent.label, value: `` })),
]);

// Lowercase and strip separators, so "gpt5" matches "GPT-5" and "45" matches "4.5".
const normalize = (text: string): string => text.toLowerCase().replace(/[\s.\-_]/g, ``);

const haystackFor = (entry: PickerEntry): string =>
    normalize(`${entry.label} ${entry.value} ${providerLabel(entry.provider)} ${(entry.badges ?? []).join(` `)}`);

// Label-prefix hits outrank label-infix hits, which outrank id/provider/badge-only hits; ties keep stable provider
// order.
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

// One lane per provider, except every local-model provider shares one folded lane; a row still routes via its own
// provider. Grouping is `providerGroup` (providerCatalog.ts), shared with the Usage tab.
export interface PickerLane {
    // The rail filter's value and section key: a provider id, or LOCAL_MODELS_GROUP for the folded lane.
    readonly key: string;
    readonly label: string;
    // Every provider drawn in this lane, in order; exactly one, except in the folded lane.
    readonly providers: readonly AgentProvider[];
}

// Providers fold into lanes in the order given; each lane is seated where its first provider sat.
export const lanesOf = (providers: readonly AgentProvider[]): readonly PickerLane[] => {
    const lanes: { key: string; label: string; providers: AgentProvider[] }[] = [];
    for (const provider of providers) {
        const key = providerGroup(provider);
        const seated = lanes.find((lane) => lane.key === key);
        if (seated !== undefined) {
            seated.providers.push(provider);
            continue;
        }
        lanes.push({ key, label: providerGroupLabel(key), providers: [provider] });
    }
    return lanes;
};

// Case-insensitive, multi-token AND search over label/id/provider/badges (not descriptions). `rail` scopes to one
// lane; `isReady` outranks match quality, as in the browse view.
export const filterEntries = (
    entries: readonly PickerEntry[],
    query: string,
    rail: string | undefined,
    isReady: (provider: AgentProvider) => boolean,
): readonly PickerEntry[] => {
    const scoped = rail === undefined ? entries : entries.filter((entry) => providerGroup(entry.provider) === rail);
    const tokens = query
        .split(/\s+/)
        .map(normalize)
        .filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return scoped.toSorted((a, b) => Number(isReady(b.provider)) - Number(isReady(a.provider)));
    }
    const matched = scoped.filter((entry) => tokens.every((token) => haystackFor(entry).includes(token)));
    // Runnable first, then match quality; equal hits keep catalog order (stable sort), as in browse.
    return matched.toSorted((a, b) => Number(isReady(b.provider)) - Number(isReady(a.provider)) || rankFor(a, tokens) - rankFor(b, tokens));
};

// The custom-model escape hatch: any typed id no catalog row already offers, mirroring Claude Code's `/model <id>`.
// Offered only on an exact-id miss, with no metadata (none is published for an unrecognized id).
export const customEntryFor = (entries: readonly PickerEntry[], query: string, provider: AgentProvider): PickerEntry | undefined => {
    const value = query.trim();
    // Model ids are hyphenated tokens; requiring a hyphen excludes plain search words and bare tier aliases.
    if (!/^[\w.]+(-[\w.]+)+$/.test(value)) {
        return undefined;
    }
    if (entries.some((entry) => entry.provider === provider && entry.value === value)) {
        return undefined;
    }
    return { key: `${provider}:${value}`, provider, value, label: value, description: `use as custom model id` };
};

// Catalog rows group by family (newest first), tier-major, instead of raw catalog order. Family/recency/tier are
// derived from the model id via compareModelIds/familyOf, shared with the daemon; catalog order only breaks ties.

// The family header: the newest row's label with trailing version words peeled off ("Claude Opus 5" → "Claude
// Opus"). A label ending in a word ("Grok 4 Fast") stands unchanged.
const familyLabelOf = (newest: PickerEntry): string => {
    const words = newest.label.split(/\s+/);
    while (words.length > 1 && /^v?[\d.]+$/.test(words.at(-1)!)) {
        words.pop();
    }
    return words.join(` `);
};

export interface FamilyGroup {
    readonly key: string;
    readonly label: string;
    // The family's newest by version; the row the collapsed group shows.
    readonly latest: PickerEntry;
    readonly older: readonly PickerEntry[];
}

// One group per family, members newest-first, groups tier-major; the same comparator does both jobs since tier is
// constant within a family.
export const familyGroups = (entries: readonly PickerEntry[]): readonly FamilyGroup[] => {
    const families = new Map<string, PickerEntry[]>();
    for (const entry of entries) {
        const key = familyOf(entry.value);
        const members = families.get(key);
        if (members === undefined) {
            families.set(key, [entry]);
            continue;
        }
        members.push(entry);
    }
    return [...families]
        .map(([key, members]) => {
            const ordered = members.toSorted((a, b) => compareModelIds(a.value, b.value));
            const latest = ordered[0]!;
            return { key, label: familyLabelOf(latest), latest, older: ordered.slice(1) };
        })
        .toSorted((a, b) => compareModelIds(a.latest.value, b.latest.value));
};

export interface PickerBlock {
    readonly key: string;
    // Absent on the latest band; the provider header already names it.
    readonly label?: string;
    readonly entries: readonly PickerEntry[];
}

// Blocks a provider group renders: collapsed is one row per family (latest); expanded adds each family's older
// versions under their own header. The pinned row keeps a selected older version visible even when collapsed.
export const pickerBlocks = (groups: readonly FamilyGroup[], selected: string | undefined, expanded: boolean): readonly PickerBlock[] => {
    const latest = groups.map((group) => group.latest);
    if (expanded) {
        return [
            { key: `latest`, entries: latest },
            // Keyed by the family's newest row, not the family: two cards in a folded lane can share a family key.
            ...groups.filter((group) => group.older.length > 0).map((group) => ({ key: group.latest.key, label: group.label, entries: group.older })),
        ];
    }
    const pinned =
        selected === undefined || latest.some((entry) => entry.value === selected)
            ? undefined
            : groups.flatMap((group) => group.older).find((entry) => entry.value === selected);
    return [{ key: `latest`, entries: pinned === undefined ? latest : [...latest, pinned] }];
};

// Sort key for a locked provider: free, then subscription, then key (ACCESS_COST order); ACP agents and model
// endpoints (own credentials) sort last. Mirrors accessBadge, same table.
const accessRank = (provider: AgentProvider): number => {
    const access = accessFor(provider);
    return access === undefined ? Object.keys(ACCESS_COST).length : ACCESS_COST[access.kind];
};

export interface PickerSection extends PickerLane {
    readonly groups: readonly FamilyGroup[];
    readonly total: number;
}

// One section per lane (respecting `rail`): active provider's lane first, then connected providers, then locked
// ones cheapest first. Empty sections are kept for the component's loading/error/empty row.
export const pickerSections = (
    entries: readonly PickerEntry[],
    activeProvider: AgentProvider,
    rail: string | undefined,
    isReady: (provider: AgentProvider) => boolean,
): readonly PickerSection[] => {
    const providers: AgentProvider[] = [
        ...PROVIDERS.map((option) => option.value),
        ...endpointProviders.value.map((endpoint) => endpoint.id),
        ...acpProviders.value.map((agent) => agent.id),
    ];
    // Active provider leads regardless of connection; then connected first; cost only ranks within the locked band.
    const rest = providers
        .filter((provider) => provider !== activeProvider)
        .toSorted((a, b) => {
            const ready = Number(isReady(b)) - Number(isReady(a));
            return ready !== 0 || isReady(a) ? ready : accessRank(a) - accessRank(b);
        });
    const order = providers.includes(activeProvider) ? [activeProvider, ...rest] : rest;
    // Folds after ordering, so the local lane is seated by its best-placed card.
    return lanesOf(order)
        .filter((lane) => rail === undefined || lane.key === rail)
        .map((lane) => {
            const owned = entries.filter((entry) => lane.providers.includes(entry.provider));
            // Families derive per provider, never across providers: two local endpoints are never grouped as one
            // family.
            const groups = lane.providers.flatMap((provider) => familyGroups(owned.filter((entry) => entry.provider === provider)));
            return { key: lane.key, label: lane.label, providers: lane.providers, groups, total: owned.length };
        });
};
