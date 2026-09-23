import type { CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, type CapabilityCategory, contributionEntry } from "@intentic/capability-catalog";
import { contributionDiscriminator } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { cleanName } from "./form";

// A tile's facts and which live connections came from it: the catalog and connected-inventory questions both join a
// catalog entry to matching instances. That join's rules (which field distinguishes two tiles of one kind, a free
// name for the next connection, the fallback glyph) live here as plain functions.

// Rail glyph per category, kept separate from CAPABILITY_CATEGORIES since it's a fact about the rail, not the
// catalog. An unknown category lands under `extend` (contributionEntry), keeping the record total.
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

// Fallback glyph tier when a tile has no logo (or it fails to load): a kind's own icon, never bare initials, since
// the kind is always known. No entry here falls to the bolt.
const KIND_ICONS: Readonly<Record<string, IconName>> = {
    devops: `server`,
    monorepo: `sitemap`,
    plugin: `th-large`,
    browser: `globe`,
    identity: `user`,
    agent: `sparkles`,
};

export const entryIcon = (entry: CapabilityCatalogEntry): IconName => (entry.icon as IconName | undefined) ?? KIND_ICONS[entry.kind] ?? `bolt`;

// Tiles the enabled extensions contribute, first declaration of a kind+id winning (contributionRegistry's
// precedent). Enabled, not installed: a switched-off extension still lists so its switch is reachable, but its
// contributions aren't wired up.
export const contributedTiles = (extensions: readonly ExtensionSummary[]): CapabilityCatalogEntry[] => {
    const seen = new Set<string>();
    const tiles: CapabilityCatalogEntry[] = [];
    for (const extension of extensions) {
        for (const contribution of extension.manifest.contributes?.capabilities ?? []) {
            const key = `${contribution.kind}:${contribution.id}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            tiles.push(contributionEntry(contribution));
        }
    }
    return tiles;
};

// Browser tiles' `identity` field narrowed to identities that actually exist (a picker, or no field at all), since
// the manifest can't know instance state and a free-text id would only mint dangling references. `Standalone` is
// the empty value; buildConfig then drops it rather than storing an empty key.
export const withIdentityPicker = (entry: CapabilityCatalogEntry, identities: readonly string[]): CapabilityCatalogEntry => {
    if (entry.kind !== `browser`) {
        return entry;
    }
    if (identities.length === 0) {
        return { ...entry, fields: entry.fields.filter((field) => field.key !== `identity`) };
    }
    const options = [{ value: ``, label: t(`capabilities.tiles.standalone`) }, ...identities.map((id) => ({ value: id, label: id }))];
    return { ...entry, fields: entry.fields.map((field) => (field.key === `identity` ? { ...field, options } : field)) };
};

// Every tile the page offers: the enabled extensions' contributions, then the static core catalog, each browser tile's
// identity field narrowed to the identities this sandbox actually holds.
export const catalogEntries = (enabled: readonly ExtensionSummary[], capabilities: readonly CapabilitySummary[]): CapabilityCatalogEntry[] => {
    const identities = capabilities.filter((instance) => instance.kind === `identity`).map((instance) => instance.id);
    return [...contributedTiles(enabled), ...CAPABILITY_CATALOG].map((entry) => withIdentityPicker(entry, identities));
};

// Which tile a live connection came from (instancesOf run backwards): a kind's tiles pin their own id into the
// instance's config (contributionDiscriminator), so that field is the lookup; a kind with no discriminator has
// exactly one tile. Returns the tile's face only, since that's all any caller wants.
export interface CapabilityFace {
    /** The tile's id, a connection that never got a name of its own took it (suggestName). */
    readonly id: string;
    /** The tile as a person names it: "Reddit", "Identity", "SSH". */
    readonly name: string;
    readonly logo?: string | undefined;
    readonly icon?: string | undefined;
}

export const capabilityTile = (capability: CapabilitySummary, extensions: readonly ExtensionSummary[]): CapabilityFace | undefined => {
    const key = contributionDiscriminator(capability.kind);
    const entryId = key === undefined ? undefined : String(capability.config[key] ?? ``);
    const contribution = extensions
        .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
        .find((entry) => entry.kind === capability.kind && entry.id === entryId);
    if (contribution !== undefined) {
        return { id: contribution.id, ...contribution.catalog };
    }
    const tile = CAPABILITY_CATALOG.find((entry) => entry.kind === capability.kind);
    return tile === undefined ? undefined : { id: tile.id, name: tile.name, logo: tile.logo, icon: tile.icon };
};

// Just the mark, for rows that name a connection with something of their own (a skill's title, a secret's key).
// Either half may be absent for the caller's own tiers to fill; a tile declaring neither answers undefined, never
// an empty object.
export const capabilityMark = (
    capability: CapabilitySummary,
    extensions: readonly ExtensionSummary[],
): { readonly logo?: string | undefined; readonly icon?: string | undefined } | undefined => {
    const tile = capabilityTile(capability, extensions);
    if (tile === undefined || (tile.logo === undefined && tile.icon === undefined)) {
        return undefined;
    }
    return { logo: tile.logo, icon: tile.icon };
};

// A free instance name: the provider id if unused, else `<id>-<who>` when the service has said whose credential this is
// (the probe's answer), else the first `<id>-2`, `-3`, ... so repeat adds create distinct connections instead of
// upserting one (the silent-overwrite trap). The first connection keeps the bare id either way: that is the name the
// rest of the page treats as "unnamed", and one GitHub needs no qualifier.
export const suggestName = (entry: CapabilityCatalogEntry, instances: readonly CapabilitySummary[], who?: string): string => {
    // A singleton tile never bumps: the id is the instance, so re-picking lands on the existing entry and submit reads
    // "Update".
    if (entry.singleton === true) {
        return entry.id;
    }
    const taken = new Set(instances.map((instance) => instance.id));
    if (!taken.has(entry.id)) {
        return entry.id;
    }
    const qualifier = who === undefined ? `` : cleanName(who).toLowerCase();
    const base = qualifier === `` ? entry.id : `${entry.id}-${qualifier}`;
    if (base !== entry.id && !taken.has(base)) {
        return base;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`)) {
        n += 1;
    }
    return `${base}-${n}`;
};

// The name a freshly opened form carries, and whether it counts as chosen: a chosen one is never overwritten by the
// live suggestion as connections come and go. Editing keeps the connection's own name; adding suggests a free one.
export const openingName = (
    entry: CapabilityCatalogEntry,
    editing: CapabilitySummary | undefined,
    instances: readonly CapabilitySummary[],
    device: string,
): { readonly name: string; readonly chosen: boolean } => {
    if (editing !== undefined) {
        return { name: editing.id, chosen: false };
    }
    // A machine that already syncs arrives with its own name: both doors named alike fold into one row (mergeDevices).
    return device === `` ? { name: suggestName(entry, instances), chosen: false } : { name: device, chosen: true };
};

// Whether a connection still carries the name its tile handed it (`linux`, `linux-2`): the one case where a better
// name learned later (a machine's hostname) is offered, since a name the owner typed is theirs.
export const isDefaultName = (entryId: string, id: string): boolean =>
    id === entryId || (id.startsWith(`${entryId}-`) && /^\d+$/.test(id.slice(entryId.length + 1)));

// Kind is searched alongside visible words, since that's what typing "mcp" or "ssh" means and no tile's prose
// repeats them. Hint is searched too, since a tile's one-line description drops identifying terms ("webauthn",
// "botfather") that used to be visible.
export const entryHaystack = (entry: CapabilityCatalogEntry): string =>
    `${entry.name} ${entry.description} ${entry.kind} ${entry.hint ?? ``}`.toLowerCase();
