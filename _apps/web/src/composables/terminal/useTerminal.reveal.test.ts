// @vitest-environment jsdom
//
// The rule that keeps the strip clean: the surfaces WORK runs on (an agent's Bash shell, its browser, a daemon
// job) are records, not places. They tab only while someone is watching, and they let go of that tab when they
// finish — which is why a panel reopened after a night of agent turns has nothing in it to tidy up.
//
// Both pane kinds are mocked wholesale: every case here is about which names reach `order`/`groups` and which
// one is mounted, and none of it needs a real terminal (or a canvas jsdom doesn't have) or a live screencast.
import { beforeEach, expect, test, vi } from "vitest";
import { ref } from "vue";

const store = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
});
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ reachable: ref(true), activeSandboxId: ref(`sbx-1`) }),
}));
vi.mock("./terminalSession", () => ({
    createTerminalSession: (name: string) => ({ kind: `terminal`, name }),
    mountTerminalSession: vi.fn(),
    parkTerminalSession: vi.fn(),
    disposeTerminalSession: vi.fn(),
    persistScrollback: vi.fn(),
}));
vi.mock("./browserSession", () => ({
    createBrowserSession: (name: string) => ({ kind: `browser`, name }),
    mountBrowserSession: vi.fn(),
    parkBrowserSession: vi.fn(),
    disposeBrowserSession: vi.fn(),
    noteBrowserUrl: vi.fn(),
}));

const { createTerminalTabs } = await import("./useTerminal");
const { showWorkTerminals } = await import("./useWorkTerminals");
const { clearPendingTerminals } = await import("./terminalsQuery");

type Listed = { name: string; label?: string; kind: "shell" | "panel" | "agent" | "job" | "browser"; running: boolean; url?: string };
const shell = (name: string, running = true): Listed => ({ name, kind: `shell`, running });
const job = (key: string, running: boolean): Listed => ({ name: `job-${key}`, label: key, kind: `job`, running });
const agent = (id: string, running: boolean): Listed => ({ name: `agent-${id}`, label: id, kind: `agent`, running });
const browser = (id: string, running: boolean, label = `Example Domain`): Listed => ({
    name: `browser-${id}`,
    label,
    kind: `browser`,
    running,
    url: `https://example.com/`,
});

// One panel instance over a mutable session list, standing in for the daemon.
const panel = (initial: Listed[]) => {
    let listed = initial;
    const tabs = createTerminalTabs(
        { list: () => Promise.resolve(listed), create: () => `web-new`, kill: () => Promise.resolve() },
        `test`,
        () => undefined,
    );
    return {
        tabs,
        daemonLists: (next: Listed[]) => {
            listed = next;
        },
        attach: (awaited?: string) => tabs.attach(document.createElement(`div`), awaited),
        names: () => tabs.order.value.map((tab) => tab.name),
    };
};

beforeEach(() => {
    store.clear();
    clearPendingTerminals();
    showWorkTerminals.value = false;
});

// THE reported bug: terminals closed, agents worked, and reopening the panel meant closing seven dead pills by
// hand. A fresh panel holds no reveals, so there is nothing to close.
test("a panel opened after a night of finished work shows the user's shells and nothing else", async () => {
    const { attach, names } = panel([
        shell(`web-1`),
        job(`capability-demo`, false),
        job(`capability-with-agent`, false),
        job(`env`, false),
        agent(`aaaa1111`, false),
    ]);
    await attach();

    expect(names()).toEqual([`web-1`]);
});

// The agent's browser is work in exactly the sense its Bash shell is, so it earns its tab the same way: not by
// existing, but by being asked for — and it gives the tab back when the browsing is over and the user looks away.
test("the agent's browser tabs only once asked for, and lets go when it closes and you look away", async () => {
    const { tabs, daemonLists, attach, names } = panel([shell(`web-1`), browser(`aaaa1111`, true)]);
    await attach();
    expect(names()).toEqual([`web-1`]);

    // The chat's browser card offers to watch it (openWorkTerminal → focus).
    await tabs.focus(`browser-aaaa1111`);
    expect(names()).toEqual([`web-1`, `browser-aaaa1111`]);
    expect(tabs.activeName.value).toBe(`browser-aaaa1111`);

    // The turn ends and Chromium goes with it — but not out from under someone still reading the last frame.
    daemonLists([shell(`web-1`), browser(`aaaa1111`, false)]);
    await tabs.refresh();
    expect(names()).toEqual([`web-1`, `browser-aaaa1111`]);

    tabs.switchTab(`web-1`);
    await vi.waitFor(() => expect(names()).toEqual([`web-1`]));
});

test("a job tabs while it is being watched and lets go once it has finished and you look away", async () => {
    const { tabs, daemonLists, attach, names } = panel([shell(`web-1`), job(`capability-demo`, true)]);
    await attach();

    // The Capabilities page opens the install it just started (openFocused → focus).
    await tabs.focus(`job-capability-demo`);
    expect(names()).toEqual([`web-1`, `job-capability-demo`]);

    // It finishes while the user is still reading it — the pill must NOT vanish under them.
    daemonLists([shell(`web-1`), job(`capability-demo`, false)]);
    await tabs.refresh();
    expect(names()).toEqual([`web-1`, `job-capability-demo`]);
    expect(tabs.activeName.value).toBe(`job-capability-demo`);

    // They look up. That is what ends its stay.
    tabs.switchTab(`web-1`);
    await vi.waitFor(() => expect(names()).toEqual([`web-1`]));
});

// The reveal and the first list that carries the session land together, so retiring on that same pass would
// make the Recent popover's rows — which are finished by definition — click into nothing.
test("opening an ALREADY-finished terminal from the Recent list still tabs and focuses it", async () => {
    const { tabs, attach, names } = panel([shell(`web-1`), agent(`aaaa1111`, false)]);
    await attach();
    expect(names()).toEqual([`web-1`]);

    await tabs.focus(`agent-aaaa1111`);

    expect(names()).toEqual([`web-1`, `agent-aaaa1111`]);
    expect(tabs.activeName.value).toBe(`agent-aaaa1111`);
});

test("the panel opens onto a live tab, never onto the dead pane it was last left on", async () => {
    store.set(`ui-test-terminal-active`, `panel-app`);
    const { attach, tabs } = panel([{ name: `panel-app`, label: `app`, kind: `panel`, running: false }, shell(`web-1`)]);
    await attach();

    expect(tabs.activeName.value).toBe(`web-1`);
});

// Start opens the panel for a dev-server session the daemon hasn't created yet. The empty-panel shell exists so
// nobody stares at a blank pane, but here it would flash a stray `web-*` "1" beside the tab that was asked for.
test("a panel opened FOR a session that doesn't exist yet waits for it instead of spawning a shell", async () => {
    const { attach, names, tabs } = panel([]);

    await attach(`panel-site--site`);

    expect(names()).toEqual([]);
    expect(tabs.activeName.value).toBeUndefined();
});

test("an empty panel opened with no session in mind still opens a shell", async () => {
    const { attach, names } = panel([]);

    await attach();

    expect(names()).toEqual([`web-new`]);
});

test("with the preference on, work terminals tab and stay tabbed after they finish", async () => {
    showWorkTerminals.value = true;
    const { daemonLists, tabs, attach, names } = panel([shell(`web-1`), job(`capability-demo`, true)]);
    await attach();
    expect(names()).toEqual([`web-1`, `job-capability-demo`]);

    daemonLists([shell(`web-1`), job(`capability-demo`, false)]);
    await tabs.refresh();
    tabs.switchTab(`web-1`);

    expect(names()).toEqual([`web-1`, `job-capability-demo`]);
});
