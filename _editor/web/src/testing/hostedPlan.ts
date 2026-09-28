import type { HostedHoursMeter, HostedPlanHosted, HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";

// THE HOSTED PLAN'S STATE AS A SUITE STANDS IT UP: one builder for every suite that reads a machine's hours (Billing's
// sentences, a sandbox's own pages, the chat strip), so a field the contract grows is added here once rather than
// drifting across copies. Sizes come from the ladder rather than being typed, since a machine invented here would be one
// the product never hands out.

/** When every fixture month rolls over: the first of the next month, UTC, as the platform sends it. */
export const HOURS_RESET_AT = `2026-10-01T00:00:00.000Z`;

/** One kind of hours as the wire carries them: the account's free hours at the free rung's month, unless a case says otherwise. */
export const spentHours = (
    usedMinutes: number,
    allowanceMinutes: number | null = FREE_TIER.monthlyHours * 60,
    kind: HostedHoursMeter[`kind`] = `free`,
): HostedHoursMeter => ({ kind, usedMinutes, allowanceMinutes, resetsAt: HOURS_RESET_AT });

/** A hosted machine as the plan state lists it: named after its sandbox, the size of its rung, asleep, spending `hours`. */
export const hostedMachine = (sandboxId: string, hours: HostedHoursMeter, tier: string = FREE_TIER.id): HostedPlanMachine => {
    const { cpuKind, cpus, memoryMb, volumeGb } = hostedTier(tier);
    return { sandboxId, name: sandboxId, region: `arn`, wokeAt: null, tier, shape: { cpuKind, cpus, memoryMb, volumeGb }, hours, oomsThisWeek: 0 };
};

/** An account's hosted lane: its one free slot, the machines given, and its free hours, untouched unless a case spends some. */
export const hostedLane = (machines: HostedPlanMachine[] = [], freeHours: HostedHoursMeter = spentHours(0)): HostedPlanHosted => ({
    slots: 1,
    slotsByTier: { [FREE_TIER.id]: 1 },
    machines,
    freeHours,
    freeTier: { id: FREE_TIER.id, shape: FREE_TIER, monthlyHours: FREE_TIER.monthlyHours },
});

/** The plan state around a lane: an account on the free plan, or one the operator's comp list puts on the house. */
export const hostedPlanState = (hosted: HostedPlanHosted, comped = false): HostedPlanState =>
    comped ? { enabled: true, onPlan: true, comped: true, priceUsd: 20, hosted } : { enabled: true, onPlan: false, priceUsd: 20, hosted };
