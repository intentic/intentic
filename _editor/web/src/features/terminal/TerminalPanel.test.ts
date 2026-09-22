// Idle closes on one click; busy (via `command`, since `running` is always true for web-* shells) asks and
// names it. The sweep shares this field; the pane is mocked, only the dialog is under test.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import Tooltip from "primevue/tooltip";
import { IconStub } from "@intentic/ui/testing";
import { test, expect, afterEach, mock } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref } from "vue";

hoisted(() => {
    // xterm needs a canvas jsdom doesn't implement; the pane is mocked, but PrimeVue's overlays still touch it.
    globalThis.HTMLCanvasElement.prototype.getContext ??= (() => null) as never;
});

const activeSandboxId = ref<string | undefined>(`sbx-a`);
mock.module(`../sandbox/overview/activeSandbox`, () => ({
    ACTIVE_KEY: `intentic.activeSandboxId`,
    activeSandboxId,
    sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId],
}));
mock.module(`../sandbox/client/sandboxClient`, () => ({ sandboxJson: mock(), sandboxRequestVia: mock() }));
mock.module(`../sandbox/client/useSandbox`, () => ({
    useSandbox: () => ({ reachable: ref(true), activeSandboxId }),
}));
mock.module(`./terminalSession`, () => ({
    createTerminalSession: (name: string) => ({ name, term: { input: mock() } }),
    mountTerminalSession: mock(),
    parkTerminalSession: mock(),
    disposeTerminalSession: mock(),
    retypeTerminalSession: mock(),
    retintTerminalSession: mock(),
    copySelection: mock(),
    pasteIntoTerminal: mock(),
}));
// Query cache reaches the network on its own schedule; stubbed down to the two writes the strip makes.
mock.module(`./terminalsQuery`, () => ({
    useTerminalsQuery: () => ({ sessions: ref([]), refetch: mock() }),
    addPendingTerminal: mock(),
    dropPendingTerminal: mock(),
    clearPendingTerminals: mock(),
    listTerminals: mock(async () => []),
    refreshTerminals: mock(async () => undefined),
    removeTerminal: mock(),
}));

const { default: TerminalPanel } = await import("./TerminalPanel.vue");
const { commands } = await import("../../shell/commands/useCommands");

type Listed = { name: string; kind: "shell" | "panel" | "process"; running: boolean; activityAt: number; label?: string; command?: string };
// Minutes since last activity; stated per fixture so no case silently decides its own threshold.
const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;
const idle = (name: string, quietMinutes = 0): Listed => ({ name, kind: `shell`, running: true, activityAt: minutesAgo(quietMinutes) });
const busy = (name: string, command: string): Listed => ({ name, kind: `shell`, running: true, command, activityAt: minutesAgo(0) });
// A pane whose last window has exited: a dev server that stopped. (A finished one-shot run lists as a job and leaves
// the strip on its own, so the sweep never meets one.)
const finished = (name: string): Listed => ({ name, kind: `panel`, label: name, running: false, activityAt: 0 });

const mounted: { app: App; host: HTMLElement }[] = [];
afterEach(async () => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
    // PrimeVue's tooltip directive schedules its own removal on a zero-delay timer as it unmounts (tooltip/index.mjs,
    // `unmounted` -> `hide(el, 0)`). Run it here, while there is still a document for it to read: left pending, it
    // fires after this file's environment is torn down and fails the run as an unhandled `document is not defined`.
    await new Promise((resolve) => setTimeout(resolve));
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

// The pill around a given ×: a shell's label is its strip number, so the kill button's own wording is what tells
// two pills apart here, the same string the cases above assert on.
const pillAround = (host: HTMLElement, killLabel: string): HTMLElement => {
    const kill = [...host.querySelectorAll(`[data-term-tab] [aria-label]`)].find((el) => el.getAttribute(`aria-label`) === killLabel);
    expect(kill, `no pill whose × reads "${killLabel}"`).toEqual(expect.any(Object));
    return (kill as HTMLElement).parentElement as HTMLElement;
};
const middlePress = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent(`auxclick`, { bubbles: true, cancelable: true, button: 1 }));
};

// Middle-click is the pill's × pressed: the same kill, aimed at the pill under the pointer rather than the focused one.
test(`a middle-click kills the pill it landed on`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `pnpm build`), idle(`web-bbb`)]);
    middlePress(pillAround(host, `Kill terminal`));
    await nextTick();
    expect(killed).toEqual([`web-bbb`]);
    expect(dialogText()).not.toContain(`Kill anyway`);
});

// Including the question: a gesture with no × under the pointer to aim at must not skip the confirmation.
test(`a middle-click on a busy pill asks first, and names the command`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `pnpm build`)]);
    middlePress(pillAround(host, `Kill terminal, running pnpm build`));
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill the terminal running pnpm build?`);
});

// Selection logic has its own cases in terminalSweep.test.ts; this is the panel enacting it through the dialog.
test(`the sweep takes the quiet and the finished without asking`, async () => {
    const { killed } = await openPanel([
        idle(`web-here`, 90),
        idle(`web-old`, 42),
        idle(`web-fresh`, 1),
        busy(`web-build`, `pnpm build`),
        finished(`panel-app`),
    ]);
    expect(killed).toEqual([]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(document.querySelector(`[role="dialog"], [role="alertdialog"]`)).toBeNull();
    expect(dialogText()).not.toContain(`Kill 2 inactive terminals?`);
    expect(dialogText()).not.toContain(`Kill anyway`);
    // `web-here` is the open tab, `web-fresh` is recent, `web-build` is busy: all spared.
    expect(killed).toEqual([`web-old`, `panel-app`]);
});

test(`a sweep of nothing but dead panes goes through`, async () => {
    const { killed } = await openPanel([idle(`web-here`, 90), finished(`panel-app`)]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([`panel-app`]);
    expect(dialogText()).not.toContain(`Kill anyway`);
});

test(`a strip of terminals in use sweeps nothing`, async () => {
    const { killed } = await openPanel([idle(`web-here`, 90), idle(`web-fresh`, 2), busy(`web-build`, `vitest`)]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).not.toContain(`Kill anyway`);
});
