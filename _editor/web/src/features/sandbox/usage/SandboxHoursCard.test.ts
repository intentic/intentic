// jsdom: mounts the card and reads what it says to each reader.
import "@intentic/testing/dom";
import type { HostedHoursMeter, HostedPlanState, SandboxSummary } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";
import * as vueRouterOriginal from "vue-router";
import { hostedLane, hostedMachine, hostedPlanState, spentHours } from "../../../testing/hostedPlan";
import { RouterLinkStub } from "../../../testing/routerLinkStub";

// Pins the one answer this card owes on a sandbox's Usage tab: whether its awake time costs hours. A sandbox on its
// owner's own computer is told it never does, whatever the account's hosted hours say; a hosted one's owner sees the
// hours that machine spends and when they come back; a guest is told whose hours they are; and a platform that hosts
// nothing gets no card at all.

const active = ref<Partial<SandboxSummary> | undefined>(undefined);
jest.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ active }) }));
const hostedPlan = ref<HostedPlanState | undefined>(undefined);
const planOffered = ref(true);
jest.mock(`../../settings/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ state: hostedPlan, offered: planOffered }) }));
// SAFETY: the card's one link passes a string `to`, which the stub renders as the anchor RouterLink would; vue-router's
// own type describes the whole component API, which no stub can claim to be.
jest.mock(`vue-router`, () => ({ ...vueRouterOriginal, RouterLink: RouterLinkStub as never }));

const { default: SandboxHoursCard } = await import("./SandboxHoursCard.vue");

const STANDARD = hostedTier(`standard`);

// An account holding one hosted machine, `box`, that spends `hours`; a comped account's free hours count against no
// limit either.
const holding = (hours: HostedHoursMeter, tier: string = FREE_TIER.id, comped = false): HostedPlanState =>
    hostedPlanState(hostedLane([hostedMachine(`box`, hours, tier)], comped ? spentHours(0, null) : spentHours(0)), comped);

const HOSTED = { region: `arn`, warm: true };

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(SandboxHoursCard) });
    app.component(`Icon`, IconStub);
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    active.value = undefined;
    hostedPlan.value = undefined;
    planOffered.value = true;
});

it(`tells a sandbox on its owner's computer that it is never metered, whatever the account's hosted hours say`, async () => {
    active.value = { id: `local`, role: `owner`, hosted: null };
    hostedPlan.value = holding(spentHours(2_280));
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`Runs on your own computer`);
    expect(root.textContent).toContain(`never metered`);
    expect(root.textContent).not.toContain(`left this month`);
});

it(`shows a hosted sandbox's owner the free hours its machine spends, and when they come back`, async () => {
    active.value = { id: `box`, role: `owner`, hosted: HOSTED };
    hostedPlan.value = holding(spentHours(1_680));
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`Free hours`);
    expect(root.textContent).toContain(`12 h of 40 h left this month`);
    expect(root.textContent).toContain(`shared by every hosted sandbox of yours that isn't on a paid slot`);
    expect(root.querySelector(`a`)?.getAttribute(`href`)).toBe(`/settings/billing`);
});

it(`shows a machine on a paid slot its own month, named by its rung`, async () => {
    active.value = { id: `box`, role: `owner`, hosted: HOSTED };
    hostedPlan.value = holding(spentHours(600, STANDARD.monthlyHours * 60, `slot`), STANDARD.id);
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`Standard hours`);
    expect(root.textContent).toContain(`210 h of 220 h left this month`);
    expect(root.textContent).toContain(`This sandbox's own hours, on its Standard slot`);
});

it(`says a comped owner's hours are counted against no limit, with no bar to fill`, async () => {
    active.value = { id: `box`, role: `owner`, hosted: HOSTED };
    hostedPlan.value = holding(spentHours(120, null), FREE_TIER.id, true);
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`On the house`);
    expect(root.textContent).toContain(`2 h awake this month`);
    expect(root.querySelector(`[role="presentation"]`)).toBeNull();
});

it(`tells a guest whose hours a hosted sandbox spends, and shows them none of the owner's figures`, async () => {
    active.value = { id: `theirs`, role: `maintainer`, hosted: HOSTED };
    hostedPlan.value = holding(spentHours(1_680));
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`counted on the owner's account`);
    expect(root.textContent).not.toContain(`left this month`);
});

it(`says nothing where the platform hosts no machines at all`, async () => {
    active.value = { id: `local`, role: `owner`, hosted: null };
    hostedPlan.value = { enabled: false, onPlan: false, priceUsd: 0 };
    const root = mount();
    await nextTick();
    expect(root.textContent?.trim()).toBe(``);
});
