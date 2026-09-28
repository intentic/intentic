import type { HostedHoursMeter, HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { hostedTier } from "@intentic/constants";
import { HOURS_RESET_AT, hostedLane, hostedMachine, spentHours } from "../../../testing/hostedPlan";
import {
    formatDayShort,
    formatMinutes,
    hoursLeftLine,
    hoursMeter,
    lowHoursNotice,
    lowOnHours,
    machineHours,
    planBadge,
    sandboxHoursLine,
} from "./hostedHours";

// Pins the hosted-plan sentences as words: the failure this suite guards against is two surfaces phrasing the same fact
// differently.

const STANDARD = hostedTier(`standard`);
const RESETS_AT = HOURS_RESET_AT;

// One kind of hours as the wire carries it, at a forty-hour month unless a case says otherwise.
const usage = (usedMinutes: number, allowanceMinutes: number | null = 2_400, kind: HostedHoursMeter[`kind`] = `free`): HostedHoursMeter =>
    spentHours(usedMinutes, allowanceMinutes, kind);

// A hosted machine as Billing lists it, spending the hours given.
const machine = (sandboxId: string, hours: HostedHoursMeter, tier?: string): HostedPlanMachine => hostedMachine(sandboxId, hours, tier);

// The account's lane, with its free hours spent this far and the machines given.
const hosted = (usedMinutes: number, allowanceMinutes: number | null = 2_400, machines: HostedPlanMachine[] = []) =>
    hostedLane(machines, usage(usedMinutes, allowanceMinutes));

const state = (over: Partial<HostedPlanState> = {}): HostedPlanState => ({ enabled: true, onPlan: false, priceUsd: 20, ...over });

// A live subscriber, whose chip differs only by the one field each case is about.
const RENEWS_AT = `2026-10-01T00:00:00.000Z`;
const subscriber = (over: Partial<HostedPlanState> = {}): HostedPlanState => state({ onPlan: true, status: `active`, renewsAt: RENEWS_AT, ...over });

// The free plan's chip; the same answer for spent hours, unspent hours, no ceiling, and no machine at all.
const FREE = { label: `free`, variant: `neutral`, detail: `Free plan. This account is not on the hosted plan.` } as const;

describe(`minutes as words`, () => {
    it(`speaks minutes under an hour, whole hours plain, and a decimal otherwise`, () => {
        expect(formatMinutes(45)).toBe(`45 min`);
        expect(formatMinutes(120)).toBe(`2 h`);
        expect(formatMinutes(150)).toBe(`2.5 h`);
        expect(formatMinutes(-3)).toBe(`0 min`);
    });
});

describe(`the meter`, () => {
    it(`is absent for an owner the ceiling does not apply to`, () => {
        expect(hoursMeter(undefined)).toBeUndefined();
        expect(hoursMeter(usage(500, null))).toBeUndefined();
    });

    it(`never reads negative, and says spent when it is`, () => {
        const meter = hoursMeter(usage(9_000));
        expect(meter).toMatchObject({ remainingMinutes: 0, fraction: 0 });
        expect(hoursLeftLine(meter!)).toBe(`Free hours used up this month`);
    });

    it(`states what is left of what`, () => {
        expect(hoursLeftLine(hoursMeter(usage(1_680))!)).toBe(`12 h of 40 h left this month`);
    });

    it(`names the day a new account's ramp ends instead of the month`, () => {
        const ramped = hoursMeter({ ...usage(120, 600), rampUntil: `2026-09-21T12:00:00.000Z` })!;
        expect(ramped.rampUntil).toBe(`2026-09-21T12:00:00.000Z`);
        expect(hoursLeftLine(ramped)).toBe(`8 h of 10 h left until ${formatDayShort(`2026-09-21T12:00:00.000Z`)}`);
        expect(hoursLeftLine(hoursMeter({ ...usage(600, 600), rampUntil: `2026-09-21T12:00:00.000Z` })!)).toContain(`used up until`);
    });

    it(`is low under five hours, but not at the first minute of a month, and not once spent`, () => {
        expect(lowOnHours(hoursMeter(usage(2_100)))).toBe(true);
        expect(lowOnHours(hoursMeter(usage(0)))).toBe(false);
        expect(lowOnHours(hoursMeter(usage(2_400)))).toBe(false);
        // 480 minutes is an 8-hour ceiling: low with 1h left, not with 4h left.
        expect(lowOnHours(hoursMeter(usage(420, 480)))).toBe(true);
        expect(lowOnHours(hoursMeter(usage(240, 480)))).toBe(false);
    });
});

describe(`the account menu's plan chip`, () => {
    it(`says nothing where nothing is sold`, () => {
        expect(planBadge(undefined)).toBeUndefined();
        expect(planBadge(state({ enabled: false }))).toBeUndefined();
    });

    it(`gives the free plan one quiet word, whatever the meter says`, () => {
        for (const spent of [0, 2_200, 2_400]) {
            expect(planBadge(state({ hosted: hosted(spent) }))).toEqual(FREE);
        }
    });

    it(`still names the free plan on a platform with no ceiling`, () => {
        expect(planBadge(state({ hosted: hosted(500, null) }))).toEqual(FREE);
        expect(planBadge(state())).toEqual(FREE);
    });

    it(`turns hosted into ending once the plan is cancelling`, () => {
        expect(planBadge(subscriber())).toEqual({
            label: `hosted`,
            variant: `primary`,
            detail: `Hosted plan, renews ${formatDayShort(RENEWS_AT)}.`,
        });
        expect(planBadge(subscriber({ cancelAtPeriodEnd: true }))).toEqual({
            label: `ending`,
            variant: `warning`,
            detail: `Hosted plan ends ${formatDayShort(RENEWS_AT)}. After that, the free plan.`,
        });
    });

    it(`names a trial, a comp, and a plan with no date`, () => {
        expect(planBadge(subscriber({ status: `trialing` }))).toEqual({
            label: `trial`,
            variant: `info`,
            detail: `Hosted plan trial, ends ${formatDayShort(RENEWS_AT)}.`,
        });
        expect(planBadge(state({ onPlan: true, comped: true }))).toEqual({
            label: `complimentary`,
            variant: `info`,
            detail: `Hosted plan, on the house. No card, no renewal.`,
        });
        expect(planBadge(state({ onPlan: true }))).toEqual({ label: `hosted`, variant: `primary`, detail: `On the hosted plan.` });
    });

    it(`takes the danger tone for a failing card, ahead of the free plan`, () => {
        for (const status of [`past_due`, `unpaid`, `incomplete`]) {
            expect(planBadge(state({ status, renewsAt: `2026-09-01T00:00:00.000Z`, hosted: hosted(0) }))).toEqual({
                label: `payment failed`,
                variant: `danger`,
                detail: `Your card was declined. The hosted plan ends unless it is fixed.`,
            });
        }
    });

    it(`gives every state its own sentence to hover`, () => {
        const every = [
            state({ hosted: hosted(0) }),
            state({ status: `past_due` }),
            state({ onPlan: true, comped: true }),
            subscriber({ status: `trialing` }),
            subscriber(),
            subscriber({ cancelAtPeriodEnd: true }),
        ];
        const details = every.map((one) => planBadge(one)?.detail);
        expect(details.filter((detail) => detail?.endsWith(`.`))).toHaveLength(every.length);
        expect(new Set(details).size).toBe(every.length);
    });
});

/* WHOSE HOURS A MACHINE SPENDS, said on every surface that shows them: a slot's own month under its rung's name, the
 * account's free hours (shared once a second machine spends them), or a comp's hours counted against nothing. */
describe(`a machine's hours`, () => {
    it(`names a slot's month by its rung, and the free hours as the account's`, () => {
        const onSlot = machine(`s1`, usage(180, STANDARD.monthlyHours * 60, `slot`), STANDARD.id);
        expect(machineHours(state({ hosted: hosted(0, 2_400, [onSlot]) }), onSlot)).toEqual({
            label: `Standard hours`,
            line: `217 h of 220 h left this month`,
            meter: expect.objectContaining({ kind: `slot`, remainingMinutes: STANDARD.monthlyHours * 60 - 180 }),
        });
        const free = machine(`s1`, usage(1_680));
        expect(machineHours(state({ hosted: hosted(1_680, 2_400, [free]) }), free)).toMatchObject({ label: `Free hours`, line: `12 h of 40 h left this month` });
    });

    it(`says the free hours are shared once a second machine spends them`, () => {
        const one = machine(`s1`, usage(600));
        const two = machine(`s2`, usage(600));
        expect(machineHours(state({ hosted: hosted(600, 2_400, [one, two]) }), one).label).toBe(`Free hours, shared`);
    });

    it(`credits the comp for hours counted against nothing, and says how many were spent`, () => {
        const comped = machine(`s1`, usage(95, null));
        expect(machineHours(state({ onPlan: true, comped: true, hosted: hosted(95, null, [comped]) }), comped)).toEqual({
            label: `On the house`,
            line: `1.6 h awake this month`,
            meter: undefined,
        });
        expect(machineHours(state({ hosted: hosted(95, null, [comped]) }), comped).label).toBe(`No hour limit`);
    });

    it(`gives a slot's spent month its own words, not the free plan's`, () => {
        expect(hoursLeftLine(hoursMeter(usage(9_000, 9_000, `slot`))!)).toBe(`This month's hours used up`);
    });
});

describe(`the sandbox's own line and the chat strip`, () => {
    it(`states the hours of the sandbox asked about, and nothing for one the reader holds no machine for`, () => {
        const withMachine = state({ hosted: hosted(1_680, 2_400, [machine(`s1`, usage(1_680))]) });
        expect(sandboxHoursLine(withMachine, `s1`)).toBe(`Free hours · 12 h of 40 h left this month`);
        expect(sandboxHoursLine(withMachine, `local`)).toBeUndefined();
        expect(sandboxHoursLine(state(), `s1`)).toBeUndefined();
    });

    it(`warns only in a machine's last stretch, with the day they come back`, () => {
        const low = state({ hosted: hosted(2_160, 2_400, [machine(`s1`, usage(2_160))]) });
        expect(lowHoursNotice(low, `s1`)).toBe(
            `Free hours · 4 h of 40 h left this month. A sleeping machine spends none, and they come back on ${formatDayShort(RESETS_AT)}.`,
        );
        expect(lowHoursNotice(state({ hosted: hosted(600, 2_400, [machine(`s1`, usage(600))]) }), `s1`)).toBeUndefined();
        // A slot with most of its own month left is not low because the free hours beside it are.
        const onSlot = state({ hosted: hosted(2_300, 2_400, [machine(`s1`, usage(600, STANDARD.monthlyHours * 60, `slot`), STANDARD.id)]) });
        expect(lowHoursNotice(onSlot, `s1`)).toBeUndefined();
    });
});
