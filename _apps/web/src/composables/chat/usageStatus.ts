import type { AccountUsage } from "@intentic/sandbox-contract";
import { ref } from "vue";

// The latest Claude subscription usage snapshot PER ACCOUNT. Two writers, both keyed by the account the daemon
// says served the turn: the agent event stream (the SDK's rate_limit_event, live) and the daemon's persisted
// snapshots, which ride the `/accounts` list so a fresh page load already knows each account's headroom instead
// of staying blank until that account's next turn. Account-wide within an account, not per-conversation — the
// last turn on any tab updates its account's entry. A module singleton so the composer chip, the rate-limit
// notice, and the account picker can read it without threading it through each conversation.
export const usageStatusByAccount = ref<Record<string, AccountUsage>>({});

// The usage snapshot for an account, if one has been reported.
export const usageStatusFor = (account: string | undefined): AccountUsage | undefined =>
    account !== undefined ? usageStatusByAccount.value[account] : undefined;

// Human label for the usage window the SDK names (five_hour / seven_day*).
export const usageWindowLabel = (rateLimitType: string | undefined): string => {
    if (rateLimitType === `five_hour`) {
        return `5-hour limit`;
    }
    if (rateLimitType !== undefined && rateLimitType.startsWith(`seven_day`)) {
        return `Weekly limit`;
    }
    return `Usage`;
};

// Format an epoch-seconds reset instant as a short local weekday + time (e.g. "Mon 3:20 PM") — unambiguous for
// both the 5-hour and weekly windows without a ticking relative clock.
export const formatReset = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toLocaleString([], { weekday: `short`, hour: `numeric`, minute: `2-digit` });

// How old a snapshot is, coarsely. A persisted reading can be days old, and utilization only ever climbs within
// a window — so the number is a floor, not a live figure, and saying when it was taken is what keeps the
// account picker honest rather than falsely precise.
export const formatAge = (measuredAt: number, now: number = Date.now()): string => {
    const minutes = Math.floor((now - measuredAt) / 60_000);
    if (minutes < 2) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

// The account picker's per-row summary: how much of the binding window that account has spent. Undefined when
// the account has no usable reading — never measured, or its window has since reset — so the row shows nothing
// rather than implying a confident 0%.
export const usagePercent = (usage: AccountUsage | undefined): number | undefined =>
    usage?.utilization === undefined ? undefined : Math.round(usage.utilization);

// The row's tooltip: which window, how much is spent, when it resets, and how stale the reading is.
export const usageDetail = (usage: AccountUsage): string =>
    [
        usageWindowLabel(usage.rateLimitType),
        `${usagePercent(usage) ?? 0}% used`,
        usage.resetsAt !== undefined ? `resets ${formatReset(usage.resetsAt)}` : undefined,
        `measured ${formatAge(usage.measuredAt)}`,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
