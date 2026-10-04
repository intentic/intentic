import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, onUpdated } from "vue";
import { clockOffset, resetSandboxClock } from "../../fleet/sandboxClock";
import AgentCardDate from "./AgentCardDate.vue";

let app: App | undefined;
const mount = (at: number, archived = false, updated = jest.fn(), parentUpdated = jest.fn()): HTMLElement => {
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({
        setup() {
            onUpdated(parentUpdated);
            return () => h(`span`, [h(AgentCardDate, { at, archived, onVnodeUpdated: updated })]);
        },
    });
    app.mount(root);
    return root;
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(60_000_000);
    resetSandboxClock();
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    resetSandboxClock();
    jest.useRealTimers();
});

it(`updates only the date leaf when its minute changes`, async () => {
    const updated = jest.fn();
    const parentUpdated = jest.fn();
    const root = mount(Date.now() - 26 * 60_000, false, updated, parentUpdated);
    expect(root.textContent).toBe(`26m`);

    await advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(root.textContent).toBe(`27m`);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(parentUpdated).not.toHaveBeenCalled();
});

it(`does not redraw an hour label on every minute tick`, async () => {
    const updated = jest.fn();
    const root = mount(Date.now() - 2 * 60 * 60_000, false, updated);
    expect(root.textContent).toBe(`2h`);

    await advanceTimersByTimeAsync(29 * 60_000);
    await nextTick();
    expect(root.textContent).toBe(`2h`);
    expect(updated).not.toHaveBeenCalled();

    await advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(root.textContent).toBe(`3h`);
    expect(updated).toHaveBeenCalledTimes(1);
});

it(`uses the sandbox's clock and reacts to its offset settling`, async () => {
    clockOffset.value = 5 * 60_000;
    const root = mount(Date.now() - 26 * 60_000, true);
    expect(root.textContent).toBe(`Archived 21m`);

    clockOffset.value = 4 * 60_000;
    await nextTick();
    expect(root.textContent).toBe(`Archived 22m`);

    await advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(root.textContent).toBe(`Archived 23m`);
});
