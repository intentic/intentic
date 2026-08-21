// @vitest-environment jsdom
//
// jsdom because the rail's badge is only reachable through a component: useQuery injects, so there has to be an
// app to mount. The rest of the suite stays on `node`.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

/* The rail's terminal badge and the panel's tab strip are the same list, and these tests are why they can't
 * drift apart. Two things break that: a `web-*` shell exists in tmux only once its socket has connected, so for
 * the length of that handshake the daemon does not list a tab the user is already looking at; and a kill is
 * true the moment it is issued, long before the DELETE lands. Both used to resolve the wrong way: the badge
 * trailing the strip by a poll interval, and a list taken mid-handshake DROPPING the new tab out from under a
 * live session. */

vi.stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ reachable: ref(true) }),
}));

const { sandboxJson } = await import("../sandbox/sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../queryPersistence");
const { addPendingTerminal, clearPendingTerminals, dropPendingTerminal, listTerminals, refreshTerminals, removeTerminal, useTerminalsQuery } =
    await import("./terminalsQuery");
const { useTerminalActivity } = await import("./useTerminalActivity");

// `activityAt` is part of every session the daemon lists (TerminalSessionSchema): 0 stands for "tmux didn't
// say", which is all these cases need: nothing here reads the clock.
const shell = (name: string, running = true) => ({ name, kind: `shell` as const, running, activityAt: 0 });

// What GET /system/terminals answers, plus a count of how many times it was actually asked.
let reads = 0;
const daemonLists = (...frames: ReturnType<typeof shell>[][]): void => {
    reads = 0;
    jsonMock.mockImplementation(() => {
        const sessions = frames[Math.min(reads, frames.length - 1)] ?? [];
        reads += 1;
        return Promise.resolve({ sessions }) as Promise<never>;
    });
};

// Mount a throwaway component so the composable runs with vue-query's injection in place.
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

    // Retired for good: a later list that has lost the session (killed elsewhere) must not resurrect it.
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

    // The click: the tab is on the strip now, and the daemon still knows nothing about it.
    addPendingTerminal(shell(`web-new`));

    expect(activity.count.value).toBe(2);
    expect(activity.summary.value).toBe(`2 shells`);
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

    // The strip relisting off the read it just reacted to is served from that read, not echoed at the daemon.
    await listTerminals();
    expect(reads).toBe(1);

    // A kill's confirmation is the exception: it must not read the list that still contains what it killed.
    await refreshTerminals();
    await listTerminals();
    expect(reads).toBe(2);
});
