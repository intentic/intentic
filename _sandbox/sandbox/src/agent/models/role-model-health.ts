import type { ModelChoice, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "../../usage/usage-store.js";
import { utcDay } from "../../usage/usage-store.js";

// A provider whose last few turns here all died without a verdict is stepped over for a run role, the way a spent rung
// is: the ledger already knows what the next call would find out the slow way. A rate limit is the quota gate's to
// judge, so it does not count toward the streak.

const WINDOW_MS = 2 * 60 * 60_000;
const STREAK = 3;

const died = (turn: UsageTurn): boolean => turn.outcome === "error" && turn.errorCode !== "rate_limit";

// The sentence for a provider on a streak, or undefined when its recent turns say nothing against it.
export const failingStreak = async (
    usage: Pick<UsageStore, "turns">,
    choice: Pick<ModelChoice, "provider">,
    now: number = Date.now(),
): Promise<string | undefined> => {
    const since = now - WINDOW_MS;
    const rows = await usage.turns({ from: utcDay(since) }).catch((): UsageTurn[] => []);
    const recent = rows
        .filter((turn) => turn.provider === choice.provider && turn.at >= since)
        .toSorted((left, right) => left.at - right.at)
        .slice(-STREAK);
    if (recent.length < STREAK || !recent.every(died)) {
        return undefined;
    }
    const last = recent.at(-1);
    return `${choice.provider}: its last ${STREAK} turns here failed (${last?.errorMessage ?? last?.errorCode ?? "no reason recorded"}).`;
};
