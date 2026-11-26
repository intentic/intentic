import { FREE_TIER, PAID_TIERS, type HostedTier } from "@intentic/constants";
import {
    decidePlanChange,
    decideRelease,
    decideReserve,
    freeLeftOf,
    onPaidPlan,
    openSeatsOf,
    type PlanAccount,
    type PlanDecision,
    type PlanMachine,
} from "./plan-change.js";

// What a buyer would call betrayal if it drifted: an upgrade billed twice, a downgrade that takes away what was paid
// for before the renewal date, a withdrawn change billed as an upgrade, a plan left billing with nothing on it.

const NOW = new Date(`2026-11-26T12:00:00Z`);
const RENEWAL = new Date(`2026-12-26T12:00:00Z`);
// The ladder's own rungs, read off it, so a renamed or repriced rung is followed here rather than transcribed.
const paidRung = (index: number): HostedTier => {
    const tier = PAID_TIERS[index];
    if (tier === undefined) {
        throw new Error(`these tests need a ladder with two paid rungs`);
    }
    return tier;
};
const STANDARD = paidRung(0);
const MAX = paidRung(1);
const FREE = FREE_TIER.id;

const machine = (sandboxId: string, tier: string, extra: Partial<PlanMachine> = {}): PlanMachine => ({
    sandboxId,
    name: sandboxId,
    tier,
    paid: tier !== FREE,
    planTo: null,
    planAt: null,
    ...extra,
});

const subscriber = (quantities: Record<string, number>, extra: Partial<NonNullable<PlanAccount[`subscription`]>> = {}): PlanAccount => ({
    subscription: { active: true, periodEnd: RENEWAL, cancelAtPeriodEnd: false, quantities: new Map(Object.entries(quantities)), ...extra },
    comped: false,
    freeAllowed: 1,
    onSale: new Set(PAID_TIERS.map((tier) => tier.id)),
});

const NOBODY: PlanAccount = { comped: false, freeAllowed: 1, onSale: new Set(PAID_TIERS.map((tier) => tier.id)) };

// A decision as plain data, so one `toEqual` pins every write, its proration and what the row becomes.
const plain = (decision: PlanDecision) =>
    decision.kind === `refused`
        ? { refused: decision.code }
        : {
              writes: decision.writes.map((write) => ({ quantities: Object.fromEntries(write.quantities), proration: write.proration })),
              machine: decision.machine,
              resize: decision.resize,
          };

describe(`putting a sandbox on a plan`, () => {
    it(`upgrades a free sandbox now: one more paid plan, prorated, and a resize due at once`, () => {
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [machine(`a`, STANDARD.id), machine(`b`, FREE)], `b`, MAX.id, NOW);
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 1, [MAX.id]: 1 }, proration: `create_prorations` }],
            machine: { paid: true, planTo: MAX.id, planAt: NOW },
            resize: true,
        });
    });

    it(`moves a paid sandbox's plan up rather than adding one beside it, so Stripe credits the old one`, () => {
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [machine(`a`, STANDARD.id)], `a`, MAX.id, NOW);
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 0, [MAX.id]: 1 }, proration: `create_prorations` }],
            machine: { paid: true, planTo: MAX.id, planAt: NOW },
            resize: true,
        });
    });

    it(`puts a plan the account already pays for, with no sandbox on it, onto the sandbox without billing anything more`, () => {
        // The screenshot's account: one Standard bought, its only sandbox still on Free.
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [machine(`test-chmura`, FREE)], `test-chmura`, STANDARD.id, NOW);
        expect(plain(decision)).toEqual({ writes: [], machine: { paid: true, planTo: STANDARD.id, planAt: NOW }, resize: true });
    });

    it(`schedules a downgrade for the renewal date: the next invoice bills less, nothing is credited, the sandbox keeps its size`, () => {
        const decision = decidePlanChange(subscriber({ [MAX.id]: 1, [STANDARD.id]: 1 }), [machine(`a`, MAX.id), machine(`b`, STANDARD.id)], `a`, STANDARD.id, NOW);
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [MAX.id]: 0, [STANDARD.id]: 2 }, proration: `none` }],
            machine: { paid: true, planTo: STANDARD.id, planAt: RENEWAL },
            resize: false,
        });
    });

    it(`ends the subscription at renewal, rather than billing zero, when the last paid sandbox is scheduled down to Free`, () => {
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [machine(`a`, STANDARD.id)], `a`, FREE, NOW);
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 0 }, proration: `none` }],
            machine: { paid: true, planTo: FREE, planAt: RENEWAL },
            resize: false,
        });
    });

    it(`takes back a scheduled downgrade with no charge, since it was paid for all along`, () => {
        const scheduled = machine(`a`, MAX.id, { planTo: STANDARD.id, planAt: RENEWAL });
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [scheduled], `a`, MAX.id, NOW);
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 0, [MAX.id]: 1 }, proration: `none` }],
            machine: { paid: true, planTo: null, planAt: null },
            resize: false,
        });
    });

    it(`takes back a scheduled downgrade before upgrading past it, so the plan paid until renewal is credited`, () => {
        const scheduled = machine(`a`, STANDARD.id, { planTo: FREE, planAt: RENEWAL });
        const decision = decidePlanChange(subscriber({}, { cancelAtPeriodEnd: true }), [scheduled], `a`, MAX.id, NOW);
        expect(plain(decision)).toEqual({
            writes: [
                { quantities: { [STANDARD.id]: 1 }, proration: `none` },
                { quantities: { [STANDARD.id]: 0, [MAX.id]: 1 }, proration: `create_prorations` },
            ],
            machine: { paid: true, planTo: MAX.id, planAt: NOW },
            resize: true,
        });
    });

    it(`credits an upgrade paid for and never applied when it is taken back`, () => {
        const due = machine(`a`, FREE, { paid: true, planTo: STANDARD.id, planAt: NOW });
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [due], `a`, FREE, new Date(NOW.getTime() + 60_000));
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 0 }, proration: `create_prorations` }],
            machine: { paid: false, planTo: null, planAt: null },
            resize: false,
        });
    });

    it(`retries an upgrade already paid for without billing it again`, () => {
        const due = machine(`a`, FREE, { paid: true, planTo: STANDARD.id, planAt: NOW });
        const decision = decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [due], `a`, STANDARD.id, new Date(NOW.getTime() + 60_000));
        expect(plain(decision)).toEqual({ writes: [], machine: { paid: true, planTo: STANDARD.id, planAt: NOW }, resize: true });
    });

    it(`puts a lapsed paid-size sandbox back on its own plan without resizing it`, () => {
        const lapsed = machine(`a`, STANDARD.id, { paid: false });
        const decision = decidePlanChange(subscriber({}), [lapsed], `a`, STANDARD.id, NOW);
        expect(plain(decision)).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 1 }, proration: `create_prorations` }],
            machine: { paid: true, planTo: null, planAt: null },
            resize: false,
        });
    });

    it(`resizes a comped sandbox at once and bills nothing, either way`, () => {
        const comped: PlanAccount = { ...NOBODY, comped: true };
        expect(plain(decidePlanChange(comped, [machine(`a`, FREE)], `a`, MAX.id, NOW))).toEqual({
            writes: [],
            machine: { paid: false, planTo: MAX.id, planAt: NOW },
            resize: true,
        });
    });

    it(`sends a first purchase to checkout, and a subscriber whose card failed to update it, before billing an upgrade`, () => {
        expect(plain(decidePlanChange(NOBODY, [machine(`a`, FREE)], `a`, STANDARD.id, NOW))).toEqual({ refused: `checkout` });
        expect(plain(decidePlanChange(subscriber({}, { active: false }), [machine(`a`, FREE)], `a`, STANDARD.id, NOW))).toEqual({ refused: `card` });
    });

    it(`refuses a second free sandbox, counting one already scheduled to become free`, () => {
        const scheduled = machine(`a`, STANDARD.id, { planTo: FREE, planAt: RENEWAL });
        expect(plain(decidePlanChange(subscriber({}), [scheduled, machine(`b`, MAX.id)], `b`, FREE, NOW))).toEqual({ refused: `free-taken` });
    });

    it(`says nothing changes when asked for the plan a sandbox is already on`, () => {
        expect(plain(decidePlanChange(subscriber({ [STANDARD.id]: 1 }), [machine(`a`, STANDARD.id)], `a`, STANDARD.id, NOW))).toEqual({ refused: `nothing-to-do` });
        expect(plain(decidePlanChange(subscriber({}), [machine(`a`, FREE)], `a`, FREE, NOW))).toEqual({ refused: `nothing-to-do` });
    });

    it(`refuses a tier the ladder does not have, and one this platform does not sell`, () => {
        expect(plain(decidePlanChange(subscriber({}), [machine(`a`, FREE)], `a`, `huge`, NOW))).toEqual({ refused: `unknown-tier` });
        const onlyStandard: PlanAccount = { ...subscriber({}), onSale: new Set([STANDARD.id]) };
        expect(plain(decidePlanChange(onlyStandard, [machine(`a`, FREE)], `a`, MAX.id, NOW))).toEqual({ refused: `not-on-sale` });
    });
});

describe(`plans with no sandbox on them`, () => {
    it(`counts a plan the subscription bills that no sandbox holds next month, and none while it is ending`, () => {
        const machines = [machine(`a`, STANDARD.id), machine(`b`, MAX.id, { planTo: STANDARD.id, planAt: RENEWAL })];
        expect(Object.fromEntries(openSeatsOf(subscriber({ [STANDARD.id]: 3, [MAX.id]: 0 }), machines))).toEqual({ [STANDARD.id]: 1 });
        expect(Object.fromEntries(openSeatsOf(subscriber({ [STANDARD.id]: 3 }, { cancelAtPeriodEnd: true }), machines))).toEqual({});
    });

    it(`reserves one for a sandbox about to be made, reusing an open one before billing another`, () => {
        expect(plain(decideReserve(subscriber({ [STANDARD.id]: 1 }), [], STANDARD.id))).toEqual({
            writes: [],
            machine: { paid: false, planTo: null, planAt: null },
            resize: false,
        });
        expect(plain(decideReserve(subscriber({ [STANDARD.id]: 1 }), [machine(`a`, STANDARD.id)], STANDARD.id))).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 2 }, proration: `create_prorations` }],
            machine: { paid: false, planTo: null, planAt: null },
            resize: false,
        });
        expect(plain(decideReserve(NOBODY, [], STANDARD.id))).toEqual({ refused: `checkout` });
        // Comped: given, never billed.
        expect(plain(decideReserve({ ...NOBODY, comped: true }, [], STANDARD.id))).toEqual({
            writes: [],
            machine: { paid: false, planTo: null, planAt: null },
            resize: false,
        });
    });

    it(`ends an open plan at renewal with nothing credited, and refuses when every plan has a sandbox on it`, () => {
        expect(plain(decideRelease(subscriber({ [STANDARD.id]: 2 }), [machine(`a`, STANDARD.id)], STANDARD.id))).toEqual({
            writes: [{ quantities: { [STANDARD.id]: 1 }, proration: `none` }],
            machine: { paid: false, planTo: null, planAt: null },
            resize: false,
        });
        expect(plain(decideRelease(subscriber({ [STANDARD.id]: 1 }), [machine(`a`, STANDARD.id)], STANDARD.id))).toEqual({ refused: `nothing-to-do` });
    });
});

describe(`whose hours a machine spends`, () => {
    it(`gives a paid-size machine its own hours only while its plan is paid for and before a downgrade's date`, () => {
        expect(onPaidPlan(machine(`a`, STANDARD.id), true, NOW)).toBe(true);
        expect(onPaidPlan(machine(`a`, STANDARD.id), false, NOW)).toBe(false);
        expect(onPaidPlan(machine(`a`, STANDARD.id, { paid: false }), true, NOW)).toBe(false);
        expect(onPaidPlan(machine(`a`, STANDARD.id, { planTo: FREE, planAt: RENEWAL }), true, NOW)).toBe(true);
        expect(onPaidPlan(machine(`a`, STANDARD.id, { planTo: FREE, planAt: RENEWAL }), true, RENEWAL)).toBe(false);
        // An upgrade still being applied: the machine is free-sized until it lands, and spends the free hours.
        expect(onPaidPlan(machine(`a`, FREE, { paid: true, planTo: STANDARD.id, planAt: NOW }), true, NOW)).toBe(false);
    });

    it(`counts the free sandboxes left, a scheduled one included and a free one upgrading not`, () => {
        expect(freeLeftOf(NOBODY, [machine(`a`, FREE)])).toBe(0);
        expect(freeLeftOf(NOBODY, [machine(`a`, STANDARD.id, { planTo: FREE, planAt: RENEWAL })])).toBe(0);
        expect(freeLeftOf(NOBODY, [machine(`a`, FREE, { paid: true, planTo: STANDARD.id, planAt: NOW })])).toBe(1);
        expect(freeLeftOf(NOBODY, [machine(`a`, FREE)], `a`)).toBe(1);
    });
});
