// @vitest-environment jsdom
//
// jsdom because everything this pins is what the connect gate SAYS and what one press on it does. The panel is
// the first thing a user with nothing connected meets, it lives in a pane narrow enough that one long label
// wraps the row, and its second half is a row of subscription chips — so "the chip claims I'm connected and
// pressing it changes nothing", "the same glyph is drawn twice" and "it takes two presses to connect" are the
// failures worth a test, and all three are DOM and text rather than anything a composable would answer for.
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The kit's barrel reaches for matchMedia at import time (its device tracker), which jsdom does not have.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

const provider = ref<AgentProvider>(`claude`);
const harness = ref<AgentHarness>(`claude-code`);
const connected = ref(false);
const accountsLoaded = ref(true);

// The pane's view, which the real panel injects from its ChatPane — mounted bare here, so it is handed over.
// Everything the gate DECIDES (is there a free channel left, which subscriptions can this chat already send on,
// what does each one need) is left real: it comes from access.ts reading the account refs below, which is the
// seam a wrong answer would arrive through.
vi.mock(`../composables/chat/useChat`, () => ({
    useChat: () => ({ accountsLoaded }),
    usePaneView: () => ({
        connected,
        provider,
        harness,
        selectProvider: (next: AgentProvider) => {
            provider.value = next;
        },
    }),
}));

const push = vi.fn();
vi.mock(`vue-router`, () => ({ useRouter: () => ({ push }) }));

const { providerAccounts, translatorAccounts } = await import("../composables/chat/providerAccounts");
const { default: ChatAccountPanel } = await import("./ChatAccountPanel.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatAccountPanel) });
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
const glyphs = (element: HTMLElement, name: string): Element[] => [...element.querySelectorAll(`[data-icon="${name}"]`)];
const chip = (element: HTMLElement, label: string): HTMLButtonElement =>
    buttons(element).find((button) => (button.textContent ?? ``).trim() === label)!;
// The chip's only child element is its connected dot — the label beside it is a bare text node.
const dotted = (element: HTMLElement, label: string): boolean => chip(element, label).querySelector(`span`) !== null;

beforeEach(() => {
    provider.value = `claude`;
    harness.value = `claude-code`;
    connected.value = false;
    accountsLoaded.value = true;
    // Nothing connected anywhere, so the free channel is still on offer and the panel leads with it.
    providerAccounts.value = { ...providerAccounts.value, claude: [], grok: [] };
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    push.mockClear();
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
    // The fastest path there is: the chat is re-pointed and the gate goes on its own, so nothing navigates.
    expect(provider.value).toBe(`claude`);
    expect(push).not.toHaveBeenCalled();
});

it(`takes one press to connect a subscription you don't hold`, async () => {
    const element = mount();

    expect(dotted(element, `ChatGPT`)).toBe(false);
    chip(element, `ChatGPT`).click();
    await nextTick();

    expect(push).toHaveBeenCalledWith({ path: `/sandbox/agent`, query: { connect: `codex` } });
    // Pointed at what was just connected, so coming back lands on it rather than on what the gate opened with.
    expect(provider.value).toBe(`codex`);
});

it(`asks what THIS chat can send on, which for Grok is not the same as what you own`, async () => {
    // A SuperGrok subscription runs Grok under the Claude Code harness and cannot run it natively.
    translatorAccounts.value = { ...translatorAccounts.value, grok: [{ id: `g1` }] as never };
    const element = mount();

    expect(dotted(element, `Grok`)).toBe(true);
    chip(element, `Grok`).click();
    await nextTick();
    expect(push).not.toHaveBeenCalled();

    harness.value = `native`;
    await nextTick();
    // Same subscription, same chip — and now pressing it has somewhere to go, because selecting it would leave
    // this gate exactly where it is.
    expect(dotted(element, `Grok`)).toBe(false);
    chip(element, `Grok`).click();
    await nextTick();
    expect(push).toHaveBeenCalledWith({ path: `/sandbox/agent`, query: { connect: `grok` } });
});

it(`says what a press will do without printing it into the row`, () => {
    const element = mount();

    // The provider is the chip's whole visible label; what pressing it does is carried where it costs no width.
    expect(chip(element, `Claude`).getAttribute(`aria-label`)).toBe(`Claude — Connect Claude subscription`);
    expect(element.textContent).not.toContain(`Connect Claude subscription`);
    // Grok is the one provider whose requirement is not its own name, so the sentence is derived, not pasted.
    expect(chip(element, `Grok`).getAttribute(`aria-label`)).toBe(`Grok — Connect SuperGrok subscription`);
});

it(`draws the free channel's mark once, and no second button repeating the row`, () => {
    const element = mount();

    // It used to float above the headline AND sit inside the button two lines below it: the same glyph twice,
    // where the second one is the only one doing work.
    expect(glyphs(element, `sparkles`)).toHaveLength(1);
    // The free channel's CTA, and the four chips. Nothing else — the "Connect <the chip you just pressed>"
    // button that used to sit under the row is what the chips now do themselves.
    expect(buttons(element)).toHaveLength(5);
    expect(buttons(element).find((button) => (button.textContent ?? ``).includes(`Continue with Google`))).toBeDefined();
});

it(`keeps the row working once the free channel is spent`, async () => {
    // A connected Google sign-in leaves no free offer, so the headline and its CTA go — and the chips are then
    // the panel's only action rather than a second row under a louder one.
    translatorAccounts.value = { ...translatorAccounts.value, gemini: [{ id: `g1` }] as never };
    const element = mount();

    expect(element.textContent).not.toContain(`Continue with`);
    expect(glyphs(element, `sparkles`)).toHaveLength(0);
    // Google joins the row it was promoted out of, connected, and it is the fifth chip.
    expect(buttons(element)).toHaveLength(5);
    expect(dotted(element, `Google`)).toBe(true);

    chip(element, `Kimi Code`).click();
    await nextTick();
    expect(push).toHaveBeenCalledWith({ path: `/sandbox/agent`, query: { connect: `kimi` } });
});
