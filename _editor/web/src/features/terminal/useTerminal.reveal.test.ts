// @vitest-environment jsdom
// Pins that work terminals (agent/job) tab only while revealed and let go once finished. The pane is mocked wholesale:
// no real terminal or canvas, which jsdom lacks.
import { beforeEach, expect, test, vi } from "vitest";
import { ref } from "vue";

const store = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
});
vi.mock("../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn() }));
// Every remembered key is filed under the sandbox it belongs to; the ids below are this test's sandbox.
vi.mock("../sandbox/overview/activeSandbox", () => ({
    ACTIVE_KEY: `intentic.activeSandboxId`,
    activeSandboxId: ref(`sbx-1`),
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
}));
vi.mock("../sandbox/client/useSandbox", () => ({
    useSandbox: () => ({ reachable: ref(true), activeSandboxId: ref(`sbx-1`) }),
}));
vi.mock("./terminalSession", () => ({
    createTerminalSession: (name: string) => ({ kind: `terminal`, name }),
    mountTerminalSession: vi.fn(),
    parkTerminalSession: vi.fn(),
    disposeTerminalSession: vi.fn(),
}));

const { createTerminalTabs } = await import("./useTerminal");
const { showWorkTerminals } = await import("./useWorkTerminals");
const { clearPendingTerminals } = await import("./terminalsQuery");

// activityAt is just 'said something recently'; the sweep itself is tested in terminalSweep.test.ts.
type Listed = { name: string; label?: string; kind: "shell" | "panel" | "agent" | "job"; running: boolean; activityAt: number };
const shell = (name: string, running = true): Listed => ({ name, kind: `shell`, running, activityAt: Date.now() });
const job = (key: string, running: boolean): Listed => ({ name: `job-${key}`, label: key, kind: `job`, running, activityAt: Date.now() });
const agent = (id: string, running: boolean): Listed => ({ name: `agent-${id}`, label: id, kind: `agent`, running, activityAt: Date.now() });

// One panel instance over a mutable session list, standing in for the daemon.
const panel = (initial: Listed[]) => {
    let listed = initial;
    let failOnce = false;
    let holdOnce = false;
    const list = (): Promise<Listed[]> => {
        if (failOnce) {
            failOnce = false;
            return Promise.reject(new Error(`daemon unreachable`));
        }
        if (holdOnce) {
            holdOnce = false;
            // Answer decided now, delivered later: a snapshot from when asked, arriving after things moved on.
            const snapshot = listed;
            return new Promise<Listed[]>((resolve) => {
                held = () => resolve(snapshot);
                if (releasedEarly) {
                    held();
                }
            });
        }
        return Promise.resolve(listed);
    };
    let held: (() => void) | undefined;
    let releasedEarly = false;
    const tabs = createTerminalTabs({ list, create: () => `web-new`, kill: () => Promise.resolve() }, `test`, () => undefined);
    return {
        tabs,
        daemonLists: (next: Listed[]) => {
            listed = next;
        },
        // Next list comes back as a rejection, e.g. the tunnel dropping a request under load.
        failNextList: () => {
            failOnce = true;
        },
        // Holds the next list on the wire; the returned function releases its already-decided answer.
        holdNextList: () => {
            holdOnce = true;
            return () => {
                releasedEarly = true;
                held?.();
            };
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

test("a job tabs while it is being watched and lets go once it has finished and you look away", async () => {
    const { tabs, daemonLists, attach, names } = panel([shell(`web-1`), job(`capability-demo`, true)]);
    await attach();

    // Simulates the Capabilities page opening the install it just started.
    await tabs.focus(`job-capability-demo`);
    expect(names()).toEqual([`web-1`, `job-capability-demo`]);

    daemonLists([shell(`web-1`), job(`capability-demo`, false)]);
    await tabs.refresh();
    expect(names()).toEqual([`web-1`, `job-capability-demo`]);
    expect(tabs.activeName.value).toBe(`job-capability-demo`);

    tabs.switchTab(`web-1`);
    await vi.waitFor(() => expect(names()).toEqual([`web-1`]));
});

// Reveal and the first list carrying the session land in the same pass, so retiring then would leave the click doing
// nothing.
test("opening an ALREADY-finished terminal from the chat's Bash card still tabs and focuses it", async () => {
    const { tabs, attach, names } = panel([shell(`web-1`), agent(`aaaa1111`, false)]);
    await attach();
    expect(names()).toEqual([`web-1`]);

    await tabs.focus(`agent-aaaa1111`);

    expect(names()).toEqual([`web-1`, `agent-aaaa1111`]);
    expect(tabs.activeName.value).toBe(`agent-aaaa1111`);
});

test("the panel opens onto a live tab, never onto the dead pane it was last left on", async () => {
    store.set(`ui-test-terminal-active.sbx-1`, `panel-app`);
    const { attach, tabs } = panel([{ name: `panel-app`, label: `app`, kind: `panel`, running: false, activityAt: Date.now() }, shell(`web-1`)]);
    await attach();

    expect(tabs.activeName.value).toBe(`web-1`);
});

test("a job the daemon has only just announced still tabs and focuses once it exists", async () => {
    const { tabs, daemonLists, attach, names } = panel([]);
    await attach(`job-capability-github`);
    expect(names()).toEqual([]);

    const focusing = tabs.focus(`job-capability-github`);
    daemonLists([job(`capability-github`, true)]);
    await focusing;

    expect(names()).toEqual([`job-capability-github`]);
    expect(tabs.activeName.value).toBe(`job-capability-github`);
});

test("a check that takes its time to reach tmux still surfaces whenever it gets there", async () => {
    const { tabs, daemonLists, attach, names } = panel([]);
    await attach(`job-checks`);

    await tabs.focus(`job-checks`);
    expect(names()).toEqual([]);
    expect(tabs.pending.value).toBe(`job-checks`);

    // Stands in for the daemon's own `terminals` frame relisting.
    daemonLists([job(`checks`, true)]);
    await tabs.refresh();

    expect(names()).toEqual([`job-checks`]);
    expect(tabs.activeName.value).toBe(`job-checks`);
    expect(tabs.pending.value).toBeUndefined();
});

test("a list taken before the check existed cannot un-list it by arriving late", async () => {
    const { tabs, daemonLists, attach, names, holdNextList } = panel([]);
    await attach(`job-checks`);

    // Models a relist that caught the sandbox early and hung on the way back.
    const release = holdNextList();
    const early = tabs.refresh();

    daemonLists([job(`checks`, true)]);
    const focusing = tabs.focus(`job-checks`);
    // Lets the focus request run while the early one is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));

    release();
    await early;
    await focusing;

    expect(names()).toEqual([`job-checks`]);
    expect(tabs.activeName.value).toBe(`job-checks`);
    expect(tabs.pending.value).toBeUndefined();
});

test("a list that fails mid-wait does not strand the panel", async () => {
    const { tabs, daemonLists, failNextList, attach, names } = panel([]);
    await attach(`job-checks`);

    failNextList();
    await expect(tabs.focus(`job-checks`)).rejects.toThrow();
    expect(tabs.pending.value).toBe(`job-checks`);

    daemonLists([job(`checks`, true)]);
    await tabs.refresh();

    expect(names()).toEqual([`job-checks`]);
});

// Attach must not rethrow a refused list, or the mount's second half (asking for the session it opened for) never runs.
test("a first list that drops still lets the panel go and ask for the check it was opened for", async () => {
    const { tabs, daemonLists, failNextList, attach, names } = panel([]);

    failNextList();
    await expect(attach(`job-checks`)).resolves.toBe(false);

    await tabs.focus(`job-checks`);
    daemonLists([job(`checks`, true)]);
    await tabs.refresh();

    expect(names()).toEqual([`job-checks`]);
    expect(tabs.activeName.value).toBe(`job-checks`);
    expect(tabs.pending.value).toBeUndefined();
});

// An unreadable strip is not an empty sandbox; opening a shell over it would spawn one nobody asked for.
test("a first list that drops opens no shell of its own", async () => {
    const { failNextList, attach, names } = panel([]);

    failNextList();
    await attach();

    expect(names()).toEqual([]);
});

test("a list that never comes back cannot hold up the ones asked after it", async () => {
    const { tabs, daemonLists, attach, names, holdNextList } = panel([]);
    await attach(`job-checks`);

    // Never released; still pending at the end of the test.
    holdNextList();
    void tabs.refresh();

    daemonLists([job(`checks`, true)]);
    await tabs.focus(`job-checks`);

    expect(names()).toEqual([`job-checks`]);
    expect(tabs.pending.value).toBeUndefined();
});

// Models Start opening the panel before the daemon creates the session.
test("a panel opened FOR a session that doesn't exist yet waits for it instead of spawning a shell", async () => {
    const { attach, names, tabs } = panel([]);

    await attach(`panel-site--site`);

    expect(names()).toEqual([]);
    expect(tabs.activeName.value).toBeUndefined();
});

// attach must consult the live `pending`, not just its mount-time argument.
test("a focus request that arrives while an empty panel attaches suppresses its automatic shell", async () => {
    const { tabs, attach, names, holdNextList } = panel([]);
    const release = holdNextList();
    const attaching = attach();

    await tabs.focus(`job-checks`);
    expect(tabs.pending.value).toBe(`job-checks`);

    release();
    await attaching;

    expect(names()).toEqual([]);
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
