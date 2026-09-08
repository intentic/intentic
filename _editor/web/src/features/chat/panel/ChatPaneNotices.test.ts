// @vitest-environment jsdom
// The trial's standing above the composer: `unavailable` is an interruption (nothing answered, held below, needs
// Retry); `degraded` isn't (the pool answered after failing over). Both used to share one sentence and button,
// wrongly telling a working answer's reader their message had failed.
import { type AgentProvider, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const provider = ref<AgentProvider>(TRIAL_PROVIDER);
const reachable = ref(true);
const streaming = ref(false);
const resume = vi.fn(async () => {});
const loadTrialStatus = vi.fn(async () => {});

// The pane's own view, injected as the real strip would from ChatPane, mounted here directly.
vi.mock(`../models/useChat-catalog`, () => ({ loadTrialStatus }));
vi.mock(`./useChat-view`, () => ({
    usePaneView: () => ({
        conversation: ref({ conversationId: `agent-1`, resume }),
        provider,
        account: ref(undefined),
        accounts: ref([]),
        streaming,
        harness: ref(`claude-code`),
        model: ref(`gemini-flash-latest`),
        selectModel: () => {},
        selectHarness: () => {},
        selectAccount: () => {},
    }),
}));
// The active sandbox, for the hosted-hours strip: a hosted row its reader owns, or nothing.
const active = ref<{ hosted: { region: string; warm: boolean } | null; role: string } | undefined>(undefined);
vi.mock(`../../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ reachable, active }) }));
// The free lane's meter as the strip reads it: settable, so the threshold is hostedHours.ts's rule.
const hostedMeter = ref<{ usedMinutes: number; allowanceMinutes: number; remainingMinutes: number; fraction: number; resetsAt: string } | undefined>(undefined);
const lowOnHours = ref(false);
const planOffered = ref(true);
vi.mock(`../../settings/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ meter: hostedMeter, lowOnHours, offered: planOffered }) }));
vi.mock(`../../agents/fleet/useAgents`, () => ({
    useAgents: () => ({
        agentById: () => undefined,
        archived: ref([]),
        loadArchived: vi.fn(async () => {}),
        restore: vi.fn(),
        busyIds: ref([]),
    }),
}));
// The account gate is its own component with its own test; this file is only about the trial strip beneath it.
vi.mock(`../accounts/ChatAccountPanel.vue`, () => ({ default: defineComponent({ name: `ChatAccountPanel`, setup: () => () => undefined }) }));
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    RouterLink: (await import(`../../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { trialStatus } = await import("../accounts/providerCatalog");
const { default: ChatPaneNotices } = await import("./ChatPaneNotices.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatPaneNotices) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const named = (element: HTMLElement, label: string): HTMLElement | undefined =>
    [...element.querySelectorAll(`button, a`)].find((control): control is HTMLElement => control.textContent?.includes(label) === true);

beforeEach(() => {
    provider.value = TRIAL_PROVIDER;
    reachable.value = true;
    streaming.value = false;
    active.value = undefined;
    hostedMeter.value = undefined;
    lowOnHours.value = false;
    trialStatus.value = { available: true, allowance: 10, used: 6, remaining: 4, health: `healthy` };
    resume.mockClear();
    loadTrialStatus.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The reported bug: "Free trial degraded. Failed messages are not counted." on a chat whose model just answered. A
// failed-over pool is a working pool, so the line stays ordinary with the state appended, not replacing it.
it(`reports a pool that answered as a working trial, whatever it went through to answer`, () => {
    trialStatus.value = { ...trialStatus.value, health: `degraded`, servedModel: `gemini-flash-lite-latest` };

    const element = mount();

    expect(element.textContent).toContain(`4 free messages left today`);
    expect(element.textContent).toContain(`Last answer: gemini-flash-lite-latest`);
    expect(element.textContent).toContain(`Trial capacity is tight right now`);
    // The two false claims over an answered turn: that a message failed, and that there's something to press about.
    expect(element.textContent).not.toContain(`Failed messages are not counted`);
    expect(element.textContent).not.toContain(`degraded`);
    expect(named(element, `Retry`)).toBeUndefined();
});

// Healthy says nothing about the pool: there's nothing to say, and the count is what the reader wants.
it(`says nothing about the pool while it is answering cleanly`, () => {
    const element = mount();

    expect(element.textContent).toContain(`4 free messages left today`);
    expect(element.textContent).not.toContain(`Trial capacity is tight`);
    expect(named(element, `Retry`)).toBeUndefined();
});

// The first screen of a new account: a count plus "Connect Google" over an unanswered chat reads as an imminent
// limit, so the strip stays down until half the allowance is gone.
it(`stays down while more than half the allowance is left, and comes up at the halfway mark`, () => {
    trialStatus.value = { ...trialStatus.value, used: 2, remaining: 8 };
    let element = mount();
    expect(element.textContent).not.toContain(`free messages left`);
    expect(named(element, `Connect Google`)).toBeUndefined();
    app?.unmount();
    document.body.innerHTML = ``;

    trialStatus.value = { ...trialStatus.value, used: 5, remaining: 5 };
    element = mount();
    expect(element.textContent).toContain(`5 free messages left today`);
    expect(named(element, `Connect Google`)).toEqual(expect.any(Object));
});

// A strained pool is worth a line at any count — someone watching a slow answer wants it explained.
it(`says the pool is strained even while most of the allowance is left`, () => {
    trialStatus.value = { ...trialStatus.value, used: 1, remaining: 9, health: `degraded` };
    const element = mount();
    expect(element.textContent).toContain(`Trial capacity is tight right now`);
});

// The state that is an interruption: the turn is held below (turnFailures holds it, the platform refunds it), so
// the strip names the failure and carries the resend press.
it(`interrupts, with the press that sends the held turn, only when nothing answered`, async () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();

    expect(element.textContent).toContain(`Free trial isn't answering right now`);
    expect(element.textContent).toContain(`Failed messages are not counted`);

    named(element, `Retry`)?.click();
    await nextTick();

    expect(loadTrialStatus).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
});

// Spent is the signpost, not a warning: the free sign-in and the model list are each one press away.
it(`turns into the way out once today's allowance is gone`, () => {
    trialStatus.value = { ...trialStatus.value, used: 10, remaining: 0 };

    const element = mount();

    expect(element.textContent).toContain(`Free trial used up for today`);
    expect(named(element, `Choose a model`)).toEqual(expect.any(Object));
    expect(named(element, `Connect Google`)).toEqual(expect.any(Object));
});

// Why the row looked broken: the actions were siblings of the sentence, each hung from its own box edge, and the
// sentence could shrink to nothing so `flex-wrap` never engaged.
it(`hangs every action off one box, and gives the sentence a floor to wrap against`, () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();
    const retry = named(element, `Retry`);
    const connect = named(element, `Connect Google`);

    expect(retry?.parentElement).toBe(connect?.parentElement);
    expect(retry?.parentElement?.className).toContain(`items-center`);
    // Both are the kit's button at the same size; the sign-in stays a real link for Ctrl/Cmd-click.
    expect(retry?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(connect?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(connect?.tagName).toBe(`A`);
    const sentence = [...element.querySelectorAll(`span`)].find((span) => span.textContent?.includes(`Free trial isn't answering`) === true);
    expect(sentence?.className).toContain(`min-w-[14rem]`);
    expect(sentence?.className).not.toContain(`min-w-0`);
});

// The free lane's last hours, above the composer, to the one person spending them: only on a hosted sandbox, only
// its owner (a guest can't buy more), only while the meter says low, with a door to Billing.
it(`warns a hosted sandbox's owner about the last free hours, and nobody else`, async () => {
    provider.value = `claude` as AgentProvider;
    hostedMeter.value = { usedMinutes: 2_160, allowanceMinutes: 2_400, remainingMinutes: 240, fraction: 0.1, resetsAt: `2026-10-01T00:00:00.000Z` };
    lowOnHours.value = true;
    active.value = { hosted: { region: `arn`, warm: true }, role: `owner` };
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`4 h of 40 h left this month`);
    expect(root.textContent).toContain(`Billing`);

    // A guest on the same sandbox is told nothing: the hours are the owner's to buy back.
    active.value = { hosted: { region: `arn`, warm: true }, role: `maintainer` };
    await nextTick();
    expect(root.textContent).not.toContain(`left this month`);

    // Nor is anyone on a non-hosted sandbox, or while most of the month remains.
    active.value = { hosted: null, role: `owner` };
    await nextTick();
    expect(root.textContent).not.toContain(`left this month`);
    active.value = { hosted: { region: `arn`, warm: true }, role: `owner` };
    lowOnHours.value = false;
    await nextTick();
    expect(root.textContent).not.toContain(`left this month`);
});
