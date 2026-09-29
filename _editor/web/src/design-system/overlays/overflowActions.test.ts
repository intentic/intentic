import "@intentic/testing/dom";
import { type ActionItem, OverflowActions } from "@intentic/ui";
import { createApp, h } from "vue";

// jsdom: the @intentic/ui barrel reaches window.matchMedia at import, stubbed in bun.setup.ts to the desktop form
// factor, which is the half pinned here: every press its own button, named, and handed the element it came from. The
// phone's half folds them behind one ⋯ into an <ActionSheet>.

let app: ReturnType<typeof createApp> | undefined;

const mount = (actions: readonly ActionItem[]): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(`div`, [h(OverflowActions, { actions, buttonClass: `press` })]) });
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

it(`draws each press as its own named button where there is a pointer`, () => {
    const el = mount([
        { id: `rename`, label: `Rename agent`, icon: `pencil`, run: () => undefined },
        { id: `archive`, label: `Archive agent`, icon: `box`, run: () => undefined },
    ]);
    const buttons = [...el.querySelectorAll(`button`)];
    expect(buttons.map((button) => button.getAttribute(`aria-label`))).toEqual([`Rename agent`, `Archive agent`]);
    expect(buttons.map((button) => button.className)).toEqual([`press`, `press`]);
});

it(`hands a press the element it came from, and presses nothing else`, () => {
    const ran: string[] = [];
    let from: HTMLElement | undefined;
    const el = mount([
        {
            id: `react`,
            label: `Add reaction`,
            icon: `plus`,
            run: (source) => {
                from = source;
                ran.push(`react`);
            },
        },
        { id: `remove`, label: `Delete`, icon: `trash`, danger: true, run: () => ran.push(`remove`) },
    ]);
    const react = el.querySelector<HTMLButtonElement>(`[aria-label="Add reaction"]`)!;
    react.click();
    expect(ran).toEqual([`react`]);
    expect(from).toBe(react);
});

it(`holds a disabled press out`, () => {
    const el = mount([{ id: `run`, label: `Run now`, icon: `play`, disabled: true, run: () => undefined }]);
    expect(el.querySelector<HTMLButtonElement>(`[aria-label="Run now"]`)?.disabled).toBe(true);
});
