import type { HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { HOSTED_TIERS, type HostedTier, PAID_TIERS } from "@intentic/constants";

// The plans a cloud sandbox can be on, as every surface about money draws them: what each is, what it costs, whether
// this platform sells it, and which one the page leads with. Pure, so the page's choices are testable. Every figure is
// the ladder's (@intentic/constants HOSTED_TIERS), never typed: the free plan's in this deployment's own shape.

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
    // A paid plan this platform has a Stripe price for; the free plan is never "on sale", it is simply there.
    readonly onSale: boolean;
    // The one plan the page leads with: the cheapest on sale.
    readonly recommended: boolean;
}

/**
 * The paid plans a checkout can name. A platform older than `onSale` only promised its cheapest (`priceUsd`), so that is
 * all the page offers there: a button for a plan with no Stripe price would only fail at the press.
 */
export const rungsOnSale = (state: HostedPlanState | undefined): ReadonlySet<string> => {
    if (state?.onSale !== undefined) {
        return new Set(state.onSale);
    }
    const entry = PAID_TIERS.find((tier) => tier.priceUsd === state?.priceUsd);
    return new Set(entry === undefined ? [] : [entry.id]);
};

/** Every plan, cheapest first, as this account and this platform see it. */
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
            // The free plan is this deployment's: an operator may size it differently from the published ladder.
            machine: free && hosted !== undefined ? hosted.freeTier.shape : tier,
            hours: free && hosted !== undefined ? hosted.freeTier.monthlyHours : tier.monthlyHours,
            free,
            onSale: !free && sale.has(tier.id),
            recommended: tier.id === recommended,
        };
    });
};

/** The plan named `id`; one the ladder does not know is drawn as itself, at no price, rather than hidden. */
export const rungOf = (ladder: readonly Rung[], id: string): Rung =>
    ladder.find((rung) => rung.id === id) ?? {
        id,
        name: id,
        priceUsd: 0,
        machine: ladder[0]?.machine ?? HOSTED_TIERS[0] ?? { cpuKind: `shared`, cpus: 1, memoryMb: 1024, volumeGb: 1 },
        hours: 0,
        free: false,
        onSale: false,
        recommended: false,
    };

/** The next plan up from `id` that can be bought here, if there is one: what an upgrade press offers. */
export const nextRung = (ladder: readonly Rung[], id: string): Rung | undefined => {
    const at = ladder.findIndex((rung) => rung.id === id);
    return ladder.slice(at + 1).find((rung) => rung.onSale);
};

/** A sandbox's machine as it is now: the platform's own reading (the contract calls it `shape`), which differs from its
 *  plan's mid-resize and keeps a disk no downgrade shrinks. Read here once, so the rest speaks of a size. */
export const sizeOf = (machine: Pick<HostedPlanMachine, `shape`>): MachineSize => machine.shape;

/** A month of awake hours as hours in a working day, never below one. */
export const hoursPerWorkday = (monthlyHours: number): number => Math.max(1, Math.round(monthlyHours / WORKDAYS_A_MONTH));
