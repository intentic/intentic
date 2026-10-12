import { dailyBudget } from "../store/daily-budget.js";
import { rateWindow } from "../store/rate-window.js";

// THE TWO CEILINGS EVERY DOOR A STRANGER CAN KNOCK ON HOLDS: a per-minute window per caller, so a loop on the other side
// cannot hammer it, and a per-day budget per automation, since every wake it lets through is billed to the owner. The
// Visitor chat and bug intake (public-door.ts), the webhook (fire.routes.ts) and channel listeners (listeners.ts) each
// hold their own pair, built here so the order and the counting cannot drift between them. In memory per daemon, like
// the stores underneath: a restart forgetting the last minute and the day so far beats a counter file written per call.

const RATE_WINDOW_MS = 60_000;

// Which ceiling turned a caller away.
export type DoorRefusal = "rate" | "daily";

export interface DoorGate {
    // The caller the minute window counts against, already namespaced by automation.
    readonly rateKey: string;
    readonly rateMax: number;
    // The automation the day's budget is spent from.
    readonly automationId: string;
    readonly dailyMax: number;
}

export interface DoorAdmission {
    // Counts one arrival against the caller's minute; true means refused and nothing counted.
    readonly rateLimited: (key: string, max: number, now: number) => boolean;
    // Spends one from the automation's day; true means over, and nothing was spent.
    readonly overDailyCeiling: (automationId: string, max: number, now: number) => boolean;
    // Both, minute first, so a caller over the minute never spends from the day. A door with a gate between the two
    // (the public doors' proof-of-work, cheaper to refuse than to spend) calls them separately in its own order.
    readonly admit: (gate: DoorGate, now: number) => DoorRefusal | undefined;
}

export const doorAdmission = (): DoorAdmission => {
    const window = rateWindow(RATE_WINDOW_MS);
    const daily = dailyBudget();
    const rateLimited = (key: string, max: number, now: number): boolean => window.limited(key, max, now);
    const overDailyCeiling = (automationId: string, max: number, now: number): boolean => daily.spend(automationId, max, now);
    return {
        rateLimited,
        overDailyCeiling,
        admit: (gate, now) => {
            if (rateLimited(gate.rateKey, gate.rateMax, now)) {
                return "rate";
            }
            return overDailyCeiling(gate.automationId, gate.dailyMax, now) ? "daily" : undefined;
        },
    };
};
