import type { HostedHours } from "@intentic/api-contract";
import { hostedTier } from "@intentic/constants";
import { ORPCError } from "@orpc/server";
import type { HostedBuildRefusal } from "./hosted/build/hosted-build.js";
import type { HostedBudget } from "./hosted/hosted-usage.js";

// How the sandbox routes refuse a hosted machine on the wire: the status each build refusal maps to, and the sentences
// for spent hours, which a restart, a rollback, a new machine and a wake all say alike.

// Wire status per build refusal; `capacity` isn't the asker's fault, so it maps like provisioning does.
const REFUSAL_CODES = {
    off: `NOT_FOUND`,
    "no-machine": `NOT_FOUND`,
    mismatch: `CONFLICT`,
    invalid: `BAD_REQUEST`,
    busy: `TOO_MANY_REQUESTS`,
    daily: `TOO_MANY_REQUESTS`,
    ceiling: `TOO_MANY_REQUESTS`,
    budget: `PAYMENT_REQUIRED`,
    capacity: `SERVICE_UNAVAILABLE`,
} as const satisfies Record<HostedBuildRefusal, string>;

// PAYMENT_REQUIRED is this platform's own code, not oRPC's; the status must be set explicitly or oRPC's unknown-code
// fallback reports 500 for an ordinary, expected refusal.
export const paymentRequired = (message: string): ORPCError<`PAYMENT_REQUIRED`, undefined> => new ORPCError(`PAYMENT_REQUIRED`, { status: 402, message });

// The refusal for spent hours, in whichever kind the machine spends (hosted-usage.ts): whose, how many, and when they
// come back. Addressed to the owner where only the owner can be reading (a new machine, a restart), and to nobody in
// particular on a wake, since a guest waking a shared sandbox spends its owner's hours rather than their own.
export const hoursSpent = (budget: HostedBudget, reader: `owner` | `anyone`): string => {
    const hours = budget.allowanceMinutes / 60;
    if (budget.kind === `slot`) {
        return `this sandbox's ${hours} hours a month on its ${hostedTier(budget.tier).name} slot are used up; they come back on the 1st (UTC)`;
    }
    return reader === `owner`
        ? `your ${hours} free hosted hours for this month are used up; they come back on the 1st (UTC), or run it on your own computer, where nothing is metered`
        : `the ${hours} free hosted hours of this sandbox's owner are used up for this month; they come back on the 1st (UTC)`;
};

// The refusal's own sentence for `hours`; ISO on the wire, absent when the ceiling is the month's.
export const hoursOf = (budget: { allowanceMinutes: number; remainingMinutes: number; rampUntil?: Date }): HostedHours => {
    const hours: HostedHours = {
        allowance: Math.round(budget.allowanceMinutes / 60),
        remaining: Math.floor(budget.remainingMinutes / 60),
    };
    if (budget.rampUntil !== undefined) {
        hours.rampUntil = budget.rampUntil.toISOString();
    }
    return hours;
};

export const buildRefusal = (code: HostedBuildRefusal, message: string): ORPCError<string, undefined> =>
    REFUSAL_CODES[code] === `PAYMENT_REQUIRED` ? paymentRequired(message) : new ORPCError(REFUSAL_CODES[code], { message });
