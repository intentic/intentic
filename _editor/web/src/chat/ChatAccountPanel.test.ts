// @vitest-environment jsdom
//
/* THE STRIP ABOVE THE COMPOSER WHEN THIS CHAT HAS NOTHING TO SEND WITH, and the three states that decide what
 * it says. Each has a way of going wrong that a user notices immediately.
 *
 * It used to be a PITCH: a card headlined "Try free with Google" with the four subscriptions under it, shown
 * here and, at twice the size, in the middle of the empty agents board. So a brand-new user's first screen was
 * a sign-in wall, right after they had signed in with Google. That is what these tests hold shut: the strip
 * names what this chat is pointed at and opens the model list, and it pitches nothing.
 *
 * And it does not speak too early. "You have nothing connected" is TWO reads, the accounts and the endpoints,
 * and the endpoints land later. Voting on the accounts alone is what painted a wall over a free trial that was
 * already on its way.
 *
 * Nor does it speak for a state that is not its own: a spent free trial cannot send either, but it IS connected,
 * and this strip saying otherwise put two contradicting sentences on screen at once. */
import { type AgentProvider, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const connected = ref(false);
const accountsLoaded = ref(true);
const endpointsLoaded = ref(true);
const nativeConnectFlow = ref<{ provider: AgentProvider; url: string; code: string } | undefined>(undefined);
const translatorConnectFlow = ref<undefined>(undefined);
const provider = ref<AgentProvider>(`claude`);
const selectModel = vi.fn();
const startConnect = vi.fn();
const connectTranslator = vi.fn();

// The two reads the panel's "is this settled" question is made of, mocked where they live so `accessKnown`
// itself is the real computed under test.
vi.mock(`../composables/chat/providerAccounts`, async (importOriginal) => ({
    ...(await importOriginal<object>()),
    accountsLoaded,
}));
vi.mock(`../composables/chat/providerCatalog`, async (importOriginal) => ({
    ...(await importOriginal<object>()),
    endpointsLoaded,
}));

// The pane's view, which the real panel injects from its ChatPane: mounted bare here, so it is handed over.
// The connect surface underneath it reads the live handshake off the same store, so the flows come along.
vi.mock(`../composables/chat/useChat`, () => ({
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
        completeConnect: () => {},
        completeTranslator: () => {},
    }),
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
    RouterLink: (await import(`../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { modelRequest, settleModelPick } = await import("../composables/chat/hostModelPicker");
const { trialStatus } = await import("../composables/chat/providerCatalog");
const { default: ChatAccountPanel } = await import("./ChatAccountPanel.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatAccountPanel) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: { type: String, default: `` }, spin: Boolean },
            setup: (props) => () => h(`i`, { "data-icon": props.name }),
        }),
    );
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
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
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
    const element = mount();

    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
    // The pitch that used to live here, in the words a new user actually read.
    expect(element.textContent).not.toContain(`Try free with Google`);
    expect(buttonNamed(element, `Continue with Google`)).toBeUndefined();
    // What is offered instead: the list, plus this provider's own sign-in for whoever pointed the chat here.
    expect(buttonNamed(element, `Choose a model`)).toBeDefined();
    expect(buttonNamed(element, `Connect Claude subscription`)).toBeDefined();
});

/* THE GAP THAT PUT A WALL IN FRONT OF EVERY NEW USER. The account reads come back off the daemon in one hop;
 * the endpoints take a capability read, a catalog fetch each and a round-trip to the platform. In between, a
 * fresh sandbox looks exactly like a sandbox with nothing in it, and the free trial is one of those endpoints. */
it(`says nothing about connections until BOTH halves of the picture have landed`, async () => {
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    const element = mount();

    expect(element.textContent).toContain(`Checking your AI accounts…`);
    expect(element.textContent).not.toContain(`isn't connected`);

    // The accounts land first, as they do in the app. This is the moment the old gate spoke; this one waits.
    accountsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toContain(`Checking your AI accounts…`);
    expect(element.textContent).not.toContain(`isn't connected`);

    endpointsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
});

// The list is where every free option lives, so reaching it is this strip's main job. It opens the SHELL's
// picker, anchored to its own button: the composer is not rendered while this strip is up, so the model pill a
// composer-side picker would hang off does not exist.
it(`opens the model list, anchored to its own button`, async () => {
    const element = mount();

    const press = buttonNamed(element, `Choose a model`)!;
    press.click();
    await nextTick();

    expect(modelRequest.value?.anchor).toBe(press);
    expect(modelRequest.value?.provider).toBe(`claude`);

    // A picked row is applied to THIS pane's conversation, so choosing here is choosing from the composer.
    settleModelPick({ provider: `gemini`, model: `gemini-3-pro`, label: `Gemini 3 Pro` });
    await nextTick();
    expect(selectModel).toHaveBeenCalledWith({ provider: `gemini`, value: `gemini-3-pro` });
});

// Picking a locked model points the chat at it, so the sign-in has to be finishable from the chat it was
// started for. It takes the whole strip: a line reading "not connected" over a live sign-in argues with itself.
it(`runs the sign-in in place, and puts the line back when it is abandoned`, async () => {
    const element = mount();

    buttonNamed(element, `Connect Claude subscription`)!.click();
    expect(startConnect).toHaveBeenCalled();

    nativeConnectFlow.value = { provider: `claude`, url: `https://claude.ai/oauth`, code: `` };
    await nextTick();
    expect(element.textContent).toContain(`Connecting Claude`);
    expect(element.textContent).not.toContain(`isn't connected`);

    buttonNamed(element, `Cancel`)!.click();
    await nextTick();
    expect(element.textContent).toContain(`Claude isn't connected in this sandbox`);
});

// Google authenticates through the bundled translator rather than a daemon-stored account: the same split the
// daemon makes, so the one press starts the right handshake.
it(`starts the routed handshake for a provider that authenticates through the translator`, () => {
    provider.value = `gemini`;
    const element = mount();

    expect(element.textContent).toContain(`Google isn't connected in this sandbox`);
    buttonNamed(element, `Connect Google sign-in`)!.click();
    expect(connectTranslator).toHaveBeenCalledWith(`gemini`);
    expect(startConnect).not.toHaveBeenCalled();
});

/* TWO STRIPS, TWO CONTRADICTING SENTENCES, one screen. A spent trial cannot send, so this gate went up saying
 * "Free trial isn't connected in this sandbox" directly above the trial strip's "Free trial used up for today".
 * One of those is false and the other is the answer, and a user reading both learns only that the product does
 * not know which. The gate reports MISSING CONNECTIONS; a metered provider that ran out is not one, so it stands
 * down and the strip that owns the state says it once. */
it(`stands down for a spent trial instead of calling it unconnected`, () => {
    provider.value = TRIAL_PROVIDER;
    trialStatus.value = { available: true, allowance: 20, used: 20, remaining: 0, health: `healthy` };

    expect(mount().textContent).toBe(``);
});

// The trial the platform has NOT confirmed is a different fact and still this gate's to report: nothing is
// serving this chat, and standing down there would leave the pane silent about a chat that cannot send at all.
it(`still speaks when the trial is absent rather than spent`, () => {
    provider.value = TRIAL_PROVIDER;

    expect(mount().textContent).toContain(`isn't connected in this sandbox`);
});

it(`goes on its own the moment this chat can send`, async () => {
    const element = mount();
    expect(element.textContent).toContain(`isn't connected`);

    connected.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);
});
