// The side panel mounted for real: what it draws for what it holds, and the one invariant the chat depends on, that the
// chat's slot is the same element whatever comes and goes beside it.
import "@intentic/testing/dom";
import { installUi } from "@intentic/ui";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// Whether the chat is in the side panel rather than a window of its own, whether it is folded into its strip, and whether
// the quick bar holds its composer meanwhile: the facts the panel reads from the chat.
const chatInSidePanel = ref(true);
const chatTucked = ref(false);
const chatParked = ref(false);
const setChatTucked = (tucked: boolean): void => {
    chatTucked.value = tucked;
};
jest.mock("../../models/conversations/panel/chatPanelLayout", () => ({ chatInSidePanel, chatParked, chatTucked, setChatTucked, showChat: () => setChatTucked(false) }));
// The strip's own marks read the open chats; with none open it draws none.
jest.mock("../../models/conversations/run/useChat", () => ({ useChat: () => ({ conversations: ref([]) }) }));

const { default: SidePanel } = await import("./SidePanel.vue");
const { closeAllTabs, closeTab, openBeside, setTucked, sideTabId, useSidePanel } = await import("../../workbench/side/sideTabs");
const { registerSideView } = await import("../../workbench/side/sideViews");
const { chatSlot } = await import("../../workbench/window/panelSlots");
const { focusComposer } = await import("../../models/conversations/tabs/useChat-tabs");

const panel = useSidePanel();

// A side view that says what it was handed.
const Body = defineComponent({
    props: { input: { type: Object, required: true } },
    setup: (props) => () => h(`p`, { class: `stub-body` }, `body ${String(props.input[`n`])}`),
});

const lent = ref(false);
const openedHome = jest.fn();
const disposables: { dispose: () => void }[] = [];
beforeAll(() => {
    disposables.push(
        registerSideView({
            id: `stub`,
            owner: `builtin`,
            label: `Stub`,
            describe: (input) => ({ title: `Thing ${String(input[`n`])}`, icon: `file` }),
            home: () => ({ label: `Things`, open: openedHome }),
            component: async () => Body,
            lent: () => lent.value,
        }),
        // One live thing per window, shown under whichever of its tabs is on screen.
        registerSideView({
            id: `live`,
            owner: `builtin`,
            label: `Live`,
            describe: (input) => ({ title: `Live ${String(input[`n`])}`, icon: `eye` }),
            shared: true,
            component: async () => Body,
        }),
    );
});
afterAll(() => {
    for (const disposable of disposables) {
        disposable.dispose();
    }
});

let app: App | undefined;
const mount = async (props: { floating?: boolean } = {}): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(SidePanel, props) });
    installUi(app);
    app.mount(host);
    await settle();
    return host;
};

// Async bodies load on the microtask queue; a macrotask turn and a render later, they are drawn.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    await nextTick();
};

const tabTitles = (host: HTMLElement): string[] => [...host.querySelectorAll(`[role="tab"]`)].map((tab) => tab.textContent?.trim() ?? ``);
const button = (host: HTMLElement, label: string): HTMLButtonElement | null => host.querySelector(`button[aria-label="${label}"]`);

beforeEach(() => {
    chatInSidePanel.value = true;
    chatTucked.value = false;
    chatParked.value = false;
    lent.value = false;
    openedHome.mockClear();
    closeAllTabs();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`draws the chat alone, as the column always looked, when nothing was opened beside`, async () => {
    const host = await mount();
    expect(host.querySelector(`.side-tabs`)).toBeNull();
    expect(chatSlot.value?.parentElement?.classList.contains(`side-chat`)).toBe(true);
});

it(`stands what was opened beside the chat in its own column, and never moves the chat to do it`, async () => {
    const host = await mount();
    const slot = chatSlot.value;
    openBeside(`stub`, { n: 1 });
    await settle();

    expect(tabTitles(host)).toEqual([`Thing 1`]);
    // Two columns, side by side and each the panel's full height: the tabs first, then the chat.
    const columns = [...(host.querySelector(`.side-panel`)?.children ?? [])].filter((child) => child.tagName === `SECTION`);
    expect(columns.map((column) => column.classList.contains(`side-tabs`) || column.classList.contains(`side-chat`))).toEqual([true, true]);
    expect(columns[0]?.classList.contains(`side-tabs`)).toBe(true);
    expect(host.querySelector(`.stub-body`)?.textContent).toBe(`body 1`);
    expect(chatSlot.value).toBe(slot);

    closeAllTabs();
    await settle();
    expect(host.querySelector(`.side-tabs`)).toBeNull();
    expect(chatSlot.value).toBe(slot);
});

// The chat folds into a strip at the window's edge (ChatTucked.vue), staying mounted behind it, so its transcript keeps
// its place; the strip's press brings it back.
it(`folds the chat into its strip and back, never moving the chat to do it`, async () => {
    const host = await mount();
    const slot = chatSlot.value;
    const strip = (): HTMLButtonElement | null => host.querySelector(`.side-chat-tucked`);
    expect(strip()).toBeNull();

    chatTucked.value = true;
    await settle();
    expect(strip()).not.toBeNull();
    const chat = host.querySelector(`.side-chat`);
    expect([chat?.classList.contains(`invisible`), chat?.hasAttribute(`inert`)]).toEqual([true, true]);
    expect(chatSlot.value).toBe(slot);

    strip()?.click();
    await settle();
    expect(chatTucked.value).toBe(false);
    expect(strip()).toBeNull();
    expect(host.querySelector(`.side-chat`)?.classList.contains(`invisible`)).toBe(false);
    expect(chatSlot.value).toBe(slot);
});

// Asking for the caret (New agent, a shortcut) wants a composer on screen: the quick bar's while it holds one, which
// keeps the page its width, and otherwise the chat's own, out of its strip.
it(`brings the tucked chat back for the caret, unless the quick bar holds its composer`, async () => {
    await mount();
    chatTucked.value = true;
    chatParked.value = true;
    await settle();

    focusComposer();
    await settle();
    expect(chatTucked.value).toBe(true);

    chatParked.value = false;
    focusComposer();
    await settle();
    expect(chatTucked.value).toBe(false);
});

it(`gives the tabs the whole column while the chat lives elsewhere`, async () => {
    chatInSidePanel.value = false;
    openBeside(`stub`, { n: 1 });
    const host = await mount();

    expect(host.querySelector(`.side-chat`)).toBeNull();
    expect(chatSlot.value).toBeNull();
    expect(host.querySelector(`.side-tabs`)?.classList.contains(`flex-1`)).toBe(true);
});

it(`keeps every body mounted and shows only the tab on screen`, async () => {
    openBeside(`stub`, { n: 1 }, { keep: true });
    openBeside(`stub`, { n: 2 });
    const host = await mount();

    const bodies = [...host.querySelectorAll(`[role="tabpanel"]`)];
    expect(bodies.map((body) => body.textContent)).toEqual([`body 1`, `body 2`]);
    expect(bodies.map((body) => body.classList.contains(`invisible`))).toEqual([true, false]);
    expect(bodies.map((body) => body.hasAttribute(`inert`))).toEqual([true, false]);
});

it(`draws a shared view's tabs as one body, never moved or rebuilt, handed the input of the tab on screen`, async () => {
    openBeside(`live`, { n: 1 }, { keep: true });
    openBeside(`stub`, { n: 9 }, { keep: true });
    openBeside(`live`, { n: 2 }, { keep: true });
    const host = await mount();

    expect(tabTitles(host)).toEqual([`Live 1`, `Thing 9`, `Live 2`]);
    const bodies = (): Element[] => [...host.querySelectorAll(`[role="tabpanel"]`)];
    expect(bodies().map((body) => body.textContent)).toEqual([`body 9`, `body 2`]);
    const shared = bodies()[1]?.querySelector(`.stub-body`);

    openBeside(`live`, { n: 1 });
    await settle();
    expect(bodies().map((body) => body.textContent)).toEqual([`body 9`, `body 1`]);
    expect(bodies()[1]?.querySelector(`.stub-body`)).toBe(shared);

    // A tab of another view on screen hides the shared body, which keeps its place and its last look.
    openBeside(`stub`, { n: 9 });
    await settle();
    expect(bodies().map((body) => body.classList.contains(`invisible`))).toEqual([false, true]);

    // Its first tab closing neither moves nor rebuilds it.
    closeTab(sideTabId(`live`, { n: 1 }));
    await settle();
    expect(bodies()[1]?.querySelector(`.stub-body`)).toBe(shared);
    expect(bodies()[1]?.textContent).toBe(`body 2`);
});

it(`offers Keep open on the peek alone, and keeps it`, async () => {
    openBeside(`stub`, { n: 1 });
    const host = await mount();

    button(host, `Keep Open`)?.click();
    await settle();
    expect(panel.peek.value).toBeNull();
    expect(button(host, `Keep Open`)).toBeNull();
});

it(`moves a thing into its home section and closes its tab`, async () => {
    openBeside(`stub`, { n: 1 });
    const host = await mount();

    button(host, `Open in Things`)?.click();
    await settle();
    expect(openedHome).toHaveBeenCalledTimes(1);
    expect(panel.tabs.value).toEqual([]);
});

it(`steps a tab aside while the main area is showing its thing, and brings it back after`, async () => {
    openBeside(`stub`, { n: 1 });
    const host = await mount();

    lent.value = true;
    await settle();
    expect(host.querySelector(`.side-tabs`)).toBeNull();
    expect(panel.tabs.value.map((tab) => tab.id)).toEqual([sideTabId(`stub`, { n: 1 })]);

    lent.value = false;
    await settle();
    expect(tabTitles(host)).toEqual([`Thing 1`]);
});

it(`draws a tab whose side view is gone, so it can be read and closed`, async () => {
    openBeside(`someone.gone/run`, { n: 1 });
    const host = await mount();

    expect(tabTitles(host)).toEqual([`run`]);
    expect(host.querySelector(`[role="tabpanel"]`)?.textContent).toContain(`Not available`);
});

it(`fills the middle with what was opened beside the chat, and splits to bring the section back`, async () => {
    openBeside(`stub`, { n: 1 });
    const host = await mount();
    const aside = (): HTMLElement | null => host.querySelector<HTMLElement>(`.side-panel`);
    const tabs = (): HTMLElement | null => host.querySelector<HTMLElement>(`.side-tabs`);

    expect(panel.split.value).toBe(false);
    expect(aside()?.style.gridColumn).toBe(`workspace-start / side-end`);
    expect(tabs()?.classList.contains(`flex-1`)).toBe(true);

    button(host, `Show beside`)?.click();
    await settle();
    expect(panel.split.value).toBe(true);
    expect(aside()?.style.gridArea).toBe(`side`);
    expect(tabs()?.classList.contains(`flex-1`)).toBe(false);
    expect(tabs()?.style.flex).toContain(`0 1`);

    // The last tab gone, the next thing opened fills again.
    closeAllTabs();
    expect(panel.split.value).toBe(false);
});

it(`offers no split while the chat lives elsewhere, the tabs being the whole column`, async () => {
    chatInSidePanel.value = false;
    openBeside(`stub`, { n: 1 });
    const host = await mount();

    expect(button(host, `Show beside`)).toBeNull();
    expect(host.querySelector<HTMLElement>(`.side-panel`)?.style.gridArea).toBe(`side`);
});

describe(`tucked away`, () => {
    const strip = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(`.side-tucked`);
    const stripLabels = (host: HTMLElement): string[] =>
        [...(strip(host)?.querySelectorAll(`button`) ?? [])].map((each) => each.getAttribute(`aria-label`) ?? ``);

    it(`folds what was opened into a strip beside the chat, every body still mounted, and brings it back on a press`, async () => {
        openBeside(`stub`, { n: 1 }, { keep: true });
        openBeside(`stub`, { n: 2 }, { keep: true });
        const host = await mount();
        const slot = chatSlot.value;
        const body = host.querySelector(`.stub-body`);

        button(host, `Tuck away`)?.click();
        await settle();
        expect(panel.tucked.value).toBe(true);
        expect(stripLabels(host)).toEqual([`Show Thing 1`, `Show Thing 2`]);
        // The column is out of sight and out of reach, not gone: what is framed in it never reloads.
        const tabs = host.querySelector<HTMLElement>(`.side-tabs`);
        expect(tabs?.classList.contains(`invisible`)).toBe(true);
        expect(tabs?.hasAttribute(`inert`)).toBe(true);
        expect(host.querySelector(`.stub-body`)).toBe(body);
        // The section comes back into the middle; the strip stands between it and the chat, which never moved.
        expect(host.querySelector<HTMLElement>(`.side-panel`)?.style.gridArea).toBe(`side`);
        expect(strip(host)?.nextElementSibling?.classList.contains(`side-chat`)).toBe(true);
        expect(chatSlot.value).toBe(slot);

        button(host, `Show Thing 1`)?.click();
        await settle();
        expect(panel.tucked.value).toBe(false);
        expect(panel.active.value).toBe(sideTabId(`stub`, { n: 1 }));
        expect(strip(host)).toBeNull();
        expect(host.querySelector(`.side-tabs`)?.hasAttribute(`inert`)).toBe(false);
        expect(host.querySelector(`.stub-body`)).toBe(body);
    });

    it(`keeps the chat's own edge to resize while tucked, between the strip and the chat`, async () => {
        openBeside(`stub`, { n: 1 });
        setTucked(true);
        const host = await mount();

        expect(host.querySelector(`.side-chat > [role="separator"]`)).not.toBeNull();
    });

    it(`stands the strip at the window's edge while the chat lives elsewhere`, async () => {
        chatInSidePanel.value = false;
        openBeside(`stub`, { n: 1 });
        setTucked(true);
        const host = await mount();

        expect(stripLabels(host)).toEqual([`Show Thing 1`]);
        expect(host.querySelector(`.side-chat`)).toBeNull();
    });

    it(`never tucks in a popped-out chat's window`, async () => {
        openBeside(`stub`, { n: 1 });
        setTucked(true);
        const host = await mount({ floating: true });

        expect(strip(host)).toBeNull();
        expect(button(host, `Tuck away`)).toBeNull();
        expect(host.querySelector(`.side-tabs`)?.hasAttribute(`inert`)).toBe(false);
    });

    it(`tucks when the column's edge is dragged past half a pane, and comes back when dragged out again`, async () => {
        // The test DOM has no pointer capture; the seam only needs the calls to land.
        for (const [name, value] of [
            [`setPointerCapture`, () => undefined],
            [`hasPointerCapture`, () => false],
            [`releasePointerCapture`, () => undefined],
        ] as const) {
            if (!(name in HTMLElement.prototype)) {
                Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
            }
        }
        openBeside(`stub`, { n: 1 });
        const host = await mount();
        // The panel's own edge, drawn last over both columns.
        const seams = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`.side-panel > [role="separator"]`)];
        const press = (type: string, x: number): void => void seams().at(-1)?.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true }));
        const frame = async (): Promise<void> => {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            await settle();
        };

        press(`pointerdown`, 0);
        // Rightward narrows a column whose edge is its left: all the way, past half a pane, it tucks.
        press(`pointermove`, 5000);
        await frame();
        expect(panel.tucked.value).toBe(true);
        expect(strip(host)).not.toBeNull();
        // Back under the pointer, within the same drag.
        press(`pointermove`, 0);
        await frame();
        expect(panel.tucked.value).toBe(false);
        press(`pointermove`, 5000);
        await frame();
        press(`pointerup`, 5000);
        await settle();
        expect(panel.tucked.value).toBe(true);
    });
});

describe(`a window too narrow for the column`, () => {
    const narrowTo = async (width: number): Promise<void> => {
        Object.defineProperty(window, `innerWidth`, { configurable: true, value: width });
        window.dispatchEvent(new Event(`resize`));
        await settle();
    };
    const wide = window.innerWidth;
    afterEach(() => narrowTo(wide));

    it(`tucks it by itself, brings it back when the window widens, and lets something opened show regardless`, async () => {
        openBeside(`stub`, { n: 1 }, { keep: true });
        const host = await mount();
        expect(host.querySelector(`.side-tucked`)).toBeNull();

        await narrowTo(600);
        expect(host.querySelector(`.side-tucked`)).not.toBeNull();
        // Not the reader's tuck, so nothing remembers it.
        expect(panel.tucked.value).toBe(false);

        await narrowTo(2400);
        expect(host.querySelector(`.side-tucked`)).toBeNull();

        await narrowTo(600);
        openBeside(`stub`, { n: 2 });
        await settle();
        expect(host.querySelector(`.side-tucked`)).toBeNull();

        // Each narrowing tucks it again.
        await narrowTo(2400);
        await narrowTo(600);
        expect(host.querySelector(`.side-tucked`)).not.toBeNull();
    });
});
