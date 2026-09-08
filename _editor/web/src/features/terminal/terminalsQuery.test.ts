// @vitest-environment jsdom
// jsdom: reaching the rail's badge means mounting a component, since useQuery injects there. The rest of the suite runs
// on node.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

// Pins that the rail's badge and the tab strip read the same shared list: a pending web-* session (socket not yet
// connected) and a kill issued but not yet confirmed both used to make the two drift.

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/client/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ reachable: ref(true) }),
}));

const { sandboxJson } = await import("../sandbox/client/sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../../lib/queryPersistence");
const { addPendingTerminal, clearPendingTerminals, dropPendingTerminal, listTerminals, refreshTerminals, removeTerminal, useTerminalsQuery } =
    await import("./terminalsQuery");
const { useTerminalActivity } = await import("./useTerminalActivity");

// activityAt 0 means tmux didn't say; fine here since no case reads the clock.
const shell = (name: string, running = true) => ({ name, kind: `shell` as const, running, activityAt: 0 });

// Scripts the daemon's list responses per call and counts how many times it was asked.
let reads = 0;
const daemonLists = (...frames: ReturnType<typeof shell>[][]): void => {
    reads = 0;
    jsonMock.mockImplementation(() => {
        const sessions = frames[Math.min(reads, frames.length - 1)] ?? [];
        reads += 1;
        return Promise.resolve({ sessions }) as Promise<never>;
    });
};

// Mounts a throwaway component so the composable runs with vue-query's injection in place.
const mounted = <T>(composable: () => T): T => {
    let result!: T;
    const app = createApp(
        defineComponent({
            setup() {
                result = composable();
                return () => h(`div`);
            },
        }),
    );
    app.use(VueQueryPlugin, { queryClient });
    app.mount(document.createElement(`div`));
    return result;
};

beforeEach(() => {
    queryClient.clear();
    clearPendingTerminals();
    vi.resetAllMocks();
});

test("a shell the daemon hasn't listed yet still lists, so a relist mid-handshake can't drop the new tab", async () => {
    daemonLists([shell(`web-old`)]);
    addPendingTerminal(shell(`web-new`));

    expect((await listTerminals()).map((session) => session.name)).toEqual([`web-old`, `web-new`]);
});

test("the claim retires as soon as the daemon names it, so the tab is never listed twice", async () => {
    daemonLists([shell(`web-new`)]);
    addPendingTerminal(shell(`web-new`));

    expect((await listTerminals()).map((session) => session.name)).toEqual([`web-new`]);

    // Retired for good: a later list missing the session must not resurrect it.
    daemonLists([]);
    await refreshTerminals();
    expect(await listTerminals()).toEqual([]);
});

test("a session that ends before the daemon ever sees it takes its claim with it", async () => {
    daemonLists([]);
    addPendingTerminal(shell(`web-new`));
    dropPendingTerminal(`web-new`);

    expect(await listTerminals()).toEqual([]);
});

test("the rail's badge counts a brand-new shell immediately, not at its next poll", async () => {
    daemonLists([shell(`web-old`)]);
    const activity = mounted(() => useTerminalActivity());
    await vi.waitFor(() => expect(activity.count.value).toBe(1));

    // The click: the tab is on the strip now, though the daemon still knows nothing about it.
    addPendingTerminal(shell(`web-new`));

    expect(activity.count.value).toBe(2);
    expect(activity.summary.value).toMatch(/^2 /);
});

test("a kill drops off the badge when it is issued, not a daemon round-trip later", async () => {
    daemonLists([shell(`web-a`), shell(`web-b`)]);
    const activity = mounted(() => useTerminalActivity());
    await vi.waitFor(() => expect(activity.count.value).toBe(2));

    removeTerminal(`web-a`);

    expect(activity.count.value).toBe(1);
});

test("the panel's relists share the badge's cache entry rather than re-asking the daemon per surface", async () => {
    daemonLists([shell(`web-a`)]);
    const activity = mounted(() => useTerminalsQuery());
    await vi.waitFor(() => expect(activity.sessions.value).toHaveLength(1));
    expect(reads).toBe(1);

    // The strip's relist here is served from the read it just reacted to, not echoed at the daemon.
    await listTerminals();
    expect(reads).toBe(1);

    // A kill's confirmation is the exception: it must not read the list that still contains what it killed.
    await refreshTerminals();
    await listTerminals();
    expect(reads).toBe(2);
});
