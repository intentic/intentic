import { type AgentProvider, type ModelBadge, PROVIDERS, providerLabel } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { type ModelOption, acpProviders, modelOptionsFor } from "./conversation";

/* The unified model-picker list: every provider's models flattened into one searchable entry set. Pure
 * derivation over the live catalogs (conversation.ts) — the picker component owns only its transient UI state
 * (query, rail filter, highlight). The harness (Default / Claude Code) is a separate axis, chosen via the
 * picker's footer chips — NOT a row here — because codex/grok run the same subscription model ids under either
 * harness, so the list no longer forks by harness.
 *
 * Every rendered fact about a model — label, description, badges — comes from the provider's own catalog, and so
 * does recency: catalog order IS the provider's newest-first preference, always current, needing no edit when a
 * model ships. Rows a provider publishes nothing about render label-only; that is the intended end state, not a
 * gap to backfill. The single exception is TIER_RANK below, which orders FAMILIES (not models) and is scoped as
 * tightly as it is precisely because a per-model ranking table failed here once already — see its comment. */

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

/* FAMILY-MAJOR BROWSING. A provider's catalog order is a RELEASE TIMELINE (newest-first), and rendering it
 * straight made the picker a version history rather than a menu: Claude's account list opened with five Opus
 * versions in a row, so Haiku — a whole tier — sat below the fold and the one axis a user actually decides on
 * (how capable vs. how fast/cheap) was never presented at all. So a group opens as ONE ROW PER FAMILY, newest of
 * each, and the older versions live behind the disclosure grouped under their own family — because the intent
 * that reaches for Opus 4.7 is formed as "Opus, an older one", never as "row 11". Search still spans the whole
 * flat catalog and never truncates (see the component).
 *
 * Catalog order still decides everything it can: which version of a family is newest, and how families that
 * share a rank sit relative to each other. */

// A model's FAMILY — its id with every version-ish segment dropped, so claude-opus-5 and claude-opus-4-8 land
// together (as do gpt-5.1/gpt-5, and claude-haiku-4-5-20251001 with its date suffix). Derived, never listed:
// a family that ships tomorrow groups itself. The id is the stable key here — labels get renamed, ids don't.
const familyOf = (entry: PickerEntry): string => {
    const stem = entry.value
        .split(/[-_]/)
        .filter((segment) => !/^v?[\d.]+$/.test(segment))
        .join(`-`);
    // An all-numeric id (and the ACP row's empty one) has no stem to speak of; it stands as its own family.
    return stem === `` ? entry.value : stem;
};

// The family's header, taken from its newest row's label with the trailing version words peeled off ("Claude
// Opus 5" → "Claude Opus"). Reusing the published label keeps the header in the provider's own naming rather
// than in a phrase this repo invented, and a label that ends in a word ("Grok 4 Fast") simply stands as it is.
const familyLabelOf = (newest: PickerEntry): string => {
    const words = newest.label.split(/\s+/);
    while (words.length > 1 && /^v?[\d.]+$/.test(words.at(-1)!)) {
        words.pop();
    }
    return words.join(` `);
};

/* The ONE curated fact in this module, and the only one the providers publish nowhere the app can read: which
 * tier is the frontier and which is the cheap one. The SDK's alias list orders opus/sonnet/haiku but has no
 * Fable alias at all, so pure derivation would seat Fable — a frontier model — under Sonnet. Families sharing a
 * rank keep catalog order between them (the sort is stable).
 *
 * An UNKNOWN family LEADS rather than sinks. That direction is the point: the ranking this replaced sank
 * unrecognized ids to a floor below the everyday tier, so a brand-new flagship sorted beneath the model it
 * replaced — whereas a family nobody here has heard of, arriving at the head of a newest-first catalog, is far
 * likelier to be the next flagship than the next budget tier. Being wrong costs one row's position; being wrong
 * the other way hides a launch. */
const TIER_RANK: Readonly<Record<string, number>> = { opus: 0, fable: 0, sonnet: 1, haiku: 2 };

const rankOf = (family: string): number => {
    for (const segment of family.split(`-`)) {
        const rank = TIER_RANK[segment];
        if (rank !== undefined) {
            return rank;
        }
    }
    return -1;
};

export interface FamilyGroup {
    readonly key: string;
    readonly label: string;
    // The family's newest, i.e. its first row in the provider's own order — the row the collapsed group shows.
    readonly latest: PickerEntry;
    readonly older: readonly PickerEntry[];
}

// One group per family, in tier order. Membership and recency come from the catalog; only the tier order is ours.
export const familyGroups = (entries: readonly PickerEntry[]): readonly FamilyGroup[] => {
    const families = new Map<string, PickerEntry[]>();
    for (const entry of entries) {
        const key = familyOf(entry);
        const members = families.get(key);
        if (members === undefined) {
            families.set(key, [entry]);
            continue;
        }
        members.push(entry);
    }
    return [...families]
        .map(([key, members]) => ({ key, label: familyLabelOf(members[0]!), latest: members[0]!, older: members.slice(1) }))
        .toSorted((a, b) => rankOf(a.key) - rankOf(b.key));
};

export interface PickerBlock {
    readonly key: string;
    // Absent on the latest band — the provider header already names it, and a second header above the first row
    // of every group would out-shout the rows themselves.
    readonly label?: string;
    readonly entries: readonly PickerEntry[];
}

// The blocks a provider group renders: collapsed, a single band of one row per family; expanded, that band
// followed by each family's older versions under their own header. The pinned row is why the collapsed band
// isn't just the latest band — a user sitting on an older version would otherwise open the picker to a list
// with no checkmark anywhere in it, and no sign of which model the next turn actually runs.
export const pickerBlocks = (groups: readonly FamilyGroup[], selected: string | undefined, expanded: boolean): readonly PickerBlock[] => {
    const latest = groups.map((group) => group.latest);
    if (expanded) {
        return [
            { key: `latest`, entries: latest },
            ...groups.filter((group) => group.older.length > 0).map((group) => ({ key: group.key, label: group.label, entries: group.older })),
        ];
    }
    const pinned =
        selected === undefined || latest.some((entry) => entry.value === selected)
            ? undefined
            : groups.flatMap((group) => group.older).find((entry) => entry.value === selected);
    return [{ key: `latest`, entries: pinned === undefined ? latest : [...latest, pinned] }];
};

// Browse-mode grouping: one section per provider (respecting the rail filter), the active provider hoisted
// first — the models pickable without a session restart sit nearest — and the rest in stable PROVIDERS order.
// Empty sections are kept: the component renders their loading/error/empty state row under the header.
export const pickerSections = (
    entries: readonly PickerEntry[],
    activeProvider: AgentProvider,
    rail: AgentProvider | undefined,
): readonly { provider: AgentProvider; groups: readonly FamilyGroup[]; total: number }[] => {
    const providers: AgentProvider[] = [...PROVIDERS.map((option) => option.value), ...acpProviders.value.map((agent) => agent.id)].filter(
        (provider) => rail === undefined || provider === rail,
    );
    const order = providers.includes(activeProvider) ? [activeProvider, ...providers.filter((provider) => provider !== activeProvider)] : providers;
    return order.map((provider) => {
        const owned = entries.filter((entry) => entry.provider === provider);
        return { provider, groups: familyGroups(owned), total: owned.length };
    });
};
