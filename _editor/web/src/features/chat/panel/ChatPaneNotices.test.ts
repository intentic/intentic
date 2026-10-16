// The trial's standing above the composer: `unavailable` is an interruption (nothing answered, held below, needs
// Retry); `degraded` isn't (the pool answered after failing over). Both used to share one sentence and button,
// wrongly telling a working answer's reader their message had failed.
import "@intentic/testing/dom";
import type { HostedPlanState } from "@intentic/api-contract";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import { type App, createApp, defineComponent, h, nextTick, ref, shallowRef } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";
import { hostedLane, hostedMachine, hostedPlanState, spentHours } from "../../../testing/hostedPlan";
import { RouterLinkStub } from "../../../testing/routerLinkStub";
import type { ServingAccount } from "../../../models/conversations/accounts/servingAccount";

const provider = ref<AgentProvider>(TRIAL_PROVIDER);
const reachable = ref(true);
const streaming = ref(false);
const resume = jest.fn(async () => {});
const loadTrialStatus = jest.fn(async () => {});
// The provider's accounts, and the one the next turn runs on as the selection resolves it (servingAccount).
const accounts = ref<OauthAccount[]>([]);
const servingAccount = ref<ServingAccount | undefined>(undefined);

// The pane's own view, injected as the real strip would from ChatPane, mounted here directly.
jest.mock(`../../../models/conversations/accounts/useChat-catalog`, () => ({ loadTrialStatus }));
jest.mock(`../../../models/conversations/panel/useChat-view`, () => ({
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
jest.mock(`../../../models/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ state: hostedPlan, offered: planOffered }) }));
// An account whose one free machine, s1, has spent `usedMinutes` of the forty free hours.
const spending = (usedMinutes: number): HostedPlanState =>
    hostedPlanState(hostedLane([hostedMachine(`s1`, spentHours(usedMinutes))], spentHours(usedMinutes)));
jest.mock(`../../../models/fleet/useAgents`, () => ({
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

const { trialStatus } = await import("../../../models/providers/providerCatalog");
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
// failed-over pool is a working pool, so the card stays ordinary with the strain said beside the count, not replacing it.
it(`reports a pool that answered as a working trial, whatever it went through to answer`, () => {
    trialStatus.value = { ...trialStatus.value, health: `degraded`, servedModel: `gemini-flash-lite-latest` };

    const element = mount();

    expect(element.textContent).toContain(`4 of 10 free messages left today`);
    // Which rung answered is worth saying while the ladder is falling: it explains a weaker answer.
    expect(element.textContent).toContain(`Last answer: Gemini Flash Lite Latest`);
    expect(element.textContent).toContain(`Busy now, answers may be slower`);
    // The two false claims over an answered turn: that a message failed, and that there's something to press about.
    expect(element.textContent).not.toContain(`Failed messages`);
    expect(element.textContent).not.toContain(`degraded`);
    expect(named(element, `Retry`)).toBeUndefined();
});

// Healthy says nothing about the pool, nor which model answered (the model pill says that, as it does for any model):
// the count, what spends it and where it goes are the whole card, the reported "wall of text" cut to one line of facts.
it(`says only the count and its two facts while the pool is answering cleanly`, () => {
    trialStatus.value = { ...trialStatus.value, servedModel: `gemini-flash-latest` };

    const element = mount();

    expect(element.textContent).toContain(`4 of 10 free messages left today`);
    expect(element.textContent).toContain(`Each agent step uses one`);
    // Every surface offering the trial says it is routed through intentic (agent-catalog.ts).
    expect(element.textContent).toContain(`Sent via intentic`);
    expect(element.textContent).not.toContain(`Busy now`);
    expect(element.textContent).not.toContain(`Last answer`);
    expect(named(element, `Retry`)).toBeUndefined();
});

// The count's own bar empties the way the headline counts down, and turns amber for the last fifth.
it(`draws what is left as a bar that empties, amber once little is left`, async () => {
    const element = mount();
    const fill = (): HTMLElement | null => element.querySelector<HTMLElement>(`[aria-hidden="true"].rounded-full > div`);
    expect(fill()?.style.width).toBe(`40%`);
    expect(fill()?.className).toContain(`bg-primary-600`);

    trialStatus.value = { ...trialStatus.value, used: 8, remaining: 2 };
    await nextTick();
    expect(fill()?.style.width).toBe(`20%`);
    expect(fill()?.className).toContain(`bg-warning`);
});

// The first screen of a new account: a count plus a connect press over an unanswered chat reads as an imminent limit,
// so the card stays down until half the allowance is gone.
it(`stays down while more than half the allowance is left, and comes up at the halfway mark`, () => {
    trialStatus.value = { ...trialStatus.value, used: 2, remaining: 8 };
    let element = mount();
    expect(element.textContent).not.toContain(`free messages left`);
    expect(named(element, `Connect a model`)).toBeUndefined();
    app?.unmount();
    document.body.innerHTML = ``;

    trialStatus.value = { ...trialStatus.value, used: 5, remaining: 5 };
    element = mount();
    expect(element.textContent).toContain(`5 of 10 free messages left today`);
    expect(named(element, `Connect a model`)).toEqual(expect.any(Object));
});

// A strained pool is worth a line at any count — someone watching a slow answer wants it explained.
it(`says the pool is strained even while most of the allowance is left`, () => {
    trialStatus.value = { ...trialStatus.value, used: 1, remaining: 9, health: `degraded` };
    const element = mount();
    expect(element.textContent).toContain(`Busy now, answers may be slower`);
});

// The state that is an interruption: the turn is held below (the conversation's queue holds it, the platform refunds
// it), so the card names the failure and carries the resend press.
it(`interrupts, with the press that sends the held turn, only when nothing answered`, async () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();

    expect(element.textContent).toContain(`Free trial isn't answering right now`);
    expect(element.textContent).toContain(`Failed messages aren't counted`);

    named(element, `Retry`)?.click();
    await nextTick();

    expect(loadTrialStatus).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
});

// Spent is the signpost, not a warning, and it carries ONE press. The model list used to stand beside it, which was
// the same answer reached sideways: every row in that list a spent reader could use is already behind this door.
it(`turns into the way out once today's allowance is gone, saying when it comes back`, () => {
    trialStatus.value = { ...trialStatus.value, used: 10, remaining: 0, resetsAt: new Date(Date.now() + 3_600_000).toISOString() };

    const element = mount();

    expect(element.textContent).toContain(`Today's free messages are used up`);
    expect(element.textContent).toMatch(/Resets \S+ (today|tomorrow)/);
    expect(element.textContent).toContain(`Some models connect for free`);
    expect(named(element, `Connect a model`)?.getAttribute(`href`)).toBe(`/sandbox/models`);
    expect(named(element, `Choose a model`)).toBeUndefined();
});

// A reset the platform has not named yet is left unsaid rather than guessed.
it(`leaves the reset out when the platform has not said it`, () => {
    trialStatus.value = { ...trialStatus.value, used: 10, remaining: 0 };
    const element = mount();
    expect(element.textContent).toContain(`Today's free messages are used up`);
    expect(element.textContent).not.toContain(`Resets`);
});

// Why the old row looked broken: the actions were siblings of the sentence, each hung from its own box edge, and the
// sentence could shrink to nothing so `flex-wrap` never engaged. And the reported one: "Connect a model" drawn as bare
// link text, which nobody read as the card's press.
it(`hangs every action off one box, gives the words a floor to wrap against, and draws Connect as a button`, () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();
    const retry = named(element, `Retry`);
    const connect = named(element, `Connect a model`);

    expect(retry?.parentElement).toBe(connect?.parentElement);
    expect(retry?.parentElement?.className).toContain(`items-center`);
    // Both are the kit's button at the same size; the sign-in stays a real link for Ctrl/Cmd-click.
    expect(retry?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(connect?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(connect?.className).not.toContain(`p-button-text`);
    expect(connect?.tagName).toBe(`A`);
    const words = [...element.querySelectorAll(`div`)].find((div) => div.className.includes(`min-w-[12rem]`));
    expect(words?.textContent).toContain(`Free trial isn't answering`);
    expect(words?.className).not.toContain(`min-w-0`);
});

// The last of the hours THIS sandbox spends, above the composer, to the one person spending them: only on a hosted
// sandbox, only its owner (a guest can't buy more), only while its machine's hours are low, with a door to Billing.
it(`warns a hosted sandbox's owner about its machine's last hours, and nobody else`, async () => {
    provider.value = `claude`;
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
