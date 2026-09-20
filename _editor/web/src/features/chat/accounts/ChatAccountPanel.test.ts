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

beforeEach(() => {
    connected.value = false;
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    provider.value = `claude`;
    // A sandbox nobody has chosen a model in, which is what a first run is.
    turnDefaults.provider.value = undefined;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    endpointProviders.value = [];
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
    // What is offered instead: the model list, plus this provider's own sign-in.
    expect(buttonNamed(element, `Choose a model`)).toEqual(expect.any(Object));
    expect(buttonNamed(element, `Connect Claude subscription`)).toEqual(expect.any(Object));
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

// Picking a locked model starts its sign-in in place; a live sign-in takes the whole strip rather
// than sitting under a "not connected" line.
it(`runs the sign-in in place, and puts the line back when it is abandoned`, async () => {
    turnDefaults.provider.value = `claude`;
    const element = mount();

    buttonNamed(element, `Connect Claude subscription`)!.click();
    expect(startConnect).toHaveBeenCalledTimes(1);

    nativeConnectFlow.value = { provider: `claude`, url: `https://claude.ai/oauth`, code: `` };
    await nextTick();
    expect(element.textContent).toContain(`Connecting Claude`);
    expect(element.textContent).not.toContain(`isn't connected`);

    buttonNamed(element, `Cancel`)!.click();
    await nextTick();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
});

// Google authenticates through the bundled translator, not a daemon-stored account; one press starts
// the matching handshake.
it(`starts the routed handshake for a provider that authenticates through the translator`, () => {
    provider.value = `gemini`;
    turnDefaults.provider.value = `gemini`;
    const element = mount();

    expect(element.textContent).toContain(`Google isn't connected in this sandbox`);
    buttonNamed(element, `Connect Google sign-in`)!.click();
    expect(connectTranslator).toHaveBeenCalledWith(`gemini`);
    expect(startConnect).not.toHaveBeenCalled();
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

it(`goes on its own the moment this chat can send`, async () => {
    const element = mount();
    expect(element.textContent).toContain(`No model is connected in this sandbox yet.`);

    connected.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);
});
