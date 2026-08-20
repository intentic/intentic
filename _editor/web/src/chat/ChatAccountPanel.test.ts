// @vitest-environment jsdom
//
// WHEN THE GATE ABOVE THE COMPOSER IS THERE AT ALL — what the card SAYS is ConnectOffer's own test. Three
// states decide it and each one has a way of going wrong that a user notices immediately: claiming "nothing is
// connected" before the daemon has answered puts a pitch in front of somebody with a perfectly good
// subscription, and NOT standing down for the empty board puts the same offer on screen twice, a hand's width
// apart, where it reads as two different offers.
import type { AgentProvider } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The kit's barrel reaches for matchMedia at import time (its device tracker), which jsdom does not have.
// matches:false keeps the device DESKTOP — the one form factor where the board and this gate share a screen.

const connected = ref(false);
const accountsLoaded = ref(true);
// The panel's three homes collapse to one question here: is the chat on a WIDE surface (its own pop-out window
// or the /chat area filling this one), where there is no board beside it to be making the offer already?
const chatWide = ref(false);
const nativeConnectFlow = ref<undefined>(undefined);
const translatorConnectFlow = ref<undefined>(undefined);

// The pane's view, which the real panel injects from its ChatPane — mounted bare here, so it is handed over.
// The connect surface underneath it reads the live handshake off the same store, so the flows come along.
vi.mock(`../composables/chat/useChat`, () => ({
    useChat: () => ({
        accountsLoaded,
        nativeConnectFlow,
        translatorConnectFlow,
        startConnect: () => {},
        connectTranslator: () => {},
        setManagedProvider: () => {},
        cancelConnect: () => {},
        cancelTranslatorConnect: () => {},
        accountBusy: ref(undefined),
        translatorKey: (target: string) => `translator:${target}`,
        connectLabel: ref(``),
        completeConnect: () => {},
        completeTranslator: () => {},
    }),
    usePaneView: () => ({
        connected,
        provider: ref<AgentProvider>(`claude`),
        harness: ref(`claude-code`),
        selectProvider: () => {},
    }),
}));
vi.mock(`../composables/chat/chatSurface`, () => ({ chatWide }));
// The card's way out to the accounts page is a link, so the mock carries a router-free stand-in for it.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { offerOnBoard } = await import("../composables/chat/connectOffer");
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

beforeEach(() => {
    connected.value = false;
    accountsLoaded.value = true;
    chatWide.value = false;
    offerOnBoard.value = false;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the way in when this chat has nothing to send with`, () => {
    const element = mount();

    expect(element.textContent).toContain(`Try free with Google`);
});

it(`says nothing about connections until the daemon has answered`, async () => {
    accountsLoaded.value = false;
    const element = mount();

    // One quiet line, no pitch and no button to press on a question that isn't settled.
    expect(element.textContent).toContain(`Checking your AI accounts…`);
    expect(element.textContent).not.toContain(`Try free with Google`);

    accountsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toContain(`Try free with Google`);
});

it(`stands down while the empty board is making the same offer, without going silent`, async () => {
    offerOnBoard.value = true;
    const element = mount();

    // The board owns the whole empty screen this gate would sit against, so it takes the ARGUMENT — the pitch,
    // the button, and the wait in front of them, or the two columns would spin at each other.
    expect(element.textContent).not.toContain(`Try free with Google`);
    // But standing down is not the same as saying nothing, and it used to be: the composer below this is behind
    // the same `connected`, so an empty line here left the bottom half of a brand-new sandbox's chat as blank
    // space with no word anywhere in the column about what it was waiting for.
    expect(element.textContent).toContain(`Waiting on an AI account`);

    accountsLoaded.value = false;
    await nextTick();
    // "Nothing is connected" is a claim, and an unanswered one is not this column's to make either way.
    expect(element.textContent).toBe(``);

    offerOnBoard.value = false;
    accountsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toContain(`Try free with Google`);
});

it(`keeps its own offer on a wide surface, where there is no board beside it`, async () => {
    offerOnBoard.value = true;
    // Either of the panel's two wide homes: its own pop-out window, or the /chat area filling this one. Both
    // leave the board with nothing on screen to be duplicating, so the gate has to carry the offer itself.
    chatWide.value = true;
    const element = mount();

    expect(element.textContent).toContain(`Try free with Google`);
    // Docked again, and the board it is now beside is the one making the offer.
    chatWide.value = false;
    await nextTick();
    expect(element.textContent).not.toContain(`Try free with Google`);
    expect(element.textContent).toContain(`Waiting on an AI account`);
});

it(`goes on its own the moment this chat can send`, async () => {
    const element = mount();
    expect(element.textContent).toContain(`Try free with Google`);

    connected.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);
});
