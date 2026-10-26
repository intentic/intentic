import type { AccountFix, AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { reopensAtOf } from "@intentic/sandbox-contract/models/plan-pools";
import { t } from "@intentic/ui/i18n";

// An exhausted allowance without a clock is still exhausted. Timed holds may be booked, while an edit must
// wait before it rewinds anything. Unknown readings remain usable, just as the daemon's serviceability rule says.
export type SendBlock = AccountFix | `spent` | `editSpent`;
export const sendBlockOf = (state: AccountState | undefined, now: number, editing = false): SendBlock | undefined => {
    if (state === undefined || state.kind === `ready` || state.kind === `unknown`) {
        return undefined;
    }
    const at = reopensAtOf(state);
    if (at !== undefined) {
        return at * 1_000 <= now ? undefined : editing ? `editSpent` : undefined;
    }
    return state.kind === `spent` ? `spent` : state.fix;
};

export const sendBlockLine = (block: SendBlock): string => t(`chat.sendAvailability.${block}`);
export const sendBlockTitle = (block: SendBlock): string => t(`chat.sendAvailability.${block}Title`);
