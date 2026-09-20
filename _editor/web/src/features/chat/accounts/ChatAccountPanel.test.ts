// @vitest-environment jsdom
// The line above the composer when this chat has nothing to send with; it never pitches, and it names a
// vendor only where the owner named one first. It stays silent through both the account and endpoint reads
// rather than claiming anything, and for a spent trial, which is connected but out of allowance.
import { type AgentProvider, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const connected = ref(false);
const accountsLoaded = ref(true);
const endpointsLoaded = ref(true);
const nativeConnectFlow = ref<{ provider: AgentProvider; url: string; code: string } | undefined>(undefined);
const translatorConnectFlow = ref<undefined>(undefined);
const provider = ref<AgentProvider>(`claude`);
const selectModel = vi.fn();
const startConnect = vi.fn();
const connectTranslator = vi.fn();

// The two reads `accessKnown` needs, mocked at their source so `accessKnown` itself runs unmocked.
vi.mock(`./providerAccounts`, async (importOriginal) => ({
    ...(await importOriginal<object>()),
    accountsLoaded,
}));
vi.mock(`./providerCatalog`, async (importOriginal) => ({
    ...(await importOriginal<object>()),
    endpointsLoaded,
}));

// The pane's view the real panel injects from ChatPane; mounted bare here and handed over directly.
vi.mock(`../run/useChat`, () => ({
    useChat: () => ({
        nativeConnectFlow,
        translatorConnectFlow,
        startConnect,
        connectTranslator,
        setManagedProvider: () => {},
        cancelConnect: () => (nativeConnectFlow.value = undefined),
        cancelTranslatorConnect: () => {},
        accountBusy: ref(undefined),
        translatorKey: (target: string) => `translator:${target}`,
        connectLabel: ref(``),
        // Whether the reader has been handed to the provider yet: ConnectFlow picks which of its two steps to draw
        // from this, so an absent one is not a missing convenience, it is the panel failing to render at all.
        connectSent: ref(false),
        completeConnect: () => {},
        completeTranslator: () => {},
    }),
}));
vi.mock(`../panel/useChat-view`, () => ({
    usePaneView: () => ({
        connected,
        provider,
        harness: ref(`claude-code`),
        model: ref(`claude-opus-4-6`),
        selectModel,
        selectHarness: () => {},
        selectAccount: () => {},
    }),
}));
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { modelRequest, settleModelPick } = await import("../models/host/hostModelPicker");
const { endpointProviders, trialStatus } = await import("./providerCatalog");
// The stored pick itself, unmocked: whether a vendor may be named at all is exactly "did the owner name one".
const { turnDefaults } = await import("../run/turnDefaults");
const { connectIntroDismissed } = await import("../../connect/connectIntro");
const { default: ChatAccountPanel } = await import("./ChatAccountPanel.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatAccountPanel) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const buttonNamed = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(label));

const linkNamed = (element: HTMLElement, label: string): HTMLAnchorElement | undefined =>
    [...element.querySelectorAll(`a`)].find((link) => link.textContent?.includes(label));

beforeEach(() => {
    connected.value = false;
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    provider.value = `claude`;
    // A sandbox nobody has chosen a model in, which is what a first run is.
    turnDefaults.provider.value = undefined;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    endpointProviders.value = [];
    // Persisted across mounts by design, so a suite that never reset it would let the dismiss test silence every one
    // after it.
    connectIntroDismissed.value = false;
    nativeConnectFlow.value = undefined;
    selectModel.mockClear();
    startConnect.mockClear();
    connectTranslator.mockClear();
    settleModelPick(undefined);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`names what this chat is pointed at, and pitches nothing`, () => {
    turnDefaults.provider.value = `claude`;
    const element = mount();

    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
    expect(element.textContent).not.toContain(`Try free with Google`);
    expect(buttonNamed(element, `Continue with Google`)).toBeUndefined();
    // What is offered instead: the model list, plus the door to the view that connects one. No sign-in starts here —
    // a handshake is a trip to another tab and back, which eighty pixels over a composer is the wrong host for.
    expect(buttonNamed(element, `Choose a model`)).toEqual(expect.any(Object));
    expect(linkNamed(element, `Connect a model`)?.getAttribute(`href`)).toBe(`/connect`);
});

// The reported bug: a brand-new sandbox told its owner that Claude was missing, and offered to connect a Claude
// subscription — over a chat sitting on the app's own floor provider, which nobody chose. The app is not any one
// vendor's, so with nothing chosen there is no vendor to name and no sign-in to push.
it(`names no vendor, and pitches no sign-in, where nobody has chosen one`, () => {
    const element = mount();

    expect(element.textContent).toContain(`No model is connected in this sandbox yet.`);
    expect(element.textContent).not.toContain(`Claude`);
    expect(buttonNamed(element, `Connect Claude subscription`)).toBeUndefined();
    // The one action this strip carries with nothing chosen, and the only one it ever needs.
    expect(buttonNamed(element, `Choose a model`)).toEqual(expect.any(Object));
});

// Accounts resolve in one hop; endpoints take a capability read, a catalog fetch, and a round-trip, so a fresh
// sandbox looks briefly empty even with a trial available. Nothing is drawn through it: the composer below stands
// throughout, and a strip that appears only to be replaced a beat later is the flicker, not a reassurance.
it(`draws nothing at all until BOTH halves of the picture have landed`, async () => {
    turnDefaults.provider.value = `claude`;
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    const element = mount();

    expect(element.textContent).toBe(``);

    // Accounts land first, as they do in the app; this gate still waits for endpoints too.
    accountsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);

    endpointsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
});

// The composer carries its own model pill, so this button is the second door to the same list; it opens the
// shell's picker anchored to itself and applies the answer to this pane.
it(`opens the model list, anchored to its own button`, async () => {
    const element = mount();

    const press = buttonNamed(element, `Choose a model`)!;
    press.click();
    await nextTick();

    expect(modelRequest.value?.anchor).toBe(press);
    expect(modelRequest.value?.provider).toBe(`claude`);

    // A picked row applies to this pane's own conversation.
    settleModelPick({ provider: `gemini`, model: `gemini-3-pro`, label: `Gemini 3 Pro` });
    await nextTick();
    expect(selectModel).toHaveBeenCalledWith({ provider: `gemini`, value: `gemini-3-pro` });
});

// A sign-in is never started from here, whichever mechanism the chat's provider uses: this strip's whole job is to
// name the standing and point at the one place that holds a handshake.
it(`starts no handshake of its own, for either credential mechanism`, () => {
    for (const target of [`claude`, `gemini`] as const) {
        provider.value = target;
        turnDefaults.provider.value = target;
        const element = mount();
        expect(linkNamed(element, `Connect a model`)?.getAttribute(`href`)).toBe(`/connect`);
        app?.unmount();
        element.remove();
    }
    expect(startConnect).not.toHaveBeenCalled();
    expect(connectTranslator).not.toHaveBeenCalled();
});

// A handshake started anywhere is finishable: the strip stops offering a new connection and carries the way back to
// the one in flight, so a reader who wandered into a chat mid-sign-in is not stranded.
it(`points back at a sign-in already under way instead of offering another`, async () => {
    turnDefaults.provider.value = `claude`;
    const element = mount();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);

    nativeConnectFlow.value = { provider: `claude`, url: `https://claude.ai/oauth`, code: `` };
    await nextTick();
    expect(element.textContent).toContain(`it is waiting for you`);
    expect(element.textContent).not.toContain(`isn't connected`);
    expect(linkNamed(element, `Finish sign-in`)?.getAttribute(`href`)).toBe(`/connect`);

    // Abandoned elsewhere, the line comes back rather than leaving a dead pointer.
    nativeConnectFlow.value = undefined;
    await nextTick();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
});

// A spent trial is connected but out of allowance, not missing a connection, so this gate stands down
// and lets the trial strip say so once.
it(`stands down for a spent trial instead of calling it unconnected`, () => {
    provider.value = TRIAL_PROVIDER;
    trialStatus.value = { available: true, allowance: 20, used: 20, remaining: 0, health: `healthy` };

    expect(mount().textContent).toBe(``);
});

// An unconfirmed trial is a missing connection, unlike a spent one, so this gate still reports it — by the trial's
// own name, since the owner chose it, and with no sign-in to push (an endpoint has no account to connect).
it(`still speaks when the trial is absent rather than spent`, () => {
    provider.value = TRIAL_PROVIDER;
    turnDefaults.provider.value = TRIAL_PROVIDER;
    // The trial is an endpoint the daemon publishes with its own label; that listing is where its name comes from.
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];

    const element = mount();
    expect(element.textContent).toContain(`Free trial isn't connected in this sandbox`);
    expect(buttonNamed(element, `Connect`)).toBeUndefined();
});

// Said early and quietly, on a sandbox running on nothing but the trial. The alternative was meeting the question for
// the first time at the moment the allowance ran out, mid-task.
it(`offers the way off the trial while there is still plenty of it left`, async () => {
    provider.value = TRIAL_PROVIDER;
    connected.value = true;
    trialStatus.value = { available: true, allowance: 10, used: 1, remaining: 9, health: `healthy` };

    const element = mount();
    expect(element.textContent).toContain(`Running on the free trial`);
    expect(linkNamed(element, `Connect a model`)?.getAttribute(`href`)).toBe(`/connect`);

    // Answered once, gone for good: a reader happy on the trial has made their choice.
    buttonNamed(element, `Dismiss`)!.click();
    await nextTick();
    expect(element.textContent).toBe(``);
});

// Past halfway the trial strip takes over with the same offer and a count; two rows saying it at once is the crowding
// this view was built to end.
it(`stands down once the trial strip starts saying it`, () => {
    provider.value = TRIAL_PROVIDER;
    connected.value = true;
    trialStatus.value = { available: true, allowance: 10, used: 6, remaining: 4, health: `healthy` };

    expect(mount().textContent).toBe(``);
});

// An offer, not a nag: a sandbox with a real account connected has answered it, whatever this one chat points at.
it(`says nothing once anything real is connected`, () => {
    provider.value = TRIAL_PROVIDER;
    connected.value = true;
    trialStatus.value = { available: true, allowance: 10, used: 1, remaining: 9, health: `healthy` };
    endpointProviders.value = [{ id: `endpoint/box`, label: `Qwen`, kind: `localmodel` }];

    expect(mount().textContent).toBe(``);
});

it(`goes on its own the moment this chat can send`, async () => {
    const element = mount();
    expect(element.textContent).toContain(`No model is connected in this sandbox yet.`);

    connected.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);
});
