import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, onUpdated, ref } from "vue";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { resetSandboxClock } from "../../fleet/sandboxClock";
import ChildRow from "./ChildRow.vue";

let app: App | undefined;
const child = (status: FleetAgent[`status`] = `landed`): FleetAgent => ({
    id: `child`,
    title: `inspect the timer`,
    status,
    provider: `codex`,
    harness: `native`,
    updatedAt: Date.now() - 26 * 60_000,
    startedAt: Date.now(),
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    startedBy: `agent:parent`,
});

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

const mount = (initial: FleetAgent, updated = jest.fn()) => {
    const root = document.createElement(`div`);
    document.body.append(root);
    const agent = ref(initial);
    app = createApp({
        setup() {
            onUpdated(updated);
            return () => h(ChildRow, {
                child: agent.value,
                provider: `codex`,
                selected: false,
                needle: ``,
                matchCase: false,
                menus: false,
                onVnodeUpdated: updated,
            });
        },
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(root);
    return { root, agent };
};

it(`advances a settled subagent's age without redrawing its row or parent`, async () => {
    const updated = jest.fn();
    const { root } = mount(child(), updated);
    expect(root.textContent).toContain(`26m`);

    await advanceTimersByTimeAsync(19 * 60_000);
    await nextTick();
    expect(root.textContent).toContain(`45m`);
    expect(updated).not.toHaveBeenCalled();
});

it(`switches from second-rate elapsed to minute-rate age when the subagent settles`, async () => {
    const { root, agent } = mount(child(`running`));
    expect(root.textContent).toContain(`0s`);
    expect(jest.getTimerCount()).toBe(1);

    await advanceTimersByTimeAsync(1_000);
    await nextTick();
    expect(root.textContent).toContain(`1s`);

    agent.value = { ...agent.value, status: `landed`, updatedAt: Date.now() };
    await nextTick();
    expect(root.textContent).toContain(`just now`);
    expect(jest.getTimerCount()).toBe(1);

    await advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(root.textContent).toContain(`1m`);

    app?.unmount();
    app = undefined;
    expect(jest.getTimerCount()).toBe(0);
});
