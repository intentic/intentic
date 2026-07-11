import type { RateLimitInfo } from "@intentic/sandbox-contract";
import { ref } from "vue";

// The latest Claude subscription usage snapshot PER ACCOUNT, pushed from the agent event stream (the SDK's
// rate_limit_event, tagged by the daemon with the account that served the turn). Account-wide within an
// account, not per-conversation — the last turn on any tab updates its account's entry, and an account stays
// absent until its first Claude turn reports (Codex/Grok never do). A module singleton so the composer chip
// and the rate-limit notice can read it without threading it through each conversation.
export const usageStatusByAccount = ref<Record<string, RateLimitInfo>>({});

// The usage snapshot for an account, if one has been reported.
export const usageStatusFor = (account: string | undefined): RateLimitInfo | undefined =>
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
