import type { HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { hostedLane, hostedMachine, spentHours } from "../../../testing/hostedPlan";
import { planMove, planMoving } from "../../../models/hosted-plan/planMoves";
import { billOf, cardLead, moveSteps, newSandboxPlan, openingTier, periodLeft, planDiff, planOffer, prorationUsd, rowActLabel } from "./planChange";
import { planLadder, rungOf } from "./planLadder";

// The words and figures a change of plan is said in: the one sentence about money, the button that says the act, which
// press a sandbox's card leads with, and what the bill adds up to. Each case is one rule the owner reads on the page.

const STANDARD = hostedTier(`standard`);
const MAX = hostedTier(`max`);
// Billing displays the renewal in the reader's time zone. Start on Dec 26 locally and serialize it as the API does.
const RENEWS_AT = new Date(2026, 11, 26).toISOString();
const HALFWAY = Date.parse(RENEWS_AT) - 15 * 86_400_000;

const paidHours = (tier: string) => spentHours(0, hostedTier(tier).monthlyHours * 60, `slot`);
const machine = (id: string, tier: string, extra: Partial<HostedPlanMachine> = {}): HostedPlanMachine => ({
    ...hostedMachine(id, tier === FREE_TIER.id ? spentHours(0) : paidHours(tier), tier),
    paid: tier !== FREE_TIER.id,
    ...extra,
});
const account = (machines: HostedPlanMachine[], extra: Partial<HostedPlanState> = {}, hosted: Partial<NonNullable<HostedPlanState[`hosted`]>> = {}): HostedPlanState => ({
    enabled: true,
    onPlan: true,
    status: `active`,
    renewsAt: RENEWS_AT,
    priceUsd: STANDARD.priceUsd,
    onSale: [`standard`, `max`],
    hosted: { ...hostedLane(machines), freeLeft: 1, ...hosted },
    ...extra,
});
const offer = (state: HostedPlanState, sandboxId: string, tier: string, now = HALFWAY) => {
    const ladder = planLadder(state);
    const box = state.hosted?.machines.find((row) => row.sandboxId === sandboxId);
    if (box === undefined) {
        throw new Error(`no ${sandboxId}`);
    }
    return planOffer({ state, ladder, machine: box, now }, rungOf(ladder, tier));
};

describe(`the rest of the month`, () => {
    test(`is the share of the period from now to the renewal date, the period being the calendar month before it`, () => {
        expect(periodLeft(RENEWS_AT, HALFWAY)).toBe(0.5);
        expect(periodLeft(RENEWS_AT, Date.parse(RENEWS_AT))).toBe(0);
        expect(periodLeft(RENEWS_AT, Date.parse(`2026-11-01T00:00:00.000Z`))).toBe(1);
    });

    test(`an upgrade adds the difference in price for that share, to the cent, never less than nothing`, () => {
        expect(prorationUsd(20, 0, 0.5)).toBe(10);
        expect(prorationUsd(50, 20, 2 / 3)).toBe(20);
        expect(prorationUsd(20, 0, 0.6667)).toBe(13.33);
        expect(prorationUsd(20, 50, 0.5)).toBe(0);
    });
});

describe(`the sentence about money and the button that says the act`, () => {
    test(`an upgrade on a subscription is about the rest of this month on the next bill, then the monthly price`, () => {
        const shown = offer(account([machine(`test-chmura`, `free`)]), `test-chmura`, `standard`);
        expect(shown).toMatchObject({ act: `change`, paid: true, restarts: true, label: `Upgrade test-chmura · $20/month` });
        expect(shown.price).toBe(`About $10.00 for the rest of this month on your next bill (Dec 26), then $20 a month.`);
    });

    test(`from a paid plan, only the difference is prorated`, () => {
        const shown = offer(account([machine(`api`, `standard`)]), `api`, `max`);
        expect(shown.price).toBe(`About $15.00 for the rest of this month on your next bill (Dec 26), then $50 a month.`);
    });

    test(`a first purchase is Stripe's page, at the monthly price from today`, () => {
        const shown = offer(account([machine(`test-chmura`, `free`)], { onPlan: false, status: undefined, renewsAt: undefined }), `test-chmura`, `standard`);
        expect(shown).toMatchObject({ act: `checkout`, paid: true, label: `Continue to payment` });
        expect(shown.price).toBe(`$20 a month from today, paid on Stripe's page; you come straight back here.`);
    });

    test(`while a charge is being retried, an upgrade waits for the card rather than opening a second subscription`, () => {
        const shown = offer(account([machine(`test-chmura`, `free`)], { onPlan: false, status: `past_due` }), `test-chmura`, `standard`);
        expect(shown).toMatchObject({ act: `blocked`, paid: false, why: `Payment failed. Until it goes through, your paid sandboxes spend the free hours.` });
    });

    test(`a plan already paid for on no sandbox is used, with nothing more to pay`, () => {
        const shown = offer(account([machine(`test-chmura`, `free`)], {}, { openSeats: { standard: 1 } }), `test-chmura`, `standard`);
        expect(shown).toMatchObject({ act: `change`, paid: false, price: `Goes on the Standard plan you already pay for: nothing more is charged.` });
    });

    test(`a downgrade waits for the renewal date and keeps what was paid for until then`, () => {
        const shown = offer(account([machine(`docs`, `max`)]), `docs`, `standard`);
        expect(shown).toMatchObject({ act: `change`, paid: false, restarts: false, label: `Switch to Standard on Dec 26` });
        expect(shown.price).toBe(`From Dec 26 on Standard. Until then it stays Max.`);
    });

    test(`a downgrade waiting is withdrawn by keeping the plan it is on`, () => {
        const scheduled = machine(`docs`, `max`, { change: { tier: `standard`, at: RENEWS_AT } });
        expect(offer(account([scheduled]), `docs`, `max`)).toMatchObject({ act: `keep`, tier: `max`, label: `Keep Max` });
    });

    test(`an upgrade whose resize did not finish is tried again, already paid for`, () => {
        const failed = machine(`box`, `free`, {
            change: { tier: `standard`, at: `2026-12-10T00:00:00.000Z` },
            migration: { state: `rolledBack`, toTier: `standard`, startedAt: `2026-12-10T00:00:00.000Z`, error: `The new machine did not start.` },
        });
        expect(offer(account([failed]), `box`, `standard`)).toMatchObject({ act: `retry`, label: `Try again`, price: `Already paid for: nothing more is charged.` });
    });

    test(`Free is refused while another sandbox holds it, naming that sandbox`, () => {
        const state = account([machine(`scratch`, `free`), machine(`api`, `standard`)], {}, { freeLeft: 0 });
        expect(offer(state, `api`, `free`)).toMatchObject({ act: `blocked`, why: `Used by scratch` });
    });

    test(`a comped account moves at once and is told nothing about money`, () => {
        const state = account([machine(`box`, `free`), machine(`big`, `max`)], { comped: true, status: undefined });
        expect(offer(state, `box`, `standard`)).toMatchObject({ act: `change`, price: undefined, paid: false, label: `Upgrade box` });
        expect(offer(state, `big`, `standard`)).toMatchObject({ act: `change`, price: undefined, label: `Switch to Standard` });
    });

    test(`the plan it is on offers nothing to press`, () => {
        expect(offer(account([machine(`api`, `standard`)]), `api`, `standard`).act).toBe(`current`);
    });
});

describe(`what a change changes`, () => {
    test(`a downgrade keeps its disk, since disks never shrink`, () => {
        const state = account([machine(`docs`, `max`)]);
        const ladder = planLadder(state);
        const [box] = state.hosted?.machines ?? [];
        if (box === undefined) {
            throw new Error(`no machine`);
        }
        const disk = planDiff(box, rungOf(ladder, `max`), rungOf(ladder, `standard`)).find((row) => row.label === `Disk`);
        expect(disk).toEqual({ label: `Disk`, from: `${MAX.volumeGb} GB`, to: `${MAX.volumeGb} GB, kept`, more: false });
    });
});

describe(`what a sandbox's Plan card leads with`, () => {
    const ladder = planLadder(account([]));
    const lead = (box: HostedPlanMachine) => cardLead({ ladder, machine: box, now: HALFWAY });

    test(`a free sandbox with plenty of hours is offered a change, quietly`, () => {
        expect(lead(machine(`box`, `free`))).toEqual({ kind: `change` });
    });

    test(`a free sandbox at a fifth of its hours, out of them, or running out of memory is offered the next plan up`, () => {
        const fifth = FREE_TIER.monthlyHours * 60 * 0.8;
        expect(lead(machine(`box`, `free`, { hours: spentHours(fifth) }))).toMatchObject({ kind: `upgrade`, to: { id: `standard` } });
        expect(lead(machine(`box`, `free`, { hours: spentHours(FREE_TIER.monthlyHours * 60) }))).toMatchObject({ kind: `upgrade` });
        expect(lead(machine(`box`, `free`, { oomsThisWeek: 3 }))).toMatchObject({ kind: `upgrade`, to: { id: `standard` } });
    });

    test(`a paid sandbox is never pushed up, a lapsed one is renewed, a failed upgrade tried again, and a restart offers nothing`, () => {
        expect(lead(machine(`api`, `standard`, { oomsThisWeek: 5 }))).toEqual({ kind: `change` });
        expect(lead(machine(`api`, `standard`, { paid: false }))).toEqual({ kind: `renew` });
        const due = { tier: `standard`, at: `2026-12-10T00:00:00.000Z` };
        expect(lead(machine(`box`, `free`, { change: due, migration: { state: `failed`, toTier: `standard`, startedAt: due.at } }))).toEqual({ kind: `retry`, tier: `standard` });
        expect(lead(machine(`box`, `free`, { change: due, migration: { state: `applying`, toTier: `standard`, startedAt: due.at } }))).toEqual({ kind: `none` });
    });

    test(`the dialog opens on the plan the press is about, and a Billing row names its press`, () => {
        const context = (box: HostedPlanMachine) => ({ ladder, machine: box, now: HALFWAY });
        expect(openingTier(context(machine(`box`, `free`)))).toBe(`standard`);
        expect(openingTier(context(machine(`docs`, `max`, { change: { tier: `standard`, at: RENEWS_AT } })))).toBe(`max`);
        expect(rowActLabel(context(machine(`docs`, `max`, { change: { tier: `standard`, at: RENEWS_AT } })))).toBe(`Keep Max`);
        expect(rowActLabel(context(machine(`box`, `free`)))).toBe(`Upgrade`);
        expect(rowActLabel(context(machine(`api`, `standard`)))).toBe(`Change`);
    });
});

describe(`the bill`, () => {
    test(`is every paid sandbox and every plan on no sandbox, and next month's says what a scheduled change makes it`, () => {
        const state = account(
            [machine(`scratch`, `free`), machine(`api`, `standard`), machine(`docs`, `max`, { change: { tier: `standard`, at: RENEWS_AT } }), machine(`old`, `standard`, { paid: false })],
            {},
            { openSeats: { standard: 1 } },
        );
        expect(billOf(state, planLadder(state), HALFWAY)).toEqual({ monthlyUsd: 2 * STANDARD.priceUsd + MAX.priceUsd, nextUsd: 3 * STANDARD.priceUsd });
    });

    test(`ending the subscription makes next month's nothing`, () => {
        const state = account([machine(`api`, `standard`)], { cancelAtPeriodEnd: true });
        expect(billOf(state, planLadder(state), HALFWAY)).toEqual({ monthlyUsd: STANDARD.priceUsd, nextUsd: 0 });
    });
});

describe(`a plan on its way`, () => {
    const due = `2026-12-10T00:00:00.000Z`;

    test(`a change in the future is scheduled; a due upgrade restarts in steps; a due downgrade waits for its machine`, () => {
        expect(planMove(machine(`d`, `max`, { change: { tier: `standard`, at: RENEWS_AT } }), HALFWAY)).toEqual({ kind: `scheduled`, tier: `standard`, at: RENEWS_AT });
        expect(planMove(machine(`b`, `free`, { change: { tier: `standard`, at: due } }), HALFWAY)).toEqual({ kind: `moving`, tier: `standard`, since: due, step: `snapshot` });
        expect(planMove(machine(`d`, `max`, { change: { tier: `standard`, at: due } }), HALFWAY)).toEqual({ kind: `waiting`, tier: `standard` });
    });

    test(`the steps are paid, then snapshot, resize and start, each done once the machine is past it`, () => {
        const box = machine(`b`, `free`, { change: { tier: `standard`, at: due }, migration: { state: `applying`, toTier: `standard`, startedAt: due } });
        const move = planMove(box, HALFWAY);
        if (move.kind !== `moving`) {
            throw new Error(`not moving`);
        }
        expect(moveSteps(move, `free`, false).map((step) => [step.label, step.state])).toEqual([
            [`Paid`, `done`],
            [`Snapshot taken`, `done`],
            [`Resizing`, `active`],
            [`Starting`, `todo`],
        ]);
        expect(planMoving(account([box]), HALFWAY)).toBe(true);
        expect(planMoving(account([machine(`b`, `free`)]), HALFWAY)).toBe(false);
    });
});

describe(`a new sandbox on a plan`, () => {
    const plan = (state: HostedPlanState, tier: string) => newSandboxPlan(state, rungOf(planLadder(state), tier), HALFWAY);

    test(`Free is a plain create, with nothing about money`, () => {
        expect(plan(account([]), `free`)).toEqual({ act: `create`, label: undefined, price: undefined, paid: false });
    });

    test(`a subscriber reserves a plan first, the rest of this month prorated, and the press carries the price`, () => {
        expect(plan(account([]), `standard`)).toEqual({
            act: `reserve`,
            label: `Create · $20/month`,
            price: `About $10.00 for the rest of this month on your next bill (Dec 26), then $20 a month.`,
            paid: true,
        });
    });

    test(`a plan already paid for and waiting is used`, () => {
        expect(plan(account([], {}, { openSeats: { max: 1 } }), `max`)).toMatchObject({ act: `reserve`, paid: false, label: undefined });
    });

    test(`an account paying for nothing yet goes to Stripe's page first`, () => {
        expect(plan(account([], { onPlan: false, status: undefined, renewsAt: undefined }), `standard`)).toMatchObject({
            act: `checkout`,
            label: `Continue to payment · $20/month`,
            paid: true,
        });
    });
});
