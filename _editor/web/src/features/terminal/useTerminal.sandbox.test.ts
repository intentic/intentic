// @vitest-environment jsdom
// Pins that the strip never shows a pill with no session behind it across a sandbox switch, even though the remembered
// arrangement returns instantly and the session list arrives late. Pane mocked wholesale; no real terminal needed.
import { beforeEach, expect, test, vi } from "vitest";
import { nextTick, ref } from "vue";

const store = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
});

// The switch itself: the one ref the whole app scopes by.
const activeSandboxId = ref<string | undefined>(`sbx-a`);
vi.mock("../sandbox/overview/activeSandbox", () => ({
    ACTIVE_KEY: `intentic.activeSandboxId`,
    activeSandboxId,
    sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId],
}));
vi.mock("../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/client/useSandbox", () => ({
    useSandbox: () => ({ reachable: ref(true), activeSandboxId }),
}));
vi.mock("./terminalSession", () => ({
    createTerminalSession: (name: string) => ({ kind: `terminal`, name }),
    mountTerminalSession: vi.fn(),
    parkTerminalSession: vi.fn(),
    disposeTerminalSession: vi.fn(),
}));

const { createTerminalTabs, disposeAllSessions } = await import("./useTerminal");
const { clearPendingTerminals } = await import("./terminalsQuery");

type Listed = { name: string; kind: "shell"; running: boolean; activityAt: number };
const shell = (name: string): Listed => ({ name, kind: `shell`, running: true, activityAt: Date.now() });

// Every panel opened so far; detached in teardown so a leftover instance doesn't relist into shared storage.
const opened: { detach: () => void }[] = [];

// One panel instance over a mutable session list, standing in for this sandbox's daemon.
const panel = (initial: Listed[]) => {
    let listed = initial;
    let failures = 0;
    let asked = 0;
    const list = (): Promise<Listed[]> => {
        asked += 1;
        if (failures > 0) {
            failures -= 1;
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
        // Next N lists come back as rejections, modeling a daemon that hasn't answered yet.
        failNextLists: (count = 1) => {
            failures = count;
        },
        asked: () => asked,
        attach: () => tabs.attach(document.createElement(`div`)),
        names: () => tabs.order.value.map((tab) => tab.name),
    };
};

// Switches sandboxes as the app does: the active id moves first, then the left sandbox's sockets are torn down.
const switchTo = (id: string): void => {
    activeSandboxId.value = id;
    disposeAllSessions();
};

beforeEach(() => {
    for (const tabs of opened.splice(0)) {
        tabs.detach();
    }
    // Session cache outlives any instance, so a case that never switched away would leak shells into the next one.
    disposeAllSessions();
    store.clear();
    clearPendingTerminals();
    activeSandboxId.value = `sbx-a`;
});

// No pill exists without a session behind it, however confidently storage remembers one.
test("coming back to a sandbox whose list has not landed yet shows no tabs at all", async () => {
    const first = panel([shell(`web-1`)]);
    await first.attach();
    expect(first.tabs.groups.value).toEqual([[`web-1`]]);
    first.tabs.detach();

    switchTo(`sbx-b`);
    switchTo(`sbx-a`);

    // Reopens (its open state is remembered per sandbox) and asks a daemon still waking up.
    const back = panel([shell(`web-1`)]);
    back.failNextLists();
    await expect(back.attach()).resolves.toBe(false);

    expect(back.names()).toEqual([]);
    expect(back.tabs.groups.value).toEqual([]);
    expect(back.tabs.activeName.value).toBeUndefined();
});

// A failed list says nothing about the splits, so they return unchanged once one arrives.
test("the split arrangement survives a switch, and a list that failed on the way in", async () => {
    const first = panel([shell(`web-1`), shell(`web-2`), shell(`web-3`)]);
    await first.attach();
    first.tabs.joinTabs([`web-1`, `web-2`]);
    expect(first.tabs.groups.value).toEqual([[`web-1`, `web-2`], [`web-3`]]);
    first.tabs.detach();

    switchTo(`sbx-b`);
    switchTo(`sbx-a`);

    const back = panel([shell(`web-1`), shell(`web-2`), shell(`web-3`)]);
    back.failNextLists();
    await expect(back.attach()).resolves.toBe(false);
    expect(back.tabs.groups.value).toEqual([]);

    // Daemon answers on the next ask.
    await back.tabs.refresh();

    expect(back.tabs.groups.value).toEqual([[`web-1`, `web-2`], [`web-3`]]);
    expect(back.tabs.activeName.value).toBe(`web-1`);
});

// A refused list is the one failure nothing else recovers from; everything else reacts to a list that arrived.
test("a list refused on the way in is asked again, and the terminals arrive on their own", async () => {
    vi.useFakeTimers();
    try {
        const back = panel([shell(`web-1`), shell(`web-2`)]);
        back.failNextLists();
        await expect(back.attach()).resolves.toBe(false);
        expect(back.names()).toEqual([]);

        await vi.advanceTimersByTimeAsync(600);

        expect(back.names()).toEqual([`web-1`, `web-2`]);
        expect(back.tabs.groups.value).toEqual([[`web-1`], [`web-2`]]);
        expect(back.tabs.activeName.value).toBe(`web-1`);
    } finally {
        vi.useRealTimers();
    }
});

// Few, spaced tries; after that, only the strip's own refresh or the daemon's next frame retries.
test("the re-asking is bounded", async () => {
    vi.useFakeTimers();
    try {
        const back = panel([shell(`web-1`)]);
        back.failNextLists(99);
        await expect(back.attach()).resolves.toBe(false);

        await vi.advanceTimersByTimeAsync(60_000);

        // Attach's own list plus a handful of retries, not a poll forever.
        expect(back.asked()).toBe(4);
    } finally {
        vi.useRealTimers();
    }
});

// A retry on a torn-down panel could steal a session's host from whatever replaced it.
test("the re-asking stops when the panel closes", async () => {
    vi.useFakeTimers();
    try {
        const back = panel([shell(`web-1`)]);
        back.failNextLists(99);
        await expect(back.attach()).resolves.toBe(false);
        const asked = back.asked();

        back.tabs.detach();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(back.asked()).toBe(asked);
    } finally {
        vi.useRealTimers();
    }
});

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

// An empty strip means three different things: nothing here, not asked yet, or asked and got nothing; each must be
// sayable.
test("an empty strip says whether this sandbox has actually answered", async () => {
    const { tabs, attach } = panel([shell(`web-1`)]);
    expect(tabs.answer.value).toBe(`waiting`);

    await attach();
    expect(tabs.answer.value).toBe(`arrived`);

    // Arriving somewhere new says nothing about whether the new place has answered yet.
    tabs.detach();
    switchTo(`sbx-b`);
    await nextTick();

    expect(tabs.answer.value).toBe(`waiting`);
});

test("a sandbox that never answers is reported as such, not as empty", async () => {
    vi.useFakeTimers();
    try {
        const { tabs, attach, failNextLists } = panel([shell(`web-1`)]);
        failNextLists(99);
        await expect(attach()).resolves.toBe(false);
        expect(tabs.answer.value).toBe(`waiting`);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(tabs.answer.value).toBe(`refused`);
    } finally {
        vi.useRealTimers();
    }
});

test("the strip the sandbox was left with is offered as shapes, before any session is listed", async () => {
    const first = panel([shell(`web-1`), shell(`web-2`), shell(`web-3`)]);
    await first.attach();
    first.tabs.joinTabs([`web-1`, `web-2`]);
    first.tabs.detach();

    switchTo(`sbx-b`);
    switchTo(`sbx-a`);

    const back = panel([shell(`web-1`), shell(`web-2`), shell(`web-3`)]);
    // Nothing listed yet: two shapes, a wide one for the split pair, then a single.
    expect(back.tabs.groups.value).toEqual([]);
    expect(back.tabs.remembered.value).toEqual([[`web-1`, `web-2`], [`web-3`]]);

    await back.attach();
    expect(back.tabs.groups.value).toEqual([[`web-1`, `web-2`], [`web-3`]]);
});

test("a killed session does not linger in the remembered arrangement", async () => {
    const { tabs, attach, daemonLists, names } = panel([shell(`web-1`), shell(`web-2`)]);
    await attach();
    tabs.joinTabs([`web-1`, `web-2`]);

    tabs.killTabs?.([`web-2`]);
    daemonLists([shell(`web-1`)]);
    await tabs.refresh();

    expect(names()).toEqual([`web-1`]);
    expect(tabs.groups.value).toEqual([[`web-1`]]);
    expect(JSON.parse(store.get(`ui-sandbox-terminal-groups.sbx-a`) ?? `[]`)).toEqual([[`web-1`]]);
});
