import type { CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, type CapabilityCategory, contributionCard } from "@intentic/capability-catalog";
import { contributionDiscriminator } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";

// A card's facts and which live connections came from it: the catalog and connected-inventory questions both join a
// catalog entry to matching instances. That join's rules (which field distinguishes two cards of one kind, a free
// name for the next connection, the fallback glyph) live here as plain functions.

// Rail glyph per category, kept separate from CAPABILITY_CATEGORIES since it's a fact about the rail, not the
// catalog. An unknown category lands under `extend` (contributionCard), keeping the record total.
export const CATEGORY_ICONS: Readonly<Record<CapabilityCategory, IconName>> = {
    platform: `sitemap`,
    code: `code`,
    observability: `wave-pulse`,
    data: `database`,
    communication: `comments`,
    business: `credit-card`,
    devices: `desktop`,
    servers: `server`,
    deploy: `cloud-upload`,
    extend: `th-large`,
};

// Fallback glyph tier when a card has no logo (or it fails to load): a kind's own icon, never bare initials, since
// the kind is always known. No entry here falls to the bolt.
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

// Cards the enabled extensions contribute, first declaration of a kind+id winning (contributionRegistry's
// precedent). Enabled, not installed: a switched-off extension still lists so its switch is reachable, but its
// contributions aren't wired up.
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

// Browser cards' `identity` field narrowed to identities that actually exist (a picker, or no field at all), since
// the manifest can't know instance state and a free-text id would only mint dangling references. `Standalone` is
// the empty value; buildConfig then drops it rather than storing an empty key.
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

// Card↔instance join, shared with the daemon's capability ask gate so the two sides can't drift on discriminator
// rules.
export { instancesOf } from "@intentic/capability-catalog";

// Which card a live connection came from (instancesOf run backwards): a kind's cards pin their own id into the
// instance's config (contributionDiscriminator), so that field is the lookup; a kind with no discriminator has
// exactly one card. Returns the card's face only, since that's all any caller wants.
export interface CapabilityFace {
    /** The card's id, a connection that never got a name of its own took it (suggestName). */
    readonly id: string;
    /** The card as a person names it: "Reddit", "Identity", "SSH". */
    readonly name: string;
    readonly logo?: string | undefined;
    readonly icon?: string | undefined;
}

export const capabilityCard = (capability: CapabilitySummary, extensions: readonly ExtensionSummary[]): CapabilityFace | undefined => {
    const key = contributionDiscriminator(capability.kind);
    const cardId = key === undefined ? undefined : String(capability.config[key] ?? ``);
    const contribution = extensions
        .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
        .find((entry) => entry.kind === capability.kind && entry.id === cardId);
    if (contribution !== undefined) {
        return { id: contribution.id, ...contribution.catalog };
    }
    const card = CAPABILITY_CATALOG.find((entry) => entry.kind === capability.kind);
    return card === undefined ? undefined : { id: card.id, name: card.name, logo: card.logo, icon: card.icon };
};

// Just the mark, for rows that name a connection with something of their own (a skill's title, a secret's key).
// Either half may be absent for the caller's own tiers to fill; a card declaring neither answers undefined, never
// an empty object.
export const capabilityMark = (
    capability: CapabilitySummary,
    extensions: readonly ExtensionSummary[],
): { readonly logo?: string | undefined; readonly icon?: string | undefined } | undefined => {
    const card = capabilityCard(capability, extensions);
    if (card === undefined || (card.logo === undefined && card.icon === undefined)) {
        return undefined;
    }
    return { logo: card.logo, icon: card.icon };
};

// A free instance name: the provider id if unused, else the first `<id>-2`, `-3`, ... so repeat adds create distinct
// connections instead of upserting one (the silent-overwrite trap).
export const suggestName = (entry: CapabilityCatalogEntry, instances: readonly CapabilitySummary[]): string => {
    // A singleton card never bumps: the id is the instance, so re-picking lands on the existing entry and submit reads
    // "Update".
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

// Kind is searched alongside visible words, since that's what typing "mcp" or "ssh" means and no card's prose
// repeats them. Hint is searched too, since a tile's one-line description drops identifying terms ("webauthn",
// "botfather") that used to be visible.
export const cardHaystack = (entry: CapabilityCatalogEntry): string =>
    `${entry.name} ${entry.description} ${entry.kind} ${entry.hint ?? ``}`.toLowerCase();
