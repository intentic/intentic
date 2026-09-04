import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { ExtensionSummary, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { capabilityCard } from "../capabilities/cards";
import { type ConnectionState, connectionFacts, connectionState } from "../capabilities/connections";

/* ONE SECRET AS THE SECRETS TAB READS IT, the inventory entry plus the three things the daemon cannot know:
 * what to CALL it, what tells it apart from the row above, and whether anything is owed on it.
 *
 * THE TAB HOLDS TWO DIFFERENT OBJECTS UNDER ONE WORD, and every complaint about it at scale comes from that.
 * Some rows are values the owner keeps: they can be missing, they are set and rotated and removed here, and a
 * deploy fails without them. The rest are credentials belonging to a connection or a subscription, they are
 * connected by construction, nothing here can add or remove one, and each group already ends in a button that
 * leads to where they ARE managed. `group` is that line drawn once, so the page can give the first kind the
 * management furniture and the second kind an inventory it can fold away.
 *
 * WHAT A CREDENTIAL ROW IS CALLED comes from the same join the Capabilities view makes (capabilityCard), which
 * is what turns nineteen rows of `radarsuspam2, radarsuspam3, …` into nineteen accounts with a brand, a kind
 * and an address on them. An id its owner typed is the row's name; where they never typed one the card's name
 * IS the name, and the row does not say "docker / Docker". CapabilityConnections' rule, for its reason.
 *
 * ATTENTION IS ONLY EVER A SECRETS ERRAND: a value the intent requires that nobody has set, or a copy CI never
 * got. A connection that needs signing in again is a real problem and it is not this tab's, it belongs to the
 * page that can fix it, and pinning it here would be a badge answering a question nobody asked on the screen
 * they were sent to by a different one. Such a row still carries its `state` and still sorts to the top of its
 * OWN group, which is where the reader is when it matters. */

/** Where a row belongs, and, in the first three cases, that it is the owner's to set. */
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
    /** Whether this row can be GATED at all, and under which subject the gate is written. Absent on the rows
     *  a gate would be meaningless or harmful on: a value nobody has set yet has nothing to release, and an AI
     *  subscription's credential is what makes the sandbox able to think at all. */
    readonly gateSubject?: string | undefined;
    /** True where a release cannot be per-use because the credential is MOUNTED rather than spent: a signed-in
     *  browser, an identity's browser, a running MCP server. The daemon forces those to conversation scope, so
     *  the editor states the rule instead of offering a choice that will be overridden. */
    readonly sessionShaped: boolean;
    /** Everything the filter box matches, already folded. */
    readonly haystack: string;
}

/** The already-cached reads a row needs to find out whose credential it is. */
export interface SecretSources {
    readonly capabilities: readonly CapabilitySummary[];
    readonly extensions: readonly ExtensionSummary[];
}

// A generated value is intentic's to write, and a provider account is the subscription's, neither is typed in.
const GROUPS: Readonly<Record<SecretInventoryEntry[`kind`], SecretGroup | undefined>> = {
    env: undefined,
    generated: `generated`,
    capability: `credential`,
    provider: `provider`,
};

const groupOf = (entry: SecretInventoryEntry): SecretGroup => GROUPS[entry.kind] ?? (entry.requiredBy.length > 0 ? `required` : `yours`);

// The one glyph a credential falls to when its card declares none, and the one every AI subscription wears,
// there is no card behind a subscription to ask, and the section it sits in already says what it is.
const CREDENTIAL_GLYPH = `key`;
const PROVIDER_GLYPH = `sparkles`;

const usedBy = (entry: SecretInventoryEntry): string =>
    entry.requiredBy.length === 0 ? `` : `used by ${entry.requiredBy.map((use) => use.resourceId).join(`, `)}`;

/* WHAT IS OWED, in the order it is owed. An empty value is the louder fact and the one a reader is scanning
 * for; a stale CI copy is only ever the second thing wrong with a row, and the open row spells the CI state out
 * either way. Saying "not set" is not the same as pinning it: a spare key with no value is worth stating and is
 * nobody's outstanding task, which is the line `attention` draws.
 *
 * A GATE IS NOT A DEBT, and that is why it is read last and never sets `attention`. "Bob has to release this"
 * is the configuration working exactly as the owner asked, not an errand anybody has to run; badging it would
 * make the tab's one honest warning colour mean two different things. It is still worth a line, because a
 * reader scanning for why a turn could not use something needs to see it without opening the row. */
const noteOf = (entry: SecretInventoryEntry): string | undefined => {
    if (entry.status === `missing`) {
        return `not set`;
    }
    if (entry.ci !== undefined && !entry.ci.synced) {
        return `CI hasn't got this yet`;
    }
    return entry.gate === undefined ? undefined : `needs approval from ${entry.gate.approvers.join(` or `)}`;
};

// What the filter box can find a gated row by: the word people would type, plus the approvers' addresses, so
// "who is waiting on Bob" is one search rather than a scroll.
const gateHaystack = (entry: SecretInventoryEntry): string =>
    entry.gate === undefined ? `` : ` needs approval ${entry.gate.approvers.join(` `)}`;

const credentialRow = (entry: SecretInventoryEntry, sources: SecretSources): SecretRow | undefined => {
    const instance = sources.capabilities.find((capability) => capability.id === entry.key);
    if (instance === undefined) {
        return undefined;
    }
    const card = capabilityCard(instance, sources.extensions);
    // Where nobody named the connection it took the card's id, and the card's name is the better spelling of it.
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
        // The one thing a connected account's row has to say beyond what it IS: a gated one is not loaded
        // into a turn at all, so "needs approval from Bob" is the difference between a reader understanding
        // why the agent could not use it and reading the connection as broken.
        ...(entry.gate === undefined ? {} : { note: `needs approval from ${entry.gate.approvers.join(` or `)}` }),
        state: connectionState(instance.kind, instance, undefined),
        editable: true,
        removable: false,
        gateSubject: instance.id,
        sessionShaped: instance.kind === `browser` || instance.kind === `identity` || instance.kind === `mcp`,
        haystack: `${instance.id} ${card?.name ?? ``} ${instance.kind} ${facts}${gateHaystack(entry)}`.toLowerCase(),
    };
};

/* An entry whose capability has since gone (a connection removed in another tab, a list still in flight) is
 * still shown rather than dropped: the credential is in the box either way, and a row that quietly disappears
 * from an inventory is worse than one that is thin. */
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
        /* A gate needs something to gate. A value nobody has set has nothing to release; a provider account is
         * the sandbox's ability to think, and putting THAT behind a colleague's click would stop every turn
         * rather than guard anything. Everything the owner actually keeps here can be gated. */
        ...(entry.status !== `missing` && group !== `provider` ? { gateSubject: entry.key } : {}),
        // A row with no capability behind it is a stored value, which is spent at an exit and can be released
        // one use at a time; the capability rows that cannot are answered in credentialRow above.
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

/* THE ORDER INSIDE A GROUP, never across the whole tab: what is unfinished should rise past the rows it sits
 * WITH, not jump the heading it belongs under. Debts first, then connections that need something, then the
 * rest by name, an inventory read by scanning has to be in an order the reader can predict. */
const bySeverity = (left: SecretRow, right: SecretRow): number =>
    Number(right.attention) - Number(left.attention) || (left.state?.rank ?? 3) - (right.state?.rank ?? 3) || left.title.localeCompare(right.title);

export const secretRows = (entries: readonly SecretInventoryEntry[], sources: SecretSources): SecretRow[] =>
    entries.map((entry) => secretRow(entry, sources)).toSorted(bySeverity);

/** Everything the filter narrows by: free text over what a row shows, and the scope pill. */
export const matchesSecret = (row: SecretRow, needle: string, missingOnly: boolean): boolean =>
    (!missingOnly || row.entry.status === `missing`) && (needle === `` || row.haystack.includes(needle));
