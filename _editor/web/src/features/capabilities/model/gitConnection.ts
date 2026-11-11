import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { type GitConnection, gitConnectionsFor } from "@intentic/sandbox-contract/policy/git/git-connections";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { FormValues, StoredSecrets } from "../../../models/capabilities/form";

// WHICH GITHUB OR GITLAB CARD READS A PLUGIN'S OR AN EXTENSION'S REPOSITORY, as the install form says it. The daemon
// clones with the same card (git-connection.ts there), chosen by the same shared rule, so what the form names is what
// the clone uses; the form sends its choice by id, so a second card for the host never changes it behind the reader.

/** The one field this stands in for: an install's `gitConnection`, drawn as a sentence or a choice, never a text box. */
export const readsWithConnection = (entry: CapabilityCatalogEntry, field: CapabilityField): boolean =>
    (entry.kind === `plugin` || entry.kind === `extension`) && field.key === `gitConnection`;

/** Whether a token of the install's own stands in for every card: one typed under Advanced, or one this edit keeps. */
export const ownToken = (values: Readonly<FormValues>, stored: StoredSecrets): boolean => (values[`token`] ?? ``).trim() !== `` || stored.has(`token`);

/** The connected cards whose token answers for the repository's host, first the one picked by default. */
export const offeredConnections = (capabilities: readonly CapabilitySummary[], url: string): readonly GitConnection[] =>
    gitConnectionsFor(capabilities, url);

/**
 * What the form submits for the field: nothing while the install's own token is used or no card matches; else the card
 * already chosen while it is still offered, and the first one otherwise.
 */
export const chosenConnection = (offered: readonly GitConnection[], current: string | undefined, tokenOwn: boolean): string => {
    if (tokenOwn || offered.length === 0) {
        return ``;
    }
    return offered.find((connection) => connection.id === current)?.id ?? offered[0]?.id ?? ``;
};
