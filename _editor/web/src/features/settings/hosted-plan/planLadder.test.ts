import type { HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { hoursPerWorkday, monthlyTotalUsd, planLadder, rungsOnSale } from "./planLadder";

// The ladder Billing draws: a buy button only where the platform can actually sell, one rung recommended, and a
// subscriber's month added up from the slots it holds.

const offer = (extra: Partial<HostedPlanState> = {}): HostedPlanState => ({ enabled: true, onPlan: false, priceUsd: 20, ...extra });

test(`offers every rung the platform names on sale, and recommends the cheapest of them`, () => {
    const ladder = planLadder(offer({ onSale: [`standard`, `max`] }));
    expect(ladder.map((rung) => [rung.id, rung.onSale, rung.recommended])).toEqual([
        [`free`, false, false],
        [`standard`, true, true],
        [`max`, true, false],
    ]);
});

test(`a platform older than the on-sale list is only trusted to sell its cheapest rung`, () => {
    expect([...rungsOnSale(offer())]).toEqual([`standard`]);
    expect(planLadder(offer()).find((rung) => rung.id === `max`)?.onSale).toBe(false);
});

test(`the free rung takes this deployment's shape and hours, not the published ones`, () => {
    const smaller = { ...FREE_TIER, cpus: 2, memoryMb: 2048 };
    const free = planLadder(
        offer({
            hosted: {
                slots: 1,
                slotsByTier: { free: 1 },
                machines: [],
                freeHours: { kind: `free`, usedMinutes: 0, allowanceMinutes: 1200, resetsAt: `2026-11-01T00:00:00.000Z` },
                freeTier: { id: `free`, shape: smaller, monthlyHours: 20 },
            },
        }),
    )[0];
    expect(free).toMatchObject({ free: true, hours: 20, machine: { cpus: 2, memoryMb: 2048 } });
});

test(`a subscriber's month is the slots held at each paid rung, the free one costing nothing`, () => {
    const standard = hostedTier(`standard`);
    const ladder = planLadder(
        offer({
            onPlan: true,
            hosted: {
                slots: 4,
                slotsByTier: { free: 1, standard: 2, max: 1 },
                machines: [],
                freeHours: { kind: `free`, usedMinutes: 0, allowanceMinutes: 2400, resetsAt: `2026-11-01T00:00:00.000Z` },
                freeTier: { id: `free`, shape: FREE_TIER, monthlyHours: 40 },
            },
        }),
    );
    expect(monthlyTotalUsd(ladder)).toBe(2 * standard.priceUsd + hostedTier(`max`).priceUsd);
});

test(`a month of hours is said per workday, never as zero`, () => {
    expect(hoursPerWorkday(220)).toBe(10);
    expect(hoursPerWorkday(40)).toBe(2);
    expect(hoursPerWorkday(5)).toBe(1);
});
