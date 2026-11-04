import type { EnvironmentItem } from "@intentic/sandbox-contract/schemas/environment";
import type { IconName } from "@intentic/ui";
import { here, page, type PageLink } from "../../../lib/routes/links";

// What a chip and its card both say about one block: a state other than live, and who put it there.

export interface ItemState {
    readonly icon: IconName;
    /** An `sandbox.environmentContents.*` key: the words the glyph stands for. */
    readonly words: `arrivesAfterRebuild` | `waitingApproval`;
    readonly tone: string;
}

// No mark for `active`: it is the normal case, and marking it would drown the two states that matter.
const STATES = {
    active: undefined,
    "after-rebuild": { icon: `clock`, words: `arrivesAfterRebuild`, tone: `text-warning` },
    "awaiting-approval": { icon: `sparkles`, words: `waitingApproval`, tone: `text-link` },
} as const satisfies Record<EnvironmentItem[`state`], ItemState | undefined>;

export const stateOf = (item: EnvironmentItem): ItemState | undefined => STATES[item.state];

// The one version a chip has room for: its first tool's, which for a block named after its tool is that tool's own.
export const leadVersion = (item: EnvironmentItem): string | undefined => item.tools[0]?.version;

// Who pulled it in, only when that does not just repeat its own name ('workspace extension', not '<name> capability').
export const attribution = (item: EnvironmentItem): string | undefined =>
    item.originLabel?.toLowerCase().startsWith(item.name.toLowerCase()) === false ? item.originLabel : undefined;

/** Where a capability's row is turned off: the words before the link, the link's own, and where it goes. */
export interface TurnedOffAt {
    /** A `sandbox.environmentContents.*` key: the sentence the link ends. */
    readonly words: `goesWithCapability` | `goesWithPrivacyShield` | `goesWithAccount`;
    /** A `sandbox.environmentContents.*` key: the link itself. */
    readonly link: `capabilitiesLink` | `privacyShieldLink` | `modelsLink`;
    readonly to: string;
}

// A capability's row has no Remove of its own: it goes with whatever pulled it in, so the card sends the reader THERE.
// Every row once said "Capabilities", where the privacy shield's readers have no card at all, so the owner who wanted
// them gone was sent to a page that could not do it. The page is named here and its address made where the reader is.
const TURNED_OFF_AT = {
    capability: { words: `goesWithCapability`, link: `capabilitiesLink`, page: page.capabilities() },
    extension: { words: `goesWithCapability`, link: `capabilitiesLink`, page: page.capabilities() },
    provider: { words: `goesWithAccount`, link: `modelsLink`, page: page.sandboxSettings(`models`) },
    privacy: { words: `goesWithPrivacyShield`, link: `privacyShieldLink`, page: page.sandboxSettings(`privacy-shield`) },
} as const satisfies Record<NonNullable<EnvironmentItem[`source`]>, Omit<TurnedOffAt, `to`> & { readonly page: PageLink }>;

export const turnedOffAt = (item: EnvironmentItem): TurnedOffAt | undefined => {
    if (item.origin !== `capability`) {
        return undefined;
    }
    const { words, link, page: where } = TURNED_OFF_AT[item.source ?? `capability`];
    return { words, link, to: here(where) };
};
