// @vitest-environment jsdom
//
// The rule that keeps the strip clean: the surfaces WORK runs on (an agent's Bash shell, a daemon job) are
// records, not places. They tab only while someone is watching, and they let go of that tab when they finish —
// which is why a panel reopened after a night of agent turns has nothing in it to tidy up.
//
// The pane is mocked wholesale: every case here is about which names reach `order`/`groups` and which one is
// mounted, and none of it needs a real terminal (or a canvas jsdom doesn't have).
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

const { createTerminalTabs } = await import("./useTerminal");
const { showWorkTerminals } = await import("./useWorkTerminals");
const { clearPendingTerminals } = await import("./terminalsQuery");

type Listed = { name: string; label?: string; kind: "shell" | "panel" | "agent" | "job"; running: boolean };
const shell = (name: string, running = true): Listed => ({ name, kind: `shell`, running });
const job = (key: string, running: boolean): Listed => ({ name: `job-${key}`, label: key, kind: `job`, running });
const agent = (id: string, running: boolean): Listed => ({ name: `agent-${id}`, label: id, kind: `agent`, running });

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
            // The answer is decided NOW and delivered later — a list of what the sandbox held at the moment it
            // was asked, arriving after the world has moved on.
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
        // The next list comes back as a rejection — the tunnel dropping one request under load.
        failNextList: () => {
            failOnce = true;
        },
        // Hold the next list on the wire; the returned function lets its (already decided) answer through.
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
// make the chat's "watch this turn's shell" — clicked on a turn that has since ended — do nothing at all.
test("opening an ALREADY-finished terminal from the chat's Bash card still tabs and focuses it", async () => {
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

// THE reported bug behind the wait: a flow NAMES its terminal before that terminal exists — the daemon says
// "I will work in job-capability-github", and tmux creates that session with the install's first command a beat
// later. Asking once meant the answer was always "no such session", so the user sat in front of an empty panel
// (or the shell they had open) while the install ran to completion somewhere they couldn't see.
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

/* THE PUSH BUG. The wait used to be a race — a handful of relists a quarter-second apart — run at the busiest
 * moment there is: the pre-push suite pinning the sandbox it is asking. When the session lost that race the tab
 * was not late, it was gone, because a work terminal tabs only while its reveal stands. The check then ran to
 * completion in a terminal nothing ever showed, behind a spinner that had already given up. */
test("a check that takes its time to reach tmux still surfaces whenever it gets there", async () => {
    const { tabs, daemonLists, attach, names } = panel([]);
    await attach(`job-checks`);

    // The panel asks, and the session simply is not there yet — for far longer than any retry window.
    await tabs.focus(`job-checks`);
    expect(names()).toEqual([]);
    expect(tabs.pending.value).toBe(`job-checks`);

    // Whenever it does land, the daemon's own `terminals` frame relists — and the tab is waiting for it.
    daemonLists([job(`checks`, true)]);
    await tabs.refresh();

    expect(names()).toEqual([`job-checks`]);
    expect(tabs.activeName.value).toBe(`job-checks`);
    expect(tabs.pending.value).toBeUndefined();
});

/* THE PUSH BUG'S LAST FORM — the one that survived the standing wait. Everything asks for a list at once when a
 * push starts (the panel mounting, the daemon's frame, the focus request itself), and the answers used to be
 * written in whatever order they came back. A list taken before the session existed, landing after the one that
 * carried it, put the strip back to empty and left the panel saying nothing runs under that name. */
test("a list taken before the check existed cannot un-list it by arriving late", async () => {
    const { tabs, daemonLists, attach, names, holdNextList } = panel([]);
    await attach(`job-checks`);

    // A relist that catches the sandbox a moment too early, and hangs on the way back (the tunnel under a suite).
    const release = holdNextList();
    const early = tabs.refresh();

    // The session lands, and the focus request's own relist sees it.
    daemonLists([job(`checks`, true)]);
    const focusing = tabs.focus(`job-checks`);
    // Let that request get as far as it can while the early one is still out — this is the window where the tab
    // was mounted, and where the late answer used to land on top of it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    release();
    await early;
    await focusing;

    expect(names()).toEqual([`job-checks`]);
    expect(tabs.activeName.value).toBe(`job-checks`);
    expect(tabs.pending.value).toBeUndefined();
});

// The other half of that failure: one dropped list — the tunnel under load, mid-suite — used to strand the
// panel on its spinner for good, because the wait was a promise and nothing ever settled it.
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
