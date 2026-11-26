import type { HostedPlanState, SandboxSummary } from "@intentic/api-contract";
import { FREE_TIER } from "@intentic/constants";
import { ref } from "vue";
import { hostedLane, hostedMachine, spentHours } from "../../../testing/hostedPlan";
import { type AddPlans, useAddPlan } from "./useAddPlan";

// The plan a new cloud sandbox is made on: Free unless the address named another, never Free while another sandbox holds
// it, and a paid one settled before anything is made (Stripe's page for an account paying for nothing, then a reserve).

const scratch = hostedMachine(`scratch`, spentHours(0), FREE_TIER.id);
const paying = (freeLeft: number, extra: Partial<HostedPlanState> = {}): HostedPlanState => ({
    enabled: true,
    onPlan: true,
    status: `active`,
    renewsAt: `2026-12-26T00:00:00.000Z`,
    priceUsd: 20,
    onSale: [`standard`, `max`],
    hosted: { ...hostedLane([scratch]), freeLeft },
    ...extra,
});
const seams = (state: HostedPlanState | undefined, landed = true) => {
    const calls: string[] = [];
    const plans: AddPlans = {
        state: () => state,
        reserve: async (tier) => {
            calls.push(`reserve ${tier}`);
        },
        checkout: async (tier) => {
            calls.push(`checkout ${tier}`);
            return landed;
        },
    };
    return { plans, calls };
};
const NONE = { sandboxes: ref<readonly SandboxSummary[]>([]) };

test(`Free while it is left, with nothing to settle first`, async () => {
    const { plans, calls } = seams(paying(1));
    const plan = useAddPlan(plans, NONE, undefined, () => false);
    expect(plan.tier.value).toBe(`free`);
    expect(plan.laneTier()).toBeUndefined();
    await expect(plan.payFirst(() => undefined)).resolves.toBe(true);
    expect(calls).toEqual([]);
});

test(`Free held by another sandbox is refused by name, and the pick moves to the cheapest paid plan, reserved first`, async () => {
    const { plans, calls } = seams(paying(0));
    const plan = useAddPlan(plans, NONE, undefined, () => false);
    expect(plan.refused.value).toEqual({ free: `Used by scratch` });
    expect(plan.tier.value).toBe(`standard`);
    expect(plan.offer.value).toMatchObject({ act: `reserve`, label: `Create · $20/month`, paid: true });
    await expect(plan.payFirst(() => undefined)).resolves.toBe(true);
    expect(calls).toEqual([`reserve standard`]);
});

test(`an account paying for nothing buys on Stripe's page first, and stops there where the browser left for it`, async () => {
    const away = seams(paying(1, { onPlan: false, status: undefined, renewsAt: undefined }), false);
    const plan = useAddPlan(away.plans, NONE, `max`, () => false);
    await expect(plan.payFirst(() => undefined)).resolves.toBe(false);
    expect(away.calls).toEqual([`checkout max`]);

    const back = seams(paying(1, { onPlan: false, status: undefined, renewsAt: undefined }), true);
    await expect(useAddPlan(back.plans, NONE, `max`, () => false).payFirst(() => undefined)).resolves.toBe(true);
    expect(back.calls).toEqual([`checkout max`, `reserve max`]);
});

test(`a platform that sells no plan offers none, and every machine is made as before`, () => {
    const plan = useAddPlan(seams({ enabled: false, onPlan: false, priceUsd: 0 }).plans, NONE, undefined, () => false);
    expect(plan.sold.value).toBe(false);
    expect(plan.offer.value).toBeUndefined();
    expect(plan.laneTier()).toBeUndefined();
});
