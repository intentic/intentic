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
import { type ModelOption, acpProviders, endpointProviders, modelOptionsFor, providerGroup, providerGroupLabel } from "./providerCatalog";
import type { TurnPick } from "./turnDefaults";

/* The unified model-picker list: every provider's models flattened into one searchable entry set. Pure
 * derivation over the live catalogs (conversation.ts), the picker component owns only its transient UI state
 * (query, rail filter, highlight). The harness (Default / Claude Code) is a separate axis, chosen via the
 * picker's footer chips. NOT a row here, because codex/grok run the same subscription model ids under either
 * harness, so the list no longer forks by harness.
 *
 * Every rendered fact about a model, label, description, badges, comes from the provider's own catalog, always
 * current, needing no edit when a model ships. Rows a provider publishes nothing about render label-only; that is
 * the intended end state, not a gap to backfill. What a provider does NOT reliably publish is an ORDER: only
 * Anthropic's catalog arrives ranked (newest-first), the rest arrive in registry order out of an
 * OpenAI-compatible /v1/models. So tier and recency are derived from the model id by the contract's
 * model-order.ts, one rule the daemon's catalogs and this picker share, and catalog order survives only as the
 * tiebreak between ids that rule cannot separate. */

// A picker row IS a pick (TurnPick: provider + model id) with the words to draw it, which is why picking one is
// `selectModel(entry)` and not a re-assembly of its fields into some other shape.
export interface PickerEntry extends TurnPick {
    // `${provider}:${value}`, the model id is unique within a provider's (harness-independent) catalog.
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

// Every pickable model across providers, in PROVIDERS order: each provider's catalog (live, with the static
// floor pre-load). Then the capability-derived providers, which append rows on opposite terms, a model endpoint
// contributes its whole catalog (its server publishes one, read on the same seam as everyone else's), while an
// installed ACP agent contributes exactly one row, because the agent owns its own model and so the row IS the
// provider (empty model id).
export const pickerEntries = computed<readonly PickerEntry[]>(() => [
    ...PROVIDERS.flatMap(({ value: provider }) => modelOptionsFor(provider).map((option) => entryFor(provider, option))),
    ...endpointProviders.value.flatMap((endpoint) => modelOptionsFor(endpoint.id).map((option) => entryFor(endpoint.id, option))),
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

/* LANES: WHAT THIS PICKER GROUPS BY, one per provider, except that every locally-run model shares one.
 *
 * A localmodel capability is a provider like any other to whatever ROUTES a turn: its own id, its own server,
 * its own catalog. To someone reading the picker it is not one. A sandbox with two cards drew two identical cpu
 * chips down the rail, and each opened a header over a group holding exactly one model, so the rail said
 * nothing (both chips look the same) and the list said nothing (a group of one is not a grouping). Weights the
 * user runs themselves are ONE thing to choose among, so the rail draws one chip for them and the list one
 * group, seated where the first card sat.
 *
 * WHICH providers those are is `providerGroup` (providerCatalog.ts), shared with the Usage tab rather than
 * decided twice: the two surfaces fold the same family for the same reason, and the ledger's copy of the rule
 * had drifted into drawing a pill per card.
 *
 * Folded for READING only. A row still carries the provider that vends it, so picking one routes to that card
 * exactly as before, and every other provider keeps its own lane. */
export interface PickerLane {
    // The rail filter's value and the section's key: a provider id, or LOCAL_MODELS_GROUP for the folded one.
    readonly key: string;
    readonly label: string;
    // Every provider drawn in this lane, in the order given. Exactly one, except in the folded lane.
    readonly providers: readonly AgentProvider[];
}

// Providers folded into the lanes they are drawn in, each seated where its first provider sat, so the rail and
// the list stay the same set of groups in whatever order each of them reads its providers in.
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

// Case-insensitive substring search, multi-token AND: every whitespace-separated token must match somewhere
// in the entry's label/id/provider/badges. `rail` scopes to one lane first (the rail filter persists
// while searching). Descriptions are deliberately not matched, copy produces baffling hits. `isReady` is the
// same connection predicate the browse view sorts on (access.ts): a model the user can send to outranks one
// they'd have to connect a subscription for, however well the id matched.
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
    // Runnable first, then match quality; equal hits keep catalog order (toSorted is stable), as in browse.
    return matched.toSorted((a, b) => Number(isReady(b.provider)) - Number(isReady(a.provider)) || rankFor(a, tokens) - rankFor(b, tokens));
};

// The custom-model escape hatch: any id the user types that no catalog row already offers, mirroring Claude
// Code's own `/model <id>`, which accepts an arbitrary string and lists it as a "Custom model". A provider's
// catalog can lag a release, a REST /v1/models entry still has to reach the account, so during that window
// typing the id is the ONLY way to drive a model that already serves turns. Offered on an exact-id miss only,
// so it never competes with a real catalog hit, and it carries no metadata because none is published: an
// unrecognized id is exactly as unknown to us as it looks.
export const customEntryFor = (entries: readonly PickerEntry[], query: string, provider: AgentProvider): PickerEntry | undefined => {
    const value = query.trim();
    // A model id is a hyphenated, whitespace-free token (claude-opus-5, gpt-5.1, grok-4-fast). Requiring the
    // hyphen is what stops an ordinary search word, "fast", "opus", from offering a junk row on every
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

/* FAMILY-MAJOR BROWSING. A provider's catalog is a SET OF RELEASES, and rendering it straight made the picker a
 * version history rather than a menu: Claude's account list opened with five Opus versions in a row, so Haiku,
 * a whole tier, sat below the fold and the one axis a user actually decides on (how capable vs. how fast/cheap)
 * was never presented at all. Under the other providers it was worse than a version history: their catalogs
 * arrive in registry order, so the Codex group opened on GPT 5.4 Mini with GPT 5.6 sorted below it. So a group
 * opens as ONE ROW PER FAMILY, newest of each, tier-major, and the older versions live behind the disclosure
 * grouped under their own family, because the intent that reaches for Opus 4.7 is formed as "Opus, an older
 * one", never as "row 11". Search still spans the whole flat catalog and never truncates (see the component).
 *
 * Membership, recency and tier are all derived from the model id (compareModelIds/familyOf, shared with the
 * daemon's catalogs); catalog order decides only what that rule leaves tied, for Claude, whose catalog really
 * is the provider's own newest-first ranking, that is exactly the tie between two same-tier same-version rows. */

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

export interface FamilyGroup {
    readonly key: string;
    readonly label: string;
    // The family's newest by version, the row the collapsed group shows.
    readonly latest: PickerEntry;
    readonly older: readonly PickerEntry[];
}

// One group per family: members newest-first, groups tier-major. The same comparator does both jobs, because
// within a family the tier is constant and only the release differs.
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
    // Absent on the latest band, the provider header already names it, and a second header above the first row
    // of every group would out-shout the rows themselves.
    readonly label?: string;
    readonly entries: readonly PickerEntry[];
}

// The blocks a provider group renders: collapsed, a single band of one row per family; expanded, that band
// followed by each family's older versions under their own header. The pinned row is why the collapsed band
// isn't just the latest band, a user sitting on an older version would otherwise open the picker to a list
// with no checkmark anywhere in it, and no sign of which model the next turn actually runs.
export const pickerBlocks = (groups: readonly FamilyGroup[], selected: string | undefined, expanded: boolean): readonly PickerBlock[] => {
    const latest = groups.map((group) => group.latest);
    if (expanded) {
        return [
            { key: `latest`, entries: latest },
            // Keyed by the family's newest ROW, not by the family: a folded lane holds several cards, and two of
            // them can publish the same family, which as a bare family key would be one key drawn twice.
            ...groups.filter((group) => group.older.length > 0).map((group) => ({ key: group.latest.key, label: group.label, entries: group.older })),
        ];
    }
    const pinned =
        selected === undefined || latest.some((entry) => entry.value === selected)
            ? undefined
            : groups.flatMap((group) => group.older).find((entry) => entry.value === selected);
    return [{ key: `latest`, entries: pinned === undefined ? latest : [...latest, pinned] }];
};

/* WHAT A LOCKED PROVIDER COSTS, as a sort key. `free` before `subscription` before `key` (ACCESS_COST, the
 * contract's own ordering), and everything the table says nothing about last: an ACP agent and a model endpoint
 * carry their own credentials, so they are never in the locked band to begin with.
 *
 * This is the whole of the free channel's promotion, and it replaced a card. The free Google sign-in used to be
 * pitched by a headline and a button on the first screen anyone saw after signing up, which read as a wall; and
 * in this list, where the choice is actually made, it sat LAST of five locked rows purely because `gemini` comes
 * last in PROVIDERS. Now the cheapest way in leads the band it belongs to, under the badge accessBadge already
 * derives from the same table. A channel that stops being free stops leading, from one edit to PROVIDER_ACCESS. */
const accessRank = (provider: AgentProvider): number => {
    const access = accessFor(provider);
    return access === undefined ? Object.keys(ACCESS_COST).length : ACCESS_COST[access.kind];
};

export interface PickerSection extends PickerLane {
    readonly groups: readonly FamilyGroup[];
    readonly total: number;
}

// Browse-mode grouping: one section per lane (respecting the rail filter), the active provider's lane hoisted
// first, the models pickable without a session restart sit nearest, then every CONNECTED provider, then the
// ones that still need a credential, cheapest first. Sorting on `isReady` is what stops the list from opening on
// models the user cannot send to: every provider's catalog is non-empty by construction (the daemon serves a
// seed floor), so without it an unconnected Kimi outranks a connected Claude purely by sitting earlier in
// PROVIDERS. Empty sections are kept: the component renders their loading/error/empty state row under the
// header.
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
    /* The active provider leads whether or not it is connected, it is the one the composer will send on, so
     * burying it under the connected band would hide the selection the user is actually sitting on.
     *
     * Then: connected first, and WITHIN the locked band, cheapest first. The cost only ever separates locked
     * rows, a connected provider costs the user nothing to pick whatever its badge would have said, so ranking
     * the connected band by price would reorder working providers for no reason a reader could see. */
    const rest = providers
        .filter((provider) => provider !== activeProvider)
        .toSorted((a, b) => {
            const ready = Number(isReady(b)) - Number(isReady(a));
            return ready !== 0 || isReady(a) ? ready : accessRank(a) - accessRank(b);
        });
    const order = providers.includes(activeProvider) ? [activeProvider, ...rest] : rest;
    // Fold AFTER ordering, so the local lane is seated by the best-placed card it holds: the one the composer
    // is sending on leads the list whichever of the cards it is.
    return lanesOf(order)
        .filter((lane) => rail === undefined || lane.key === rail)
        .map((lane) => {
            const owned = entries.filter((entry) => lane.providers.includes(entry.provider));
            // Families are derived per CARD and never across them: two local endpoints serving qwen3-8 and
            // qwen3-32 are two machines, not two releases of one model, and grouping them together would file
            // one of the user's own models behind the other's "show older" disclosure.
            const groups = lane.providers.flatMap((provider) => familyGroups(owned.filter((entry) => entry.provider === provider)));
            return { key: lane.key, label: lane.label, providers: lane.providers, groups, total: owned.length };
        });
};
