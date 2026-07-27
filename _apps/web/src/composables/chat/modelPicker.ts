import { type AgentProvider, type ModelBadge, PROVIDERS, providerLabel } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { type ModelOption, acpProviders, modelOptionsFor } from "./conversation";

/* The unified model-picker list: every provider's models flattened into one searchable entry set. Pure
 * derivation over the live catalogs (conversation.ts) — the picker component owns only its transient UI state
 * (query, rail filter, highlight). The harness (Default / Claude Code) is a separate axis, chosen via the
 * picker's footer chips — NOT a row here — because codex/grok run the same subscription model ids under either
 * harness, so the list no longer forks by harness.
 *
 * Every rendered fact about a model — label, description, badges, and the ORDER — comes from the provider's own
 * catalog. There is deliberately no local ranking table: one used to rank by hand-written capability tiers, which
 * meant an unrecognized id fell to a floor BELOW the everyday tier, so a brand-new flagship sorted beneath the
 * model it replaced. Catalog order is the provider's own preference and is always current, so it needs no edit
 * when a model ships. Rows a provider publishes nothing about render label-only; that is the intended end state,
 * not a gap to backfill. */

export interface PickerEntry {
    // `${provider}:${value}` — the model id is unique within a provider's (harness-independent) catalog.
    readonly key: string;
    readonly provider: AgentProvider;
    readonly value: string;
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

// Every pickable model across providers, in PROVIDERS order: each provider's catalog (live, with the static
// floor pre-load). Installed ACP agents append one row each: the agent owns its own model, so the row IS the
// provider (empty model id).
export const pickerEntries = computed<readonly PickerEntry[]>(() => [
    ...PROVIDERS.flatMap(({ value: provider }) => modelOptionsFor(provider).map((option) => entryFor(provider, option))),
    ...acpProviders.value.map((agent) => entryFor(agent.id, { label: agent.label, value: `` })),
]);

// Lowercase and strip separators on both sides, so "gpt5" matches "GPT-5" and "45" matches "4.5".
const normalize = (text: string): string => text.toLowerCase().replace(/[\s.\-_]/g, ``);

const haystackFor = (entry: PickerEntry): string =>
    normalize(`${entry.label} ${entry.value} ${providerLabel(entry.provider)} ${(entry.badges ?? []).join(` `)}`);

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
    // Match quality leads; equal-quality hits keep catalog order (toSorted is stable), consistent with browse.
    return matched.toSorted((a, b) => rankFor(a, tokens) - rankFor(b, tokens));
};

// The custom-model escape hatch: any id the user types that no catalog row already offers, mirroring Claude
// Code's own `/model <id>`, which accepts an arbitrary string and lists it as a "Custom model". A provider's
// catalog can lag a release — a REST /v1/models entry still has to reach the account — so during that window
// typing the id is the ONLY way to drive a model that already serves turns. Offered on an exact-id miss only,
// so it never competes with a real catalog hit, and it carries no metadata because none is published: an
// unrecognized id is exactly as unknown to us as it looks.
export const customEntryFor = (entries: readonly PickerEntry[], query: string, provider: AgentProvider): PickerEntry | undefined => {
    const value = query.trim();
    // A model id is a hyphenated, whitespace-free token (claude-opus-5, gpt-5.1, grok-4-fast). Requiring the
    // hyphen is what stops an ordinary search word — "fast", "opus" — from offering a junk row on every
    // keystroke, and it also keeps Claude's bare tier aliases untypeable, which is deliberate: every model this
    // app can be pointed at names its own version (see CLAUDE_SEED_MODELS).
    if (!/^[\w.]+(-[\w.]+)+$/.test(value)) {
        return undefined;
    }
    if (entries.some((entry) => entry.provider === provider && entry.value === value)) {
        return undefined;
    }
    return { key: `${provider}:${value}`, provider, value, label: value, description: `use as custom model id` };
};

/* Browse-mode truncation. Claude's group is every version /v1/models publishes for the account — a dozen-odd
 * rows, which pushes the codex/grok/gemini groups below the fold the moment the picker opens. A collapsed group
 * shows the HEAD of the provider's own order, which is already newest-first, so "newest" needs no date field and
 * no local ranking: the same no-curation rule the rest of this module follows delivers it for free. Search never
 * truncates (see the component) — a buried older version is precisely what someone types to find. */
export const COLLAPSED_ROWS = 8;

// The rows a collapsed group shows: the head, plus the selected model when truncation would otherwise drop it.
// That union is why this isn't a bare slice — losing the selected row takes the checkmark with it, so a user
// pinned to an older version would open the picker to no visible current model at all.
export const collapseEntries = (entries: readonly PickerEntry[], selected: string | undefined): readonly PickerEntry[] => {
    if (entries.length <= COLLAPSED_ROWS) {
        return entries;
    }
    const head = entries.slice(0, COLLAPSED_ROWS);
    if (selected === undefined || head.some((entry) => entry.value === selected)) {
        return head;
    }
    const current = entries.find((entry) => entry.value === selected);
    return current === undefined ? head : [...head, current];
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
    // Rows keep the provider's own catalog order; only the group order (active hoisted, then PROVIDERS) is ours.
    return order.map((provider) => ({ provider, entries: entries.filter((entry) => entry.provider === provider) }));
};
