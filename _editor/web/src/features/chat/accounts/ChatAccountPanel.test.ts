// The line above the composer when this chat has nothing to send with; it never pitches, and it names a
// vendor only where the owner named one first. It stays silent through both the account and endpoint reads
// rather than claiming anything, and for a spent trial, which is connected but out of allowance.
import "@intentic/testing/dom";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";
import { RouterLinkStub } from "../../../testing/routerLinkStub";
import * as providerCatalogOriginal from "../../../models/providers/providerCatalog";
import * as providerAccountsOriginal from "../../../models/providers/providerAccounts";
import * as aiReachOriginal from "../../../models/providers/aiReach";

const connected = ref(false);
const accountsLoaded = ref(true);
const endpointsLoaded = ref(true);
const nativeConnectFlow = ref<{ provider: AgentProvider; url: string; code: string } | undefined>(undefined);
const translatorConnectFlow = ref<undefined>(undefined);
// The store's own reading of the two, as useChat-connect derives it.
const liveSignIn = computed(() =>
    nativeConnectFlow.value === undefined ? undefined : { kind: `native` as const, provider: nativeConnectFlow.value.provider },
);
const signInFailure = ref<{ provider: AgentProvider; message: string } | undefined>(undefined);
const cancelSignIn = jest.fn(() => {
    nativeConnectFlow.value = undefined;
});
// Connecting is a maintainer's; most of these tests read as one.
const canShip = ref(true);
jest.mock(`../../../client/sandbox/useRole`, () => ({ useRole: () => ({ canShip }) }));
const dismissSignInFailure = jest.fn(() => {
    signInFailure.value = undefined;
});
const provider = ref<AgentProvider>(`claude`);
const selectModel = jest.fn();
const startConnect = jest.fn();
const connectTranslator = jest.fn();

// The two reads `accessKnown` needs, mocked at their source so `accessKnown` itself runs unmocked.
jest.mock(`../../../models/providers/providerAccounts`, () => ({
    ...providerAccountsOriginal,
    accountsLoaded,
}));
jest.mock(`../../../models/providers/providerCatalog`, () => ({
    ...providerCatalogOriginal,
    endpointsLoaded,
}));

// The pane's view the real panel injects from ChatPane; mounted bare here and handed over directly.
jest.mock(`../../../models/conversations/run/useChat`, () => ({
    useChat: () => ({
        nativeConnectFlow,
        translatorConnectFlow,
        liveSignIn,
        cancelSignIn,
        signInFailure,
        dismissSignInFailure,
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
jest.mock(`../../../models/conversations/panel/useChat-view`, () => ({
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
// The providers the reader may not run (Access ▸ People, aiReach.ts), named outright rather than built from a roster.
const withheld = ref<readonly string[]>([]);
jest.mock(`../../../models/providers/aiReach`, () => ({
    ...aiReachOriginal,
    providerWithheld: (target: string) => withheld.value.includes(target),
}));
jest.mock(`vue-router`, () => ({
    ...vueRouterOriginal,
    useRouter: () => ({ push: jest.fn() }) as never,
    RouterLink: RouterLinkStub as never,
}));

const { modelRequest, settleModelPick } = await import("../../../models/conversations/accounts/hostModelPicker");
const { endpointProviders, trialStatus } = await import("../../../models/providers/providerCatalog");
// The stored pick itself, unmocked: whether a vendor may be named at all is exactly "did the owner name one".
const { turnDefaults } = await import("../../../models/conversations/run/turnDefaults");
const { default: ChatAccountPanel } = await import("./ChatAccountPanel.vue");
const { ACCOUNT_NUDGE } = await import("./accountNudge");

// The pane's count of presses on a composer with nothing to send with (accountNudge.ts).
const nudges = ref(0);
let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatAccountPanel) });
    app.provide(ACCOUNT_NUDGE, nudges);
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
    withheld.value = [];
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    provider.value = `claude`;
    // A sandbox nobody has chosen a model in, which is what a first run is.
    turnDefaults.provider.value = undefined;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    endpointProviders.value = [];
    nudges.value = 0;
    nativeConnectFlow.value = undefined;
    signInFailure.value = undefined;
    canShip.value = true;
    cancelSignIn.mockClear();
    dismissSignInFailure.mockClear();
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

it(`names what this chat is pointed at, and offers connecting exactly that`, () => {
    turnDefaults.provider.value = `claude`;
    const element = mount();

    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
    expect(element.textContent).not.toContain(`Try free with Google`);
    expect(buttonNamed(element, `Continue with Google`)).toBeUndefined();
    // The one press: Claude's own tile, opened rather than signed in. No sign-in starts here — a handshake is a trip to
    // another tab and back, which eighty pixels over a composer is the wrong host for.
    expect(linkNamed(element, `Connect Claude`)?.getAttribute(`href`)).toBe(`/sandbox/models?open=claude`);
    // Nothing else can run, so there is nothing to choose: no second door to a list of locked rows.
    expect(buttonNamed(element, `Choose`)).toBeUndefined();
});

// The reported bug: a brand-new sandbox told its owner that Claude was missing, and offered to connect a Claude
// subscription — over a chat sitting on the app's own floor provider, which nobody chose. The app is not any one
// vendor's, so with nothing chosen there is no vendor to name and no sign-in to push.
// And the reported one after it: four doors ("Choose a model" twice, "Connect a model", Send) to one list whose every
// row was locked. With nothing connected, connecting one is the one press.
it(`names no vendor where nobody has chosen one, and offers connecting a model as the one press`, () => {
    const element = mount();

    expect(element.textContent).toContain(`No model is connected in this sandbox yet.`);
    expect(element.textContent).not.toContain(`Claude`);
    expect(buttonNamed(element, `Connect Claude subscription`)).toBeUndefined();
    const connect = linkNamed(element, `Connect a model`);
    expect(connect?.getAttribute(`href`)).toBe(`/sandbox/models`);
    // Drawn as the card's press, not as link text nobody reads as one.
    expect(connect?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(buttonNamed(element, `Choose`)).toBeUndefined();
    expect(element.querySelectorAll(`a, button`)).toHaveLength(1);
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

// Where something else in the sandbox runs (a started chat whose account went away), another model is the way on, and
// connecting this one follows quietly; the list opens anchored to the press and its answer applies to this pane.
it(`leads with another model where something else here can run, and opens the list anchored to its own button`, async () => {
    endpointProviders.value = [{ id: `openrouter`, label: `OpenRouter`, kind: `endpoint` }];
    const element = mount();

    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
    expect(linkNamed(element, `Connect Claude`)?.getAttribute(`href`)).toBe(`/sandbox/models?open=claude`);
    const press = buttonNamed(element, `Choose another model`)!;
    press.click();
    await nextTick();

    expect(modelRequest.value?.anchor).toBe(press);
    expect(modelRequest.value?.provider).toBe(`claude`);

    // A picked row applies to this pane's own conversation.
    settleModelPick({ provider: `gemini`, model: `gemini-3-pro`, label: `Gemini 3 Pro` });
    await nextTick();
    expect(selectModel).toHaveBeenCalledWith({ provider: `gemini`, value: `gemini-3-pro` });
});

// Enter on a composer with nothing to send with sends nothing and opens nothing: it shakes this press, the one way on,
// again on every press.
it(`shakes its one press each time the composer is pressed with nothing to send with`, async () => {
    const element = mount();
    expect(linkNamed(element, `Connect a model`)?.className).not.toContain(`ui-shake`);

    nudges.value += 1;
    await nextTick();
    const shaken = linkNamed(element, `Connect a model`);
    expect(shaken?.className).toContain(`ui-shake`);

    nudges.value += 1;
    await nextTick();
    // Drawn again, so the animation runs again rather than sitting on its finished frame.
    expect(linkNamed(element, `Connect a model`)).not.toBe(shaken);
    expect(linkNamed(element, `Connect a model`)?.className).toContain(`ui-shake`);
});

// A sign-in is never started from here, whichever mechanism the chat's provider uses: this strip's whole job is to
// name the standing and point at the one place that holds a handshake.
it(`starts no handshake of its own, for either credential mechanism`, () => {
    for (const target of [`claude`, `gemini`] as const) {
        provider.value = target;
        turnDefaults.provider.value = target;
        const element = mount();
        expect(linkNamed(element, `Connect`)?.getAttribute(`href`)).toBe(`/sandbox/models?open=${target}`);
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
    expect(element.textContent).toContain(`Your Claude Code sign-in isn't finished yet.`);
    expect(element.textContent).not.toContain(`isn't connected`);
    expect(linkNamed(element, `Finish sign-in`)?.getAttribute(`href`)).toBe(`/sandbox/models`);

    // Abandoned elsewhere, the line comes back rather than leaving a dead pointer.
    nativeConnectFlow.value = undefined;
    await nextTick();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
});

// The reported gap: a reader who changed their mind mid-sign-in had to go to /connect only to press Cancel there.
it(`puts a sign-in down from the strip itself`, async () => {
    nativeConnectFlow.value = { provider: `cursor`, url: `https://cursor.com/login`, code: `ABCD` };
    const element = mount();

    buttonNamed(element, `Cancel`)!.click();
    await nextTick();

    expect(cancelSignIn).toHaveBeenCalledTimes(1);
    expect(element.textContent).not.toContain(`sign-in isn't finished`);
});

// A sign-in that expired or was refused used to vanish from the strip with nothing said; now it says which provider,
// why, and offers the way back to start it again.
it(`says a sign-in ended without connecting, until tried again or dismissed`, async () => {
    signInFailure.value = { provider: `cursor`, message: `The Cursor sign-in expired: start the connection again.` };
    const element = mount();

    expect(element.textContent).toContain(`Cursor didn't connect.`);
    expect(element.textContent).toContain(`The Cursor sign-in expired`);
    // Back to the connect view, naming the provider, which is what starts its sign-in there (linkArrival).
    expect(linkNamed(element, `Try again`)?.getAttribute(`href`)).toBe(`/sandbox/models?provider=cursor`);

    buttonNamed(element, `Dismiss`)!.click();
    await nextTick();
    expect(dismissSignInFailure).toHaveBeenCalledTimes(1);
    expect(element.textContent).not.toContain(`didn't connect`);
});

// The daemon refuses anyone else's sign-in and the hub withholds the section that holds it, so a reader below maintainer
// is told who can connect one rather than handed a door that opens on nothing.
it(`names who can connect a model, for a reader who cannot`, () => {
    canShip.value = false;
    const element = mount();

    expect(element.textContent).toContain(`No model is connected in this sandbox yet.`);
    expect(linkNamed(element, `Connect a model`)).toBeUndefined();
    expect(element.textContent).toContain(`A maintainer of this sandbox can connect one.`);
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
    // An endpoint has no sign-in to name, so the way on is the page's, on the reader's choice.
    expect(linkNamed(element, `Connect Free trial`)).toBeUndefined();
    expect(linkNamed(element, `Connect a model`)?.getAttribute(`href`)).toBe(`/sandbox/models`);
});

it(`goes on its own the moment this chat can send`, async () => {
    const element = mount();
    expect(element.textContent).toContain(`No model is connected in this sandbox yet.`);

    connected.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);
});

// A chat on a model the reader may not run (somebody else started it there, or the owner narrowed their AI accounts
// since) used to look sendable and be refused at Send. Connected, so "isn't connected" and Connect would both be false:
// the strip names it as not shared, beside another model of theirs, or with none, asking the owner.
it(`says a model is not shared with the reader, and leads with another of theirs, never Connect`, () => {
    withheld.value = [`claude`];
    endpointProviders.value = [{ id: `openrouter`, label: `OpenRouter`, kind: `endpoint` }];
    const element = mount();

    expect(element.textContent).toContain(`Claude Code isn't shared with you in this sandbox.`);
    expect(element.textContent).not.toContain(`isn't connected`);
    expect(buttonNamed(element, `Choose another model`)).toBeInstanceOf(HTMLButtonElement);
    expect(linkNamed(element, `Connect`)).toBeUndefined();
});

it(`offers asking the owner where nothing else is the reader's to run`, () => {
    withheld.value = [`claude`, `openrouter`];
    endpointProviders.value = [{ id: `openrouter`, label: `OpenRouter`, kind: `endpoint` }];
    turnDefaults.provider.value = `claude`;
    const element = mount();

    expect(element.textContent).toContain(`Claude Code isn't shared with you in this sandbox.`);
    expect(buttonNamed(element, `Ask for access`)).toBeInstanceOf(HTMLButtonElement);
    expect(buttonNamed(element, `Choose`)).toBeUndefined();
    expect(linkNamed(element, `Connect`)).toBeUndefined();
});

// A first chat sits on the app's own floor, which nobody chose: with nothing of theirs to run, no vendor is named.
it(`names no vendor on the app's floor where nothing is the reader's, and still offers asking`, () => {
    withheld.value = [`claude`];
    const element = mount();

    expect(element.textContent).toContain(`None of this sandbox's AI accounts is shared with you.`);
    expect(element.textContent).not.toContain(`Claude`);
    expect(buttonNamed(element, `Ask for access`)).toBeInstanceOf(HTMLButtonElement);
});
