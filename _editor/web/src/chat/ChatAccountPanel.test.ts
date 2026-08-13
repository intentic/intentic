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

const connected = ref(false);
const accountsLoaded = ref(true);
const poppedOut = ref(false);

// The pane's view, which the real panel injects from its ChatPane — mounted bare here, so it is handed over.
vi.mock(`../composables/chat/useChat`, () => ({
    useChat: () => ({ accountsLoaded }),
    usePaneView: () => ({
        connected,
        provider: ref<AgentProvider>(`claude`),
        harness: ref(`claude-code`),
        selectProvider: () => {},
    }),
}));
vi.mock(`../composables/chat/useChatPopout`, () => ({ useChatPopout: () => ({ poppedOut }) }));
vi.mock(`vue-router`, () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
    poppedOut.value = false;
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

it(`stands down while the empty board is making the same offer`, async () => {
    offerOnBoard.value = true;
    const element = mount();

    // The board owns the whole empty screen this gate would sit against, so it takes the argument — and the
    // wait in front of it, or the two columns would spin at each other.
    expect(element.textContent).toBe(``);
    accountsLoaded.value = false;
    await nextTick();
    expect(element.textContent).toBe(``);

    offerOnBoard.value = false;
    accountsLoaded.value = true;
    await nextTick();
    expect(element.textContent).toContain(`Try free with Google`);
});

it(`keeps its own offer in a popped-out window, where there is no board beside it`, async () => {
    offerOnBoard.value = true;
    poppedOut.value = true;
    const element = mount();

    expect(element.textContent).toContain(`Try free with Google`);
    // Docked again, and the board it is now beside is the one making the offer.
    poppedOut.value = false;
    await nextTick();
    expect(element.textContent).toBe(``);
});

it(`goes on its own the moment this chat can send`, async () => {
    const element = mount();
    expect(element.textContent).toContain(`Try free with Google`);

    connected.value = true;
    await nextTick();
    expect(element.textContent).toBe(``);
});
