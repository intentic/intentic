import type { AccountUsage, ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { opt } from "../../../opt.js";
import { claudeUsageWindows } from "./claude-usage.js";

/* A CLAUDE ACCOUNT'S READING AS THE DAEMON FILES IT, FOR A TEST. Built through the reader's own parser
   (claude-usage.ts claudeUsageWindows) from the endpoint's flat payload, so every pool comes out as production files it:
   rounded, since the endpoint answers in whole percents. A hand-written Claude window at an unrounded 100 is a reading
   the reader never produces. Read as the verdict it proves the account spent, where a real one reads "at the line" and
   only a refusal on file proves it spent (plan-pools.ts serviceState). Tests written that way passed while a pick between
   two spent Claude accounts re-booked a held turn for "now" in production (2026-10-19). Pair a spent pool with
   `claudeLimitRefusal` where the test means the account is spent. Not part of the build. */

/** One pool as the endpoint reports it: its percent, and when it resets (epoch seconds). */
export interface ClaudePool {
    readonly utilization: number;
    readonly resetsAt?: number | undefined;
}

/** The endpoint's flat pool keys the reader knows (claude-usage.ts FLAT_GATES). */
export interface ClaudePools {
    readonly five_hour?: ClaudePool;
    readonly seven_day?: ClaudePool;
    readonly seven_day_opus?: ClaudePool;
    readonly seven_day_sonnet?: ClaudePool;
}

// A pool as the endpoint's payload spells it: a percent, and an ISO reset.
interface PayloadPool {
    readonly utilization: number;
    readonly resets_at?: string;
}

const payloadOf = (pools: ClaudePools): Record<keyof ClaudePools, PayloadPool> =>
    // SAFETY: built from ClaudePools' own entries, so every key is one of its keys.
    Object.fromEntries(
        Object.entries(pools).map(([kind, pool]: [string, ClaudePool]) => [
            kind,
            { utilization: pool.utilization, ...opt("resets_at", pool.resetsAt === undefined ? undefined : new Date(pool.resetsAt * 1000).toISOString()) },
        ]),
    ) as Record<keyof ClaudePools, PayloadPool>;

/** The windows the reader files for these pools. */
export const claudeWindows = (pools: ClaudePools): UsageWindow[] => claudeUsageWindows(payloadOf(pools));

/** A Claude account's reading as the daemon files it, measured at `measuredAt` (ms). */
export const claudeReading = (pools: ClaudePools, measuredAt: number = Date.now()): AccountUsage => ({ windows: claudeWindows(pools), measuredAt });

/** The refusal that proves a Claude account spent until `resetsAt` (epoch s): the evidence a rounded reading never is. */
export const claudeLimitRefusal = (params: {
    readonly account: string;
    readonly resetsAt?: number | undefined;
    readonly at: number;
    readonly model?: string | undefined;
}): ProviderRefusal => ({
    at: params.at,
    kind: "limit",
    message: "Claude usage limit reached. Send again once it resets.",
    account: params.account,
    ...opt("model", params.model),
    ...opt("resetsAt", params.resetsAt),
});
