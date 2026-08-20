// @vitest-environment jsdom
//
// jsdom because everything this pins is what the connect offer SAYS and what one press on it does. The card is
// the first thing a user with nothing connected meets — above the composer and, on a fresh workspace, in the
// middle of the empty board — it lives in a pane narrow enough that one long label wraps the row, and its
// second half is a row of subscription chips. So "the chip claims I'm connected and pressing it changes
// nothing", "the same glyph is drawn twice" and "it takes two presses to connect" are the failures worth a
// test, and all three are DOM and text rather than anything a composable would answer for.
//
// AND WHERE A PRESS LEAVES YOU, which is the newest of them. Connecting used to push the router at the Agent
// settings tab and abandon the user there; it now unfolds in this card, so "pressing connect navigated away"
// is a regression with a test rather than a thing somebody notices on their first ever screen.
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";

// The kit's barrel reaches for matchMedia at import time (its device tracker), which jsdom does not have.

const push = vi.fn();
// "All AI accounts" is a link now, so the mock carries a router-free stand-in that keeps its address.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push }) as never,
    RouterLink: (await import(`../testing/routerLinkStub`)).RouterLinkStub as never,
}));

/* The account store, mocked down to the handshake — because the handshake is now half of what this card DOES.
 * The flows are refs the tests write to, so "a sign-in is running" is a state the card can be put into without
 * a network anywhere near it, and the two starts are spies because which one a provider uses is the daemon's
 * own split (translator subscription vs the provider's own account) and the card mirroring it wrongly is
 * exactly the bug worth catching. */
const nativeConnectFlow = ref<{ provider: AgentProvider; url: string; code: string } | undefined>(undefined);
const translatorConnectFlow = ref<{ provider: AgentProvider; url: string; code: string; state: string; flow: `device` | `redirect` } | undefined>(
    undefined,
);
const startConnect = vi.fn();
const connectTranslator = vi.fn();
const setManagedProvider = vi.fn();
const cancelConnect = vi.fn(() => (nativeConnectFlow.value = undefined));
const cancelTranslatorConnect = vi.fn(() => (translatorConnectFlow.value = undefined));
const accountBusy = ref<string | undefined>(undefined);

vi.mock(`../composables/chat/useChat`, () => ({
    useChat: () => ({
        nativeConnectFlow,
        translatorConnectFlow,
        startConnect,
        connectTranslator,
        setManagedProvider,
        cancelConnect,
        cancelTranslatorConnect,
        accountBusy,
        translatorKey: (target: string, name?: string) => `translator:${target}${name === undefined ? `` : `:${name}`}`,
        connectLabel: ref(``),
        completeConnect: vi.fn(),
        completeTranslator: vi.fn(),
    }),
}));

const { providerAccounts, translatorAccounts } = await import("../composables/chat/providerAccounts");
const { default: ConnectOffer } = await import("./ConnectOffer.vue");

const provider = ref<AgentProvider>(`claude`);
const harness = ref<AgentHarness>(`claude-code`);
// The conversation the card acts on, handed in the way both real callers hand it in: the pane's own view above
// a composer, the focused chat's on the board. Everything the card DECIDES (is there a free channel left,
// which subscriptions can this chat already send on, what does each one need) is left real — it comes from
// access.ts reading the account refs below, which is the seam a wrong answer would arrive through.
const view = {
    provider: computed<AgentProvider>({ get: () => provider.value, set: (next) => (provider.value = next) }),
    harness: computed<AgentHarness>({ get: () => harness.value, set: (next) => (harness.value = next) }),
    selectProvider: (next: AgentProvider) => (provider.value = next),
};

let app: App | undefined;
const mount = (prominent = false): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ConnectOffer, { view, prominent }) });
    // Registered app-wide by installUi in the real app. Icon prints the name it was handed, because WHICH glyph
    // is drawn — and how many times — is one of the things under test.
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

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll(`button`)];
const chip = (element: HTMLElement, label: string): HTMLButtonElement =>
    buttons(element).find((button) => (button.textContent ?? ``).trim() === label)!;
// The chip's only child element is its connected dot — the label beside it is a bare text node.
const dotted = (element: HTMLElement, label: string): boolean => chip(element, label).querySelector(`span`) !== null;
// The free channel's call to action, whatever it is currently labelled.
const cta = (element: HTMLElement): HTMLButtonElement | undefined =>
    buttons(element).find((button) => (button.textContent ?? ``).includes(`Continue with`));
// The quiet door to the full account page. An ANCHOR, not a button — it is a place, so it carries an address
// that can be hovered, copied and Ctrl/⌘-clicked like any other link in the app.
const accountsDoor = (element: HTMLElement): HTMLAnchorElement | null => element.querySelector(`a`);

beforeEach(() => {
    provider.value = `claude`;
    harness.value = `claude-code`;
    // Nothing connected anywhere, so the free channel is still on offer and the card leads with it.
    providerAccounts.value = { ...providerAccounts.value, claude: [], grok: [] };
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    nativeConnectFlow.value = undefined;
    translatorConnectFlow.value = undefined;
    accountBusy.value = undefined;
    push.mockClear();
    startConnect.mockClear();
    connectTranslator.mockClear();
    setManagedProvider.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`marks the subscriptions you already hold, and spends a press on them re-pointing the chat`, async () => {
    // A chat sitting on ChatGPT, which this user does not have — while their Claude subscription is right there.
    provider.value = `codex`;
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    const element = mount();

    expect(dotted(element, `Claude`)).toBe(true);
    expect(dotted(element, `Kimi Code`)).toBe(false);

    chip(element, `Claude`).click();
    await nextTick();
    // The fastest path there is: the chat is re-pointed and the gate goes on its own, so nothing is started.
    expect(provider.value).toBe(`claude`);
    expect(startConnect).not.toHaveBeenCalled();
    expect(connectTranslator).not.toHaveBeenCalled();
});

it(`takes one press to connect a subscription you don't hold, and goes nowhere to do it`, async () => {
    const element = mount();

    expect(dotted(element, `ChatGPT`)).toBe(false);
    chip(element, `ChatGPT`).click();
    await nextTick();

    // ChatGPT authenticates through the bundled translator, so that is the half of the daemon's split it takes.
    expect(connectTranslator).toHaveBeenCalledWith(`codex`);
    expect(startConnect).not.toHaveBeenCalled();
    // THE WHOLE POINT: the handshake happens in this card. A router push here is the settings-tab detour the
    // user used to be thrown into, and then stranded on.
    expect(push).not.toHaveBeenCalled();
    // Pointed at what is being connected — both the chat, and the account card where the row will appear.
    expect(provider.value).toBe(`codex`);
    expect(setManagedProvider).toHaveBeenCalledWith(`codex`);
});

it(`asks what THIS chat can send on, which for Grok is not the same as what you own`, async () => {
    // A SuperGrok subscription runs Grok under the Claude Code harness and cannot run it natively.
    translatorAccounts.value = { ...translatorAccounts.value, grok: [{ id: `g1` }] as never };
    const element = mount();

    expect(dotted(element, `Grok`)).toBe(true);
    chip(element, `Grok`).click();
    await nextTick();
    expect(startConnect).not.toHaveBeenCalled();

    harness.value = `native`;
    await nextTick();
    // Same subscription, same chip — and now pressing it has something to do, because selecting it would leave
    // this gate exactly where it is. Native Grok takes its own xAI account, not the translator's subscription.
    expect(dotted(element, `Grok`)).toBe(false);
    chip(element, `Grok`).click();
    await nextTick();
    expect(startConnect).toHaveBeenCalled();
    expect(connectTranslator).not.toHaveBeenCalled();
});

it(`says what a press will do without printing it into the row`, () => {
    const element = mount();

    // The provider is the chip's whole visible label; what pressing it does is carried where it costs no width.
    expect(chip(element, `Claude`).getAttribute(`aria-label`)).toBe(`Claude — Connect Claude subscription`);
    expect(element.textContent).not.toContain(`Connect Claude subscription`);
    // Grok is the one provider whose requirement is not its own name, so the sentence is derived, not pasted.
    expect(chip(element, `Grok`).getAttribute(`aria-label`)).toBe(`Grok — Connect SuperGrok subscription`);
});

it(`puts the free channel's own mark on the button that leaves for it`, () => {
    const element = mount();

    // It used to be a sparkle — decoration, on the one button in the app whose whole job is to say WHOSE
    // sign-in you are about to follow. The provider's mark answers that; a sparkle answers nothing, and there
    // used to be a second one floating above the headline saying it twice.
    expect(cta(element)?.querySelector(`svg`)).not.toBeNull();
    expect(element.querySelectorAll(`[data-icon="sparkles"]`)).toHaveLength(0);
    // The free channel's CTA and the four chips. Nothing else — the "Connect <the chip you just pressed>"
    // button that used to sit under the row is what the chips now do, and the door to the account page is a
    // link rather than a sixth button.
    expect(buttons(element)).toHaveLength(5);
    expect(accountsDoor(element)?.getAttribute(`href`)).toBe(`/sandbox/agent`);
    expect(cta(element)?.textContent).toContain(`Continue with Google`);
});

it(`keeps the row working once the free channel is spent`, async () => {
    // A connected Google sign-in leaves no free offer, so the headline and its CTA go — and the chips are then
    // the card's only action rather than a second row under a louder one.
    translatorAccounts.value = { ...translatorAccounts.value, gemini: [{ id: `g1` }] as never };
    const element = mount();

    expect(element.textContent).not.toContain(`Continue with`);
    // Google joins the row it was promoted out of, connected, and it is the fifth chip — those five alone,
    // with the headline's CTA gone and the door to the account page riding as a link beside them.
    expect(buttons(element)).toHaveLength(5);
    expect(accountsDoor(element)?.getAttribute(`href`)).toBe(`/sandbox/agent`);
    expect(dotted(element, `Google`)).toBe(true);

    chip(element, `Kimi Code`).click();
    await nextTick();
    expect(connectTranslator).toHaveBeenCalledWith(`kimi`);
    expect(push).not.toHaveBeenCalled();
});

it(`becomes the sign-in once one is running, and stops arguing for it`, async () => {
    const element = mount(true);
    expect(cta(element)).toBeDefined();

    // What pressing the button leads to: the daemon answers with the authorize URL and the card turns into the
    // panel that finishes the handshake.
    translatorConnectFlow.value = { provider: `gemini`, url: `https://accounts.google.com/o/oauth2/auth`, code: ``, state: `s1`, flow: `redirect` };
    await nextTick();

    // A card still pitching "try free with Google" over a live Google handshake argues with its own state.
    expect(element.textContent).not.toContain(`Continue with Google`);
    expect(element.textContent).toContain(`Connecting Google`);
    expect(element.textContent).toContain(`Open Google`);
    // THE STEP PEOPLE ABANDON ON, said before they meet it rather than after.
    expect(element.textContent).toContain(`won't load`);
    expect(element.textContent).toContain(`This site can't be reached`);

    // And it can be put back — the one control the sign-in state needs of its own.
    buttons(element)
        .find((button) => (button.textContent ?? ``).trim() === `Cancel`)!
        .click();
    await nextTick();
    expect(cancelTranslatorConnect).toHaveBeenCalled();
    expect(cta(element)).toBeDefined();
});
