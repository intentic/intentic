import { type CapabilityCatalogEntry, type CapabilityEffect, capabilityEffects } from "@intentic/capability-catalog";
import { type CapabilityContribution, contributionDiscriminator } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { type FormValues, fieldConfig } from "./form";

// What a tile adds to the sandbox, read through capabilityEffects with the contribution behind it: the form's live
// "This will add to your sandbox" panel, and the consequences badged on the grid's tile.

// One card's contribution among the enabled extensions (useExtensions.contributionOf).
export type ContributionOf = (kind: CapabilityKind, id: string) => CapabilityContribution | undefined;

// The contribution behind a config, via the kind's discriminator; undefined for a kind with no secret/image
// declarations or a core-only kind.
export const contributionFor = (
    contributionOf: ContributionOf,
    kind: CapabilityKind,
    config: Record<string, string | number | boolean | undefined>,
): CapabilityContribution | undefined => {
    const key = contributionDiscriminator(kind);
    if (key === undefined) {
        return undefined;
    }
    return contributionOf(kind, String(config[key] ?? ``));
};

// Live over the form's answers so a plugin clone URL tracks typing; the open tile's extension is always enabled, so
// contributionOf always resolves here.
export const formEffects = (
    entry: CapabilityCatalogEntry,
    values: Readonly<FormValues>,
    name: string,
    contributionOf: ContributionOf,
): readonly CapabilityEffect[] => {
    const config = fieldConfig(entry, (field) => (values[field.key] ?? ``).trim());
    return capabilityEffects({
        kind: entry.kind,
        id: name.trim() || undefined,
        config,
        contribution: contributionFor(contributionOf, entry.kind, config),
    });
};

const BADGED_EFFECTS = new Set([`image`, `runtime`, `trusted-code`]);

// Consequential effects a tile statically implies, badged on its grid tile; defaults decide config-dependent ones
// (e.g. SQL's default engine).
export const tileBadges = (entry: CapabilityCatalogEntry, contributionOf: ContributionOf): readonly CapabilityEffect[] => {
    const config = fieldConfig(entry, (field) => field.default);
    return capabilityEffects({ kind: entry.kind, config, contribution: contributionFor(contributionOf, entry.kind, config) }).filter((effect) =>
        BADGED_EFFECTS.has(effect.kind),
    );
};
