// @vitest-environment jsdom
//
// jsdom because both surfaces under test are only reachable through a component: useQuery injects, so there has
// to be an app to mount (see terminalsQuery.test.ts, same reason).
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

/* The agent's shells are hidden by default, and these tests hold the two halves of that honest: the popover has
 * to LIST what the strip is no longer tabbing (naming the conversation that owns it, live turns first), and the
 * rail's badge has to stop counting what the panel stopped showing — a badge reading 3 over a strip showing 1 is
 * the exact drift terminalsQuery exists to prevent. */

const store = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
});
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ reachable: ref(true) }),
}));

const { sandboxJson } = await import("../sandbox/sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../queryPersistence");
const { clearPendingTerminals } = await import("./terminalsQuery");
const { clearFinishedAgentTerminals, noteAgentTerminal, showAgentTerminals, useAgentTerminals } = await import("./useAgentTerminals");
const { useTerminalActivity } = await import("./useTerminalActivity");

const agent = (id: string, running = true) => ({ name: `agent-${id}`, label: id, kind: `agent` as const, running });
const shell = (name: string) => ({ name, kind: `shell` as const, running: true });

const daemonLists = (...sessions: { name: string }[]): void => {
    jsonMock.mockImplementation(() => Promise.resolve({ sessions }) as Promise<never>);
};

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
    showAgentTerminals.value = false;
    vi.resetAllMocks();
});

test("the popover lists the agent's shells alone, live turns first, named after the conversation that owns them", async () => {
    daemonLists(shell(`web-1`), agent(`aaaa1111`, false), agent(`bbbb2222`));
    noteAgentTerminal(`agent-aaaa1111`, `Redesign the chat rail`);

    const { rows } = mounted(() => useAgentTerminals());
    await vi.waitFor(() => expect(rows.value).toHaveLength(2));

    expect(rows.value.map((row) => [row.name, row.running])).toEqual([
        [`bbbb2222`, true],
        [`Redesign the chat rail`, false],
    ]);
});

test("the rail's badge stops counting agent shells while they don't tab, and counts them again once they do", async () => {
    daemonLists(shell(`web-1`), agent(`aaaa1111`));

    const activity = mounted(() => useTerminalActivity());
    await vi.waitFor(() => expect(activity.count.value).toBe(1));
    expect(activity.summary.value).toBe(`1 shell`);

    showAgentTerminals.value = true;

    expect(activity.count.value).toBe(2);
    expect(activity.summary.value).toBe(`1 shell, 1 agent shell`);
});

test("the sweep takes the finished turns' shells and leaves the running one alone", async () => {
    daemonLists(shell(`web-1`), agent(`aaaa1111`, false), agent(`bbbb2222`), agent(`cccc3333`, false));

    const { rows } = mounted(() => useAgentTerminals());
    await vi.waitFor(() => expect(rows.value).toHaveLength(3));

    await clearFinishedAgentTerminals(rows.value);

    // One DELETE per finished shell, and the running one is untouched (its kill would take the agent's command).
    const killed = jsonMock.mock.calls
        .filter(([, options]) => (options as { method?: string } | undefined)?.method === `DELETE`)
        .map(([route]) => route);
    expect(killed.toSorted()).toEqual([`/system/terminals/agent-aaaa1111`, `/system/terminals/agent-cccc3333`]);
});

test("the preference persists per browser, so a reload doesn't hand the panel back the tabs it hid", async () => {
    showAgentTerminals.value = true;
    await nextTick();
    expect(store.get(`ui-agent-terminals`)).toBe(`on`);

    showAgentTerminals.value = false;
    await nextTick();
    expect(store.get(`ui-agent-terminals`)).toBe(`off`);
});
