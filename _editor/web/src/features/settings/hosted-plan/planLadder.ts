import type { HostedPlanState } from "@intentic/api-contract";
import { HOSTED_TIERS, type HostedTier, PAID_TIERS } from "@intentic/constants";

// The ladder as the Billing page draws it: every rung as a card, what it costs, whether it can be bought here, which
// one the page recommends, and how many slots this account holds at it. Pure, so the page's choices are testable.

/** A month's awake hours said as a working day, which is the unit a person actually plans in. */
const WORKDAYS_A_MONTH = 22;

/** The four numbers that make a machine. */
export type MachineSize = Pick<HostedTier, `cpuKind` | `cpus` | `memoryMb` | `volumeGb`>;

export interface Rung {
    readonly id: string;
    readonly name: string;
    readonly priceUsd: number;
    readonly machine: MachineSize;
    readonly hours: number;
    readonly free: boolean;
    // A paid rung this platform has a Stripe price for; the free rung is never "on sale", it is simply there.
    readonly onSale: boolean;
    // The one card the page lifts: the cheapest rung on sale.
    readonly recommended: boolean;
    // Slots this account holds at the rung, and how many of those a machine already stands on.
    readonly held: number;
    readonly standing: number;
}

/**
 * The paid rungs a checkout can name. A platform older than `onSale` only promised its cheapest rung (`priceUsd`), so
 * that is all the page offers there: a button for a rung with no Stripe price would only fail at the press.
 */
export const rungsOnSale = (state: HostedPlanState | undefined): ReadonlySet<string> => {
    if (state?.onSale !== undefined) {
        return new Set(state.onSale);
    }
    const entry = PAID_TIERS.find((tier) => tier.priceUsd === state?.priceUsd);
    return new Set(entry === undefined ? [] : [entry.id]);
};

/** Every rung, cheapest first, as this account and this platform see it. */
export const planLadder = (state: HostedPlanState | undefined, tiers: readonly HostedTier[] = HOSTED_TIERS): Rung[] => {
    const hosted = state?.hosted;
    const freeId = hosted?.freeTier.id ?? tiers.find((tier) => tier.priceUsd === 0)?.id;
    const sale = rungsOnSale(state);
    const recommended = tiers.find((tier) => sale.has(tier.id))?.id;
    return tiers.map((tier) => {
        const free = tier.id === freeId;
        return {
            id: tier.id,
            name: tier.name,
            priceUsd: tier.priceUsd,
            // The free rung is this deployment's: an operator may size it differently from the published ladder.
            machine: free && hosted !== undefined ? hosted.freeTier.shape : tier,
            hours: free && hosted !== undefined ? hosted.freeTier.monthlyHours : tier.monthlyHours,
            free,
            onSale: !free && sale.has(tier.id),
            recommended: tier.id === recommended,
            held: hosted?.slotsByTier[tier.id] ?? 0,
            standing: (hosted?.machines ?? []).filter((machine) => machine.tier === tier.id).length,
        };
    });
};

/** A month of awake hours as hours in a working day, never below one. */
export const hoursPerWorkday = (monthlyHours: number): number => Math.max(1, Math.round(monthlyHours / WORKDAYS_A_MONTH));

/** What the subscriber pays a month, from the slots held at each paid rung. */
export const monthlyTotalUsd = (ladder: readonly Rung[]): number => ladder.reduce((sum, rung) => sum + (rung.free ? 0 : rung.held * rung.priceUsd), 0);
