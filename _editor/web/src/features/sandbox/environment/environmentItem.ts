import type { EnvironmentItem } from "@intentic/sandbox-contract/schemas/environment";
import type { IconName } from "@intentic/ui";

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
