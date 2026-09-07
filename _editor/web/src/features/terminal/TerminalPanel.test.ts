// @vitest-environment jsdom
//
// CLOSING A TERMINAL THAT IS DOING SOMETHING.
//
// Killing a tmux session is final: no undo, and the scrollback goes with it, but the strip is a row of
// near-identical pills and the × is a hover target four pixels wide. Aim one pill off and a build half an hour
// in, a test suite, or an editor holding unsaved buffers ended in silence.
//
// The reason it could not simply confirm is the interesting half: `running` is unconditionally true for a
// `web-*` shell, prompt or build, so a dialog keyed on it would have fired on EVERY close and taught the user to
// click straight through it. The daemon now reports what the live pane is actually running (`command`), and
// these cases pin the line that draws: idle closes on one click, busy asks and names the command.
//
// The same field is what makes the strip's inactive SWEEP safe, so its cases live here too, at the end: a row
// that offers to kill three terminals is only as good as its account of which three.
//
// The pane is mocked wholesale: every case here is about the dialog, not about a terminal.
import PrimeVue from "primevue/config";
import Tooltip from "primevue/tooltip";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

vi.hoisted(() => {
    // xterm measures glyphs against a canvas jsdom does not implement; the pane is mocked, but the strip's
    // PrimeVue overlays still touch it.
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
// The shared query cache reaches the network on its own schedule; the panel's own `source` is the list under
// test, so the cache is stubbed down to the two writes the strip makes.
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
// How long ago the session last said anything, which is what the strip's sweep ages a quiet shell by. Stated
// per fixture rather than defaulted, so no case decides silently whether it is inside the threshold.
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
    // The strip remembers its active tab and its splits per sandbox, so without this each case would open onto
    // whatever the last one left focused, and which tab is focused is the one thing the sweep spares.
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
    app.directive(`tooltip`, Tooltip);
    app.mount(host);
    mounted.push({ app, host });
    // Mount awaits the first list, which the strip then renders.
    await nextTick();
    await nextTick();
    await nextTick();
    return { killed, host };
};

// The × of a given pill. Every session's kill button carries its own aria-label, which is also where the
// command has to appear for a screen reader: the pulsing dot beside it says nothing out loud.
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
// The panel's own registration, which is the strip row's handler and the palette's alike: what these cases are
// about is which terminals a sweep selects and kills, not how PrimeVue draws a context menu over the bar.
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

/* THE REPORTED BUG. One click used to end this, and the only account of what was lost was whatever the user
 * happened to remember typing. The dialog names the command because "are you sure?" is a question nobody can
 * answer: the pill says "2", and `pnpm build` is the only thing that identifies the terminal being killed. */
test(`a shell with a command running asks first, and names the command`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `pnpm build`)]);
    closeButton(host, `Kill terminal`).click();
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill the terminal running pnpm build?`);
});

// Cancel is the whole point of the guard: the terminal is still there, still running, and its pill is still on
// the strip. (The dialog's own node lingers through PrimeVue's leave transition, so what is asserted is the
// decision (nothing killed) rather than the markup being gone the same tick.)
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

// And confirming still kills: a guard that made the action hard to complete would just be a worse ×.
test(`confirming kills it`, async () => {
    const { killed, host } = await openPanel([busy(`web-aaa`, `vitest`)]);
    closeButton(host, `Kill terminal`).click();
    await nextTick();
    const confirm = [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Kill anyway`));
    confirm?.click();
    await nextTick();
    expect(killed).toEqual([`web-aaa`]);
});

// The command is on the pill BEFORE anyone reaches for the ×, which is the half of this that prevents the
// mistake rather than catching it. Also in the button's own label, for a reader who never sees the dot.
test(`the strip says what a busy terminal is running`, async () => {
    const { host } = await openPanel([busy(`web-aaa`, `pnpm build`), idle(`web-bbb`)]);
    expect(host.textContent).toContain(`pnpm build`);
    expect(closeButton(host, `Kill terminal, running pnpm build`)).toEqual(expect.any(Object));
});

/* THE SWEEP, the other end of the same problem. Shells accumulate one command at a time (open one, run
 * something, walk away), and until this row the only ways out were the × per pill and "Kill all terminals",
 * which also takes the three you are in the middle of using. So the row states a count, and what stands behind
 * that count has to be exactly defensible: nothing running in it, quiet a while or simply over, and never the
 * tab being read. (The selection rule has its own cases in terminalSweep.test.ts; these are about the panel
 * doing what the rule says, through the dialog.) */
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
    // Nothing dies on the gesture itself: it named a count, and the dialog is where that becomes a list.
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill 2 inactive terminals?`);
    expect(dialogText()).toContain(`last output 42m ago`);
    expect(dialogText()).toContain(`finished`);
    clickButton(`Kill anyway`);
    await nextTick();
    // `web-here` is the tab the panel opened onto, `web-fresh` spoke a minute ago, and `web-build` is busy.
    expect(killed).toEqual([`web-old`, `panel-app`]);
});

// The fast lane the × and a single menu row take is closed to a sweep however harmless its set looks: a dead
// pane costs only its scrollback, but "Kill 1 inactive terminal" still does not say WHICH.
test(`a sweep of nothing but dead panes still asks first`, async () => {
    const { killed } = await openPanel([idle(`web-here`, 90), finished(`panel-app`)]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).toContain(`Kill 1 inactive terminal?`);
});

// And with nothing to tidy it is silent rather than confirming an empty set. (The strip's row is absent
// entirely in this state, so this is the palette's copy of the same non-action.)
test(`a strip of terminals in use sweeps nothing`, async () => {
    const { killed } = await openPanel([idle(`web-here`, 90), idle(`web-fresh`, 2), busy(`web-build`, `vitest`)]);
    runCommand(`terminal.killInactive`);
    await nextTick();
    expect(killed).toEqual([]);
    expect(dialogText()).not.toContain(`Kill anyway`);
});
