// @vitest-environment jsdom
// Idle closes on one click; busy (via `command`, since `running` is always true for web-* shells) asks and
// names it. The sweep shares this field; the pane is mocked, only the dialog is under test.
import PrimeVue from "primevue/config";
import Tooltip from "primevue/tooltip";
import { IconStub } from "@intentic/ui/testing";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

vi.hoisted(() => {
    // xterm needs a canvas jsdom doesn't implement; the pane is mocked, but PrimeVue's overlays still touch it.
    globalThis.HTMLCanvasElement.prototype.getContext ??= (() => null) as never;
});

const activeSandboxId = ref<string | undefined>(`sbx-a`);
vi.mock(`../sandbox/overview/activeSandbox`, () => ({
    ACTIVE_KEY: `intentic.activeSandboxId`,
    activeSandboxId,
    sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId],
}));
vi.mock(`../sandbox/client/sandboxClient`, () => ({ sandboxJson: vi.fn() }));
vi.mock(`../sandbox/client/useSandbox`, () => ({
    useSandbox: () => ({ reachable: ref(true), activeSandboxId }),
}));
vi.mock(`./terminalSession`, () => ({
    createTerminalSession: (name: string) => ({ name, term: { input: vi.fn() } }),
    mountTerminalSession: vi.fn(),
    parkTerminalSession: vi.fn(),
    disposeTerminalSession: vi.fn(),
    retypeTerminalSession: vi.fn(),
    copySelection: vi.fn(),
    pasteIntoTerminal: vi.fn(),
}));
// Query cache reaches the network on its own schedule; stubbed down to the two writes the strip makes.
vi.mock(`./terminalsQuery`, () => ({
    useTerminalsQuery: () => ({ sessions: ref([]), refetch: vi.fn() }),
    addPendingTerminal: vi.fn(),
    dropPendingTerminal: vi.fn(),
    clearPendingTerminals: vi.fn(),
    listTerminals: vi.fn(async () => []),
    refreshTerminals: vi.fn(async () => undefined),
    removeTerminal: vi.fn(),
}));

const { default: TerminalPanel } = await import("./TerminalPanel.vue");
const { commands } = await import("../../shell/commands/useCommands");

type Listed = { name: string; kind: "shell" | "panel" | "process"; running: boolean; activityAt: number; label?: string; command?: string };
// Minutes since last activity; stated per fixture so no case silently decides its own threshold.
const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;
const idle = (name: string, quietMinutes = 0): Listed => ({ name, kind: `shell`, running: true, activityAt: minutesAgo(quietMinutes) });
const busy = (name: string, command: string): Listed => ({ name, kind: `shell`, running: true, command, activityAt: minutesAgo(0) });
// A pane whose last window has exited: a stopped dev server, a one-shot job's leftover shell.
const finished = (name: string): Listed => ({ name, kind: `panel`, label: name, running: false, activityAt: 0 });

const mounted: { app: App; host: HTMLElement }[] = [];
afterEach(() => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
    // Strip remembers active tab/splits per sandbox; clear localStorage so cases don't inherit the last focus.
    localStorage.clear();
});

// One panel over a fixed session list, plus the kills it issued.
const openPanel = async (sessions: Listed[]) => {
    const killed: string[] = [];
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({
        render: () =>
            h(TerminalPanel, {
                storageKey: `test`,
                resizable: false,
                source: {
                    list: () => Promise.resolve(sessions),
                    create: () => `web-new`,
                    kill: (name: string) => {
                        killed.push(name);
                        return Promise.resolve();
                    },
                },
            }),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, Tooltip);
    app.mount(host);
    mounted.push({ app, host });
    // Mount awaits the first list, which the strip then renders.
    await nextTick();
    await nextTick();
    await nextTick();
    return { killed, host };
};

// × of a given pill; the kill button's aria-label is where the running command appears for a screen reader.
const closeButton = (host: HTMLElement, label: string): HTMLElement => {
    const found = [...host.querySelectorAll(`[aria-label]`)].find((el) => (el.getAttribute(`aria-label`) ?? ``).startsWith(label));
    expect(found, `no close button labelled ${label}`).toEqual(expect.any(Object));
    return found as HTMLElement;
};
const dialogText = (): string => document.body.textContent ?? ``;
const clickButton = (label: string): void => {
    const button = [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(label));
    expect(button, `no button labelled ${label}`).toEqual(expect.any(Object));
    button?.click();
};
// Runs the panel's own command registration (shared by the row handler and the palette), not a menu click.
const runCommand = (id: string): void => {
    const registered = commands.value.find((entry) => entry.command === id);
    expect(registered, `no command registered as ${id}`).toEqual(expect.any(Object));
    registered?.handler();
};

test(`an idle shell closes on one click: no dialog`, async () => {
    const { killed, host } = await openPanel([idle(`web-aaa`)]);
    closeButton(host, `Kill terminal`).click();
    await nextTick();
    expect(killed).toEqual([`web-aaa`]);
    expect(dialogText()).not.toContain(`Kill anyway`);
});

test(`a shell with a command running asks first, and names the command`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `pnpm build`)]);
    closeButton(host, `Kill terminal`).click();
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill the terminal running pnpm build?`);
});

// The dialog node lingers through PrimeVue's leave transition; assert the decision, not markup absence.
test(`cancelling leaves the session alone`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `vitest`)]);
    closeButton(host, `Kill terminal`).click();
    await nextTick();
    const cancel = [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Cancel`));
    cancel?.click();
    await nextTick();
    expect(killed).toEqual([]);
    expect(closeButton(host, `Kill terminal, running vitest`)).toEqual(expect.any(Object));
});

test(`confirming kills it`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `vitest`)]);
    closeButton(host, `Kill terminal`).click();
    await nextTick();
    const confirm = [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Kill anyway`));
    confirm?.click();
    await nextTick();
    expect(killed).toEqual([`web-aaa`]);
});

test(`the strip says what a busy terminal is running`, async () => {
    const { host } = await openPanel([busy(`web-aaa`, `pnpm build`), idle(`web-bbb`)]);
    expect(host.textContent).toContain(`pnpm build`);
    expect(closeButton(host, `Kill terminal, running pnpm build`)).toEqual(expect.any(Object));
});

// Selection logic has its own cases in terminalSweep.test.ts; this is the panel enacting it through the dialog.
test(`the sweep takes the quiet and the finished, and says why each qualified`, async () => {
    const { killed } = await openPanel([
        idle(`web-here`, 90),
        idle(`web-old`, 42),
        idle(`web-fresh`, 1),
        busy(`web-build`, `pnpm build`),
        finished(`panel-app`),
    ]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill 2 inactive terminals?`);
    expect(dialogText()).toContain(`last output 42m ago`);
    expect(dialogText()).toContain(`finished`);
    clickButton(`Kill anyway`);
    await nextTick();
    // `web-here` is the open tab, `web-fresh` is recent, `web-build` is busy: all spared.
    expect(killed).toEqual([`web-old`, `panel-app`]);
});

test(`a sweep of nothing but dead panes still asks first`, async () => {
    const { killed } = await openPanel([idle(`web-here`, 90), finished(`panel-app`)]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill 1 inactive terminal?`);
});

test(`a strip of terminals in use sweeps nothing`, async () => {
    const { killed } = await openPanel([idle(`web-here`, 90), idle(`web-fresh`, 2), busy(`web-build`, `vitest`)]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).not.toContain(`Kill anyway`);
});
