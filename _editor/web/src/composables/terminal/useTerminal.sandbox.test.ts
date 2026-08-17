// @vitest-environment jsdom
//
// SWITCHING SANDBOXES, and the one thing the strip must never do.
//
// How the strip is arranged — which shells sit side by side, which tab you were on — is remembered per sandbox,
// because each sandbox is a machine with its own terminals. The sessions themselves belong to ONE daemon, and
// they arrive over a tunnel that a switch has just repointed. So the arrangement is known instantly and the
// session list is not, which is the seam the reported bug lived in: coming back to a sandbox painted terminal
// "1" out of storage, the list behind it failed on a daemon that was still waking, and the pill sat there
// unclickable over a panel that said no terminals were open.
//
// The pane is mocked wholesale — every case here is about which names reach `order`/`groups` and which one is
// mounted, none of which needs a real terminal.
import { beforeEach, expect, test, vi } from "vitest";
import { ref } from "vue";

const store = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
});

// The switch itself: the one ref the whole app scopes by (composables/sandbox/activeSandbox).
const activeSandboxId = ref<string | undefined>(`sbx-a`);
vi.mock("../sandbox/activeSandbox", () => ({
    ACTIVE_KEY: `intentic.activeSandboxId`,
    activeSandboxId,
    sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId],
}));
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/useSandbox", () => ({
    useSandbox: () => ({ reachable: ref(true), activeSandboxId }),
}));
vi.mock("./terminalSession", () => ({
    createTerminalSession: (name: string) => ({ kind: `terminal`, name }),
    mountTerminalSession: vi.fn(),
    parkTerminalSession: vi.fn(),
    disposeTerminalSession: vi.fn(),
    persistScrollback: vi.fn(),
}));

const { createTerminalTabs, disposeAllSessions } = await import("./useTerminal");
const { clearPendingTerminals } = await import("./terminalsQuery");

type Listed = { name: string; kind: "shell"; running: boolean };
const shell = (name: string): Listed => ({ name, kind: `shell`, running: true });

// Every panel this test has opened. A real one is always unmounted in the end (a v-if, a route, a reload), and
// an attached instance that is never detached goes on relisting into the shared storage every other case reads —
// so the teardown below is what keeps each case a clean sandbox rather than the last one's leftovers.
const opened: { detach: () => void }[] = [];

// One panel instance over a mutable session list, standing in for the daemon this sandbox happens to be.
const panel = (initial: Listed[]) => {
    let listed = initial;
    let failOnce = false;
    const list = (): Promise<Listed[]> => {
        if (failOnce) {
            failOnce = false;
            return Promise.reject(new Error(`Your sandbox isn't reachable yet`));
        }
        return Promise.resolve(listed);
    };
    const tabs = createTerminalTabs({ list, create: () => `web-new`, kill: () => Promise.resolve() }, `sandbox`, () => undefined);
    opened.push(tabs);
    return {
        tabs,
        daemonLists: (next: Listed[]) => {
            listed = next;
        },
        // The next list comes back as a rejection — a daemon that hasn't answered yet, which is what a switch
        // lands on.
        failNextList: () => {
            failOnce = true;
        },
        attach: () => tabs.attach(document.createElement(`div`)),
        names: () => tabs.order.value.map((tab) => tab.name),
    };
};

// Leaving one sandbox for another, as the app does it: every cached socket dies with the daemon it was opened
// against, and the panel that was mounted goes with the layout state of the sandbox being left.
const switchTo = (id: string): void => {
    activeSandboxId.value = id;
    disposeAllSessions();
};

beforeEach(() => {
    for (const tabs of opened.splice(0)) {
        tabs.detach();
    }
    store.clear();
    clearPendingTerminals();
    activeSandboxId.value = `sbx-a`;
});

// THE reported bug. Nothing may be on the strip that the daemon has not listed — however confidently storage
// remembers it — because a pill with no session behind it cannot be opened by clicking it.
test("coming back to a sandbox whose list has not landed yet shows no tabs at all", async () => {
    const first = panel([shell(`web-1`)]);
    await first.attach();
    expect(first.tabs.groups.value).toEqual([[`web-1`]]);
    first.tabs.detach();

    switchTo(`sbx-b`);
    switchTo(`sbx-a`);

    // The panel reopens (its open state is remembered per sandbox) and asks a daemon that is still waking.
    const back = panel([shell(`web-1`)]);
    back.failNextList();
    await expect(back.attach()).rejects.toThrow();

    expect(back.names()).toEqual([]);
    expect(back.tabs.groups.value).toEqual([]);
    expect(back.tabs.activeName.value).toBeUndefined();
});

// The other half: the arrangement is not LOST by that failure either. A list that never arrived says nothing
// about how the user had their splits, so the moment one does arrive the strip comes back as they left it.
test("the split arrangement survives a switch, and a list that failed on the way in", async () => {
    const first = panel([shell(`web-1`), shell(`web-2`), shell(`web-3`)]);
    await first.attach();
    first.tabs.joinTabs([`web-1`, `web-2`]);
    expect(first.tabs.groups.value).toEqual([[`web-1`, `web-2`], [`web-3`]]);
    first.tabs.detach();

    switchTo(`sbx-b`);
    switchTo(`sbx-a`);

    const back = panel([shell(`web-1`), shell(`web-2`), shell(`web-3`)]);
    back.failNextList();
    await expect(back.attach()).rejects.toThrow();
    expect(back.tabs.groups.value).toEqual([]);

    // The daemon answers — the panel relists when it becomes reachable (see TerminalPanel).
    await back.tabs.refresh();

    expect(back.tabs.groups.value).toEqual([[`web-1`, `web-2`], [`web-3`]]);
    expect(back.tabs.activeName.value).toBe(`web-1`);
});

// One sandbox's strip is not the other's — the arrangement is remembered per sandbox, so the shells of the one
// you left cannot tab in the one you arrive at.
test("each sandbox keeps its own strip", async () => {
    const first = panel([shell(`web-1`), shell(`web-2`)]);
    await first.attach();
    first.tabs.joinTabs([`web-1`, `web-2`]);
    first.tabs.detach();

    switchTo(`sbx-b`);

    const other = panel([shell(`web-9`)]);
    await other.attach();

    expect(other.tabs.groups.value).toEqual([[`web-9`]]);
});

// A session that ENDS while the panel is open leaves the arrangement too, so it cannot come back as a pill on
// the next list (or the next visit to this sandbox).
test("a killed session does not linger in the remembered arrangement", async () => {
    const { tabs, attach, daemonLists, names } = panel([shell(`web-1`), shell(`web-2`)]);
    await attach();
    tabs.joinTabs([`web-1`, `web-2`]);

    tabs.closeTab?.(`web-2`);
    daemonLists([shell(`web-1`)]);
    await tabs.refresh();

    expect(names()).toEqual([`web-1`]);
    expect(tabs.groups.value).toEqual([[`web-1`]]);
    expect(JSON.parse(store.get(`ui-sandbox-terminal-groups.sbx-a`) ?? `[]`)).toEqual([[`web-1`]]);
});
