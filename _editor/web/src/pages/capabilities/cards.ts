import type { CapabilitySummary } from "@intentic-app/api-contract";
import { type CapabilityCatalogEntry, type CapabilityCategory, contributionCard } from "@intentic-app/capability-catalog";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";

/* WHAT A CARD IS, AND WHICH OF YOUR CONNECTIONS CAME FROM IT.
 *
 * The capabilities page is two questions wearing one grid — "what could I add" and "what have I got" — and both
 * are answered by joining a catalog entry to the live instances that match it. That join is the part with rules
 * in it: which field tells two cards of one kind apart, what a free name for the next connection is, which glyph
 * stands in when a brand has no logo. Kept here as plain functions over their inputs so each one can be read,
 * and pinned, without a page around it. */

// A category's glyph. It is not in CAPABILITY_CATEGORIES because a category is a fact about the catalog and this
// is a fact about the rail that slices it — the same list is rendered as plain headings elsewhere. A
// contribution declaring an unknown category lands under `extend` (contributionCard), so the record stays total.
export const CATEGORY_ICONS: Readonly<Record<CapabilityCategory, IconName>> = {
    platform: `sitemap`,
    code: `code`,
    observability: `wave-pulse`,
    data: `database`,
    communication: `comments`,
    business: `credit-card`,
    machines: `desktop`,
    servers: `server`,
    deploy: `cloud-upload`,
    extend: `th-large`,
};

// The glyph tier <BrandMark> falls to when a card has no simple-icons logo (or the slug fails to load). A card
// is never left to the initials tier — its KIND is always known, and "some connector" drawn as a bolt beats it
// drawn as two letters. A kind with no entry here takes the bolt.
const KIND_ICONS: Readonly<Record<string, IconName>> = {
    devops: `server`,
    monorepo: `sitemap`,
    service: `box`,
    integration: `link`,
    plugin: `th-large`,
    browser: `globe`,
    identity: `user`,
    agent: `sparkles`,
};

export const entryIcon = (entry: CapabilityCatalogEntry): IconName => (entry.icon as IconName | undefined) ?? KIND_ICONS[entry.kind] ?? `bolt`;

/* THE CARDS THE ENABLED EXTENSIONS CONTRIBUTE, first declaration of a kind+id winning — the daemon
 * contributionRegistry's precedent. Enabled, not installed: a switched-off extension stays listed so its switch
 * is reachable, but the daemon wires none of its contributions up, so a card from one would fail the add it
 * advertises. */
export const contributedCards = (extensions: readonly ExtensionSummary[]): CapabilityCatalogEntry[] => {
    const seen = new Set<string>();
    const cards: CapabilityCatalogEntry[] = [];
    for (const extension of extensions) {
        for (const contribution of extension.manifest.contributes?.capabilities ?? []) {
            const key = `${contribution.kind}:${contribution.id}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            cards.push(contributionCard(contribution));
        }
    }
    return cards;
};

/* The browser cards' core `identity` field, narrowed to what this sandbox can actually answer: a picker over the
 * identities that exist, or nothing at all when none do. The catalog declares the field without options because
 * the manifest cannot know instance state; a free-text id here would only mint dangling references the daemon
 * then rejects. "Standalone" is the empty value — buildConfig drops empty answers, so the config carries no
 * `identity` key rather than an empty one. */
export const withIdentityPicker = (entry: CapabilityCatalogEntry, identities: readonly string[]): CapabilityCatalogEntry => {
    if (entry.kind !== `browser`) {
        return entry;
    }
    if (identities.length === 0) {
        return { ...entry, fields: entry.fields.filter((field) => field.key !== `identity`) };
    }
    const options = [{ value: ``, label: `Standalone` }, ...identities.map((id) => ({ value: id, label: id }))];
    return { ...entry, fields: entry.fields.map((field) => (field.key === `identity` ? { ...field, options } : field)) };
};

/* Cards that share a `kind` are told apart by a discriminator field the card fixes — `provider` for the cli
 * cards, `platform` for the browser cards (both map straight to the capability's config). The value is a single
 * fixed value, or the options for a multi-provider card (the SQL card owns postgres + mysql). Single-card kinds
 * (mcp/plugin/ssh/…) have no such field → undefined → every instance of the kind matches. */
const cardDiscriminator = (entry: CapabilityCatalogEntry): { key: string; values: string[] } | undefined => {
    const field = entry.fields.find((candidate) => candidate.key === `provider` || candidate.key === `platform`);
    if (field === undefined) {
        return undefined;
    }
    return { key: field.key, values: field.value !== undefined ? [field.value] : (field.options ?? []).map((option) => option.value) };
};

// The live connections a card is answerable for.
export const instancesOf = (entry: CapabilityCatalogEntry, capabilities: readonly CapabilitySummary[]): CapabilitySummary[] => {
    const disc = cardDiscriminator(entry);
    if (disc === undefined) {
        return capabilities.filter((capability) => capability.kind === entry.kind);
    }
    return capabilities.filter((capability) => capability.kind === entry.kind && disc.values.includes(String(capability.config[disc.key])));
};

// A free instance name: the provider id if unused, else the first `<id>-2`, `-3`, … so repeat adds create
// distinct connections instead of upserting the same id (the silent-overwrite trap).
export const suggestName = (entry: CapabilityCatalogEntry, instances: readonly CapabilitySummary[]): string => {
    // A one-per-sandbox card never bumps: the id IS the instance, so re-picking the card lands on the entry that
    // exists and the submit reads "Update" instead of quietly minting a second one.
    if (entry.singleton === true) {
        return entry.id;
    }
    const taken = new Set(instances.map((instance) => instance.id));
    if (!taken.has(entry.id)) {
        return entry.id;
    }
    let n = 2;
    while (taken.has(`${entry.id}-${n}`)) {
        n += 1;
    }
    return `${entry.id}-${n}`;
};

/* WHAT THE FILTER BOX MATCHES A CARD ON. The kind is searched alongside the words a reader can see, because it
 * is what somebody typing "mcp" or "ssh" means — those are the names of the things, and no card's prose repeats
 * them. The HINT is searched for the mirror reason: a tile's description is one line, so the words that identify
 * a card to the person looking for it ("webauthn", "socket mode", "botfather") live in prose the grid no longer
 * prints. Searching only what is visible would make the catalog findable exactly to the extent it is already
 * scannable, which is backwards. */
export const cardHaystack = (entry: CapabilityCatalogEntry): string =>
    `${entry.name} ${entry.description} ${entry.kind} ${entry.hint ?? ``}`.toLowerCase();
