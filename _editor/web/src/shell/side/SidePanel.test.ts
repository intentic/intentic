// The side panel mounted for real: what it draws for what it holds, and the one invariant the chat depends on, that the
// chat's slot is the same element whatever comes and goes beside it.
import "@intentic/testing/dom";
import { installUi } from "@intentic/ui";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// Whether the chat's home is the side: the one fact the panel reads from the chat.
const chatInSidePanel = ref(true);
jest.mock("../../features/chat/panel/chatPanelLayout", () => ({ chatInSidePanel }));

const { default: SidePanel } = await import("./SidePanel.vue");
const { closeAllTabs, openBeside, sideTabId, useSidePanel } = await import("./sideTabs");
const { registerSideView } = await import("./sideViews");
const { chatSlot } = await import("../window/panelSlots");

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
    );
});
afterAll(() => {
    for (const disposable of disposables) {
        disposable.dispose();
    }
});

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(SidePanel) });
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

    button(host, `Show the section beside`)?.click();
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

    expect(button(host, `Show the section beside`)).toBeNull();
    expect(host.querySelector<HTMLElement>(`.side-panel`)?.style.gridArea).toBe(`side`);
});
