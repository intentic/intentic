// The trial's standing above the composer: `unavailable` is an interruption (nothing answered, held below, needs
// Retry); `degraded` isn't (the pool answered after failing over). Both used to share one sentence and button,
// wrongly telling a working answer's reader their message had failed.
import "@intentic/testing/dom";
import type { HostedPlanState } from "@intentic/api-contract";
import { type AgentProvider, type OauthAccount, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h, nextTick, ref, shallowRef } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";
import { hostedLane, hostedMachine, hostedPlanState, spentHours } from "../../../testing/hostedPlan";
import { RouterLinkStub } from "../../../testing/routerLinkStub";
import type { ServingAccount } from "../accounts/servingAccount";

const provider = ref<AgentProvider>(TRIAL_PROVIDER);
const reachable = ref(true);
const streaming = ref(false);
const resume = jest.fn(async () => {});
const loadTrialStatus = jest.fn(async () => {});
// The provider's accounts, and the one the next turn runs on as the selection resolves it (servingAccount).
const accounts = ref<OauthAccount[]>([]);
const servingAccount = ref<ServingAccount | undefined>(undefined);

// The pane's own view, injected as the real strip would from ChatPane, mounted here directly.
jest.mock(`../models/useChat-catalog`, () => ({ loadTrialStatus }));
jest.mock(`./useChat-view`, () => ({
    usePaneView: () => ({
        // Shallow, as the conversation list holds them (sandboxShallowRef): a deep ref would unwrap the selection's refs.
        conversation: shallowRef({ conversationId: `agent-1`, turn: { resume }, selection: { servingAccount } }),
        provider,
        account: ref(undefined),
        accounts,
        streaming,
        harness: ref(`claude-code`),
        model: ref(`gemini-flash-latest`),
        selectModel: () => {},
        selectHarness: () => {},
        selectAccount: () => {},
    }),
}));
// The active sandbox, for the hosted-hours strip: a hosted row its reader owns, or nothing.
const active = ref<{ id: string; hosted: { region: string; warm: boolean } | null; role: string } | undefined>(undefined);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable, active }) }));
// The plan state as the strip reads it: settable, so what counts as low is hostedHours.ts's own rule.
const hostedPlan = ref<HostedPlanState | undefined>(undefined);
const planOffered = ref(true);
jest.mock(`../../settings/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ state: hostedPlan, offered: planOffered }) }));
// An account whose one free machine, s1, has spent `usedMinutes` of the forty free hours.
const spending = (usedMinutes: number): HostedPlanState =>
    hostedPlanState(hostedLane([hostedMachine(`s1`, spentHours(usedMinutes))], spentHours(usedMinutes)));
jest.mock(`../../agents/fleet/useAgents`, () => ({
    useAgents: () => ({
        agentById: () => undefined,
        archived: ref([]),
        loadArchived: jest.fn(async () => {}),
        restore: jest.fn(),
        busyIds: ref([]),
    }),
}));
// The account gate is its own component with its own test; this file is only about the trial strip beneath it.
jest.mock(`../accounts/ChatAccountPanel.vue`, () => ({ default: defineComponent({ name: `ChatAccountPanel`, setup: () => () => undefined }) }));
// The needs strip reads the sandbox's needs store, which is not what these notices are about.
jest.mock(`../../needs/NeedsStrip.vue`, () => ({ default: defineComponent({ name: `NeedsStrip`, setup: () => () => undefined }) }));
// The privacy shield's strip reads the shield's own status, and has its own test (privacy/ChatPrivacyStrip.test.ts).
jest.mock(`./privacy/ChatPrivacyStrip.vue`, () => ({ default: defineComponent({ name: `ChatPrivacyStrip`, setup: () => () => undefined }) }));
jest.mock(`vue-router`, () => ({
    ...vueRouterOriginal,
    RouterLink: RouterLinkStub as never,
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
    hostedPlan.value = undefined;
    trialStatus.value = { available: true, allowance: 10, used: 6, remaining: 4, health: `healthy` };
    accounts.value = [];
    servingAccount.value = undefined;
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
    expect(element.textContent).toContain(`Last answer: Gemini Flash Lite Latest`);
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

// The first screen of a new account: a count plus a connect press over an unanswered chat reads as an imminent limit,
// so the strip stays down until half the allowance is gone.
it(`stays down while more than half the allowance is left, and comes up at the halfway mark`, () => {
    trialStatus.value = { ...trialStatus.value, used: 2, remaining: 8 };
    let element = mount();
    expect(element.textContent).not.toContain(`free messages left`);
    expect(named(element, `Connect a model`)).toBeUndefined();
    app?.unmount();
    document.body.innerHTML = ``;

    trialStatus.value = { ...trialStatus.value, used: 5, remaining: 5 };
    element = mount();
    expect(element.textContent).toContain(`5 free messages left today`);
    expect(named(element, `Connect a model`)).toEqual(expect.any(Object));
});

// A strained pool is worth a line at any count — someone watching a slow answer wants it explained.
it(`says the pool is strained even while most of the allowance is left`, () => {
    trialStatus.value = { ...trialStatus.value, used: 1, remaining: 9, health: `degraded` };
    const element = mount();
    expect(element.textContent).toContain(`Trial capacity is tight right now`);
});

// The state that is an interruption: the turn is held below (the conversation's queue holds it, the platform refunds
// it), so the strip names the failure and carries the resend press.
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

// Spent is the signpost, not a warning, and it carries ONE press. The model list used to stand beside it, which was
// the same answer reached sideways: every row in that list a spent reader could use is already behind this door.
it(`turns into the way out once today's allowance is gone`, () => {
    trialStatus.value = { ...trialStatus.value, used: 10, remaining: 0 };

    const element = mount();

    expect(element.textContent).toContain(`Free trial used up for today`);
    expect(named(element, `Connect a model`)?.getAttribute(`href`)).toBe(`/sandbox/models`);
    expect(named(element, `Choose a model`)).toBeUndefined();
});

// Why the row looked broken: the actions were siblings of the sentence, each hung from its own box edge, and the
// sentence could shrink to nothing so `flex-wrap` never engaged.
it(`hangs every action off one box, and gives the sentence a floor to wrap against`, () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();
    const retry = named(element, `Retry`);
    const connect = named(element, `Connect a model`);

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

// The last of the hours THIS sandbox spends, above the composer, to the one person spending them: only on a hosted
// sandbox, only its owner (a guest can't buy more), only while its machine's hours are low, with a door to Billing.
it(`warns a hosted sandbox's owner about its machine's last hours, and nobody else`, async () => {
    provider.value = `claude` as AgentProvider;
    hostedPlan.value = spending(2_160);
    active.value = { id: `s1`, hosted: { region: `arn`, warm: true }, role: `owner` };
    const root = mount();
    await nextTick();
    expect(root.textContent).toContain(`Free hours · 4h of 40h left this month`);
    expect(root.textContent).toContain(`Billing`);

    // A guest on the same sandbox is told nothing: the hours are the owner's to buy back.
    active.value = { id: `s1`, hosted: { region: `arn`, warm: true }, role: `maintainer` };
    await nextTick();
    expect(root.textContent).not.toContain(`left this month`);

    // Nor is anyone on a sandbox on their own computer, whatever the account's hosted hours say, or while most of the
    // month remains.
    active.value = { id: `local`, hosted: null, role: `owner` };
    await nextTick();
    expect(root.textContent).not.toContain(`left this month`);
    active.value = { id: `s1`, hosted: { region: `arn`, warm: true }, role: `owner` };
    hostedPlan.value = spending(600);
    await nextTick();
    expect(root.textContent).not.toContain(`left this month`);
});

// The reconnect strip is about the credential the next turn runs on (servingAccount). On auto that is the daemon's own
// pick, which skips an expired first account, so a chat that will run fine is not told to reconnect.
it(`asks for a reconnect only when the account the next turn runs on has lost its sign-in`, async () => {
    provider.value = `claude`;
    accounts.value = [
        { id: `expired`, label: `Work`, connectedAt: 0, needsReauth: true, detail: `Work's sign-in expired.` },
        { id: `fine`, label: `Personal`, connectedAt: 0 },
    ];
    servingAccount.value = { id: `fine`, byAllowance: true };
    const root = mount();
    await nextTick();
    expect(root.textContent).not.toContain(`Work's sign-in expired.`);

    servingAccount.value = { id: `expired`, byAllowance: false };
    await nextTick();
    expect(named(root, `Reconnect`)?.textContent).toContain(`Work's sign-in expired.`);
});
