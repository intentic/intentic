import type { HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER } from "@intentic/constants";
import { hoursPerWorkday, nextRung, planLadder, rungOf, rungsOnSale } from "./planLadder";

// The plans every surface about money draws: a buy button only where the platform can actually sell, one plan
// recommended, and the next plan up only where it can be bought.

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

test(`the next plan up is the next one on sale, and none above the top`, () => {
    const ladder = planLadder(offer({ onSale: [`standard`, `max`] }));
    expect(nextRung(ladder, `free`)?.id).toBe(`standard`);
    expect(nextRung(ladder, `standard`)?.id).toBe(`max`);
    expect(nextRung(ladder, `max`)).toBeUndefined();
    expect(nextRung(planLadder(offer({ onSale: [`max`] })), `free`)?.id).toBe(`max`);
});

test(`a plan the ladder does not know is drawn as itself rather than hidden`, () => {
    expect(rungOf(planLadder(offer()), `gold`)).toMatchObject({ id: `gold`, name: `gold`, priceUsd: 0, onSale: false });
});

test(`a month of hours is said per workday, never as zero`, () => {
    expect(hoursPerWorkday(220)).toBe(10);
    expect(hoursPerWorkday(40)).toBe(2);
    expect(hoursPerWorkday(5)).toBe(1);
});
