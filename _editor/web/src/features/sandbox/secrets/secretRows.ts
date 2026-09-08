import type { CapabilitySummary } from "@intentic/api-contract";
import type { ExtensionSummary, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { capabilityCard } from "../../capabilities/model/cards";
import { type ConnectionState, connectionFacts, connectionState } from "../../capabilities/model/connections";

// A secret row: an inventory entry plus what the daemon can't supply (a label, a distinguishing detail, whether
// anything is owed). `group` splits owner-set values (editable here) from connection or subscription credentials
// (managed elsewhere, named via `capabilityCard`). `attention` is only ever a secrets-tab fix, never a connection's own
// health.

/** Where a row belongs; the first three cases are the owner's to set. */
export type SecretGroup = `required` | `yours` | `generated` | `credential` | `provider`;

export interface SecretRow {
    readonly entry: SecretInventoryEntry;
    readonly group: SecretGroup;
    /** What the row is called: the env key, or the account's own name. */
    readonly title: string;
    /** Env keys are compared character by character; account names are read as words. */
    readonly mono: boolean;
    /** What tells this row apart from its neighbours, what uses it, or which account it belongs to. */
    readonly detail: string;
    readonly logo?: string | undefined;
    readonly icon: string;
    /** Something is owed here: a required value nobody set, or a copy CI never got. */
    readonly attention: boolean;
    /** That debt in the reader's words, absent when there is none. */
    readonly note?: string | undefined;
    /** The connection's state, for the rows that have one. Colours the row and sorts it inside its group. */
    readonly state?: ConnectionState | undefined;
    /** Set/update and remove are offered only where the write actually goes somewhere. */
    readonly editable: boolean;
    readonly removable: boolean;
    /**
     * Gate subject when this row can be gated; absent for an unset value or an AI subscription (nothing to release).
     */
    readonly gateSubject?: string | undefined;
    /** True for a mounted credential (browser, identity, MCP); the daemon always scopes those to the conversation. */
    readonly sessionShaped: boolean;
    /** Everything the filter box matches, already folded. */
    readonly haystack: string;
}

/** The already-cached reads a row needs to find out whose credential it is. */
export interface SecretSources {
    readonly capabilities: readonly CapabilitySummary[];
    readonly extensions: readonly ExtensionSummary[];
}

// A generated value is intentic's to write; a provider account is the subscription's. Neither is typed in.
const GROUPS: Readonly<Record<SecretInventoryEntry[`kind`], SecretGroup | undefined>> = {
    env: undefined,
    generated: `generated`,
    capability: `credential`,
    provider: `provider`,
};

const groupOf = (entry: SecretInventoryEntry): SecretGroup => GROUPS[entry.kind] ?? (entry.requiredBy.length > 0 ? `required` : `yours`);

// Fallback glyph when a card declares none, and the fixed glyph every AI subscription wears (no card to ask).
const CREDENTIAL_GLYPH = `key`;
const PROVIDER_GLYPH = `sparkles`;

const usedBy = (entry: SecretInventoryEntry): string =>
    entry.requiredBy.length === 0 ? `` : `used by ${entry.requiredBy.map((use) => use.resourceId).join(`, `)}`;

// Priority: an unset value, then a stale CI copy. A gate needing approval is not a debt (never sets `attention`)
// but still worth a line so a reader sees why a turn could not use it.
const noteOf = (entry: SecretInventoryEntry): string | undefined => {
    if (entry.status === `missing`) {
        return `not set`;
    }
    if (entry.ci !== undefined && !entry.ci.synced) {
        return `CI hasn't got this yet`;
    }
    return entry.gate === undefined ? undefined : `needs approval from ${entry.gate.approvers.join(` or `)}`;
};

// Lets the filter match a gated row by its approvers' addresses too (e.g. "who is waiting on Bob").
const gateHaystack = (entry: SecretInventoryEntry): string =>
    entry.gate === undefined ? `` : ` needs approval ${entry.gate.approvers.join(` `)}`;

const credentialRow = (entry: SecretInventoryEntry, sources: SecretSources): SecretRow | undefined => {
    const instance = sources.capabilities.find((capability) => capability.id === entry.key);
    if (instance === undefined) {
        return undefined;
    }
    const card = capabilityCard(instance, sources.extensions);
    // Unnamed connections took the card's id; the card's name is the better spelling of it.
    const named = card === undefined || instance.id !== card.id;
    const facts = connectionFacts(instance);
    return {
        entry,
        group: `credential`,
        title: named ? instance.id : (card?.name ?? instance.id),
        mono: false,
        detail: [named ? card?.name : undefined, facts].filter((part) => part !== undefined && part !== ``).join(` · `),
        logo: card?.logo,
        icon: card?.icon ?? CREDENTIAL_GLYPH,
        attention: false,
        // A gated connection is not loaded into a turn; the note distinguishes that from a broken connection.
        ...(entry.gate === undefined ? {} : { note: `needs approval from ${entry.gate.approvers.join(` or `)}` }),
        state: connectionState(instance.kind, instance, undefined),
        editable: true,
        removable: false,
        gateSubject: instance.id,
        sessionShaped: instance.kind === `browser` || instance.kind === `identity` || instance.kind === `mcp`,
        haystack: `${instance.id} ${card?.name ?? ``} ${instance.kind} ${facts}${gateHaystack(entry)}`.toLowerCase(),
    };
};

// Shown even if its capability is gone (removed elsewhere, list still in flight): the credential is still in the
// box, and a row silently disappearing is worse than a thin one.
const bareRow = (entry: SecretInventoryEntry, group: SecretGroup): SecretRow => {
    const title = entry.label ?? entry.key;
    const detail = group === `provider` ? `AI subscription` : usedBy(entry);
    return {
        entry,
        group,
        title,
        mono: entry.label === undefined,
        detail,
        icon: group === `provider` ? PROVIDER_GLYPH : CREDENTIAL_GLYPH,
        attention: (group === `required` && entry.status === `missing`) || (entry.ci !== undefined && !entry.ci.synced),
        note: noteOf(entry),
        editable: group === `required` || group === `yours` || group === `credential`,
        removable: group === `yours`,
        // No gate for an unset value (nothing to release) or a provider account (would block every turn).
        ...(entry.status !== `missing` && group !== `provider` ? { gateSubject: entry.key } : {}),
        // A stored value is spent at an exit, released one use at a time, unlike rows in `credentialRow`.
        sessionShaped: false,
        haystack: `${entry.key} ${entry.label ?? ``} ${detail} ${entry.storedAt}${gateHaystack(entry)}`.toLowerCase(),
    };
};

export const secretRow = (entry: SecretInventoryEntry, sources: SecretSources): SecretRow => {
    const group = groupOf(entry);
    if (group === `credential`) {
        return credentialRow(entry, sources) ?? bareRow(entry, group);
    }
    return bareRow(entry, group);
};

// Orders within a group only, never across the tab: debts first, then connections needing something, then the
// rest by name.
const bySeverity = (left: SecretRow, right: SecretRow): number =>
    Number(right.attention) - Number(left.attention) || (left.state?.rank ?? 3) - (right.state?.rank ?? 3) || left.title.localeCompare(right.title);

export const secretRows = (entries: readonly SecretInventoryEntry[], sources: SecretSources): SecretRow[] =>
    entries.map((entry) => secretRow(entry, sources)).toSorted(bySeverity);

/** Everything the filter narrows by: free text over what a row shows, and the scope pill. */
export const matchesSecret = (row: SecretRow, needle: string, missingOnly: boolean): boolean =>
    (!missingOnly || row.entry.status === `missing`) && (needle === `` || row.haystack.includes(needle));
