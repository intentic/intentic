// @vitest-environment jsdom
// jsdom: both composables under test need an app mounted since useQuery injects.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { beforeEach, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

// Pins two halves of hiding work by default: the popover lists running work only, named by owning conversation, newest
// first; the rail badge stops counting what the strip stopped tabbing.

const store = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
});
vi.mock("../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../sandbox/client/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ reachable: ref(true) }),
}));

const { sandboxJson } = await import("../sandbox/client/sandboxClient");
const jsonMock = vi.mocked(sandboxJson);
const { queryClient } = await import("../../lib/queryPersistence");
const { clearPendingTerminals } = await import("./terminalsQuery");
const { noteAgentTerminal, showWorkTerminals, useWorkTerminals } = await import("./useWorkTerminals");
const { useTerminalActivity } = await import("./useTerminalActivity");

const HOUR = 3_600_000;
const agent = (id: string, running = true, extra: { exitCode?: number; activityAt?: number } = {}) => ({
    name: `agent-${id}`,
    label: id,
    kind: `agent` as const,
    running,
    activityAt: extra.activityAt ?? 0,
    ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
});
const job = (key: string, running = true, extra: { exitCode?: number; activityAt?: number } = {}) => ({
    name: `job-${key}`,
    label: key,
    kind: `job` as const,
    running,
    activityAt: extra.activityAt ?? 0,
    ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
});
const shell = (name: string) => ({ name, kind: `shell` as const, running: true, activityAt: 0 });

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
    showWorkTerminals.value = false;
    vi.resetAllMocks();
});

test("the popover lists the agent's shells AND the daemon's jobs, named after the conversation that owns them", async () => {
    daemonLists(shell(`web-1`), agent(`aaaa1111`), agent(`bbbb2222`), job(`capability-demo`));
    noteAgentTerminal(`agent-aaaa1111`, `Redesign the chat rail`);

    const { rows } = mounted(() => useWorkTerminals());
    await vi.waitFor(() => expect(rows.value).toHaveLength(3));

    // The user's own shell is not work; it keeps its tab.
    expect(rows.value.map((row) => row.session)).not.toContain(`web-1`);
    expect(rows.value.map((row) => [row.name, row.kind])).toContainEqual([`capability-demo`, `job`]);
    expect(rows.value.map((row) => row.name)).toContain(`Redesign the chat rail`);
});

test("work that has exited is not listed, whether it succeeded or failed", async () => {
    const now = Date.now();
    daemonLists(
        agent(`aaaa1111`, false, { exitCode: 0, activityAt: now - 10 * 60_000 }),
        job(`infra-check`, false, { exitCode: 1, activityAt: now - 3 * HOUR }),
        job(`capability-demo`, true),
    );

    const { rows } = mounted(() => useWorkTerminals());
    await vi.waitFor(() => expect(rows.value.map((row) => row.session)).toEqual([`job-capability-demo`]));
});

test("whatever spoke last is on top: the only ordering that says anything once every row is alive", async () => {
    const now = Date.now();
    daemonLists(
        job(`capability-demo`, true, { activityAt: now - 20 * 60_000 }),
        agent(`aaaa1111`, true, { activityAt: now - 60_000 }),
        job(`infra-check`, true, { activityAt: now - 5 * 60_000 }),
    );

    const { rows } = mounted(() => useWorkTerminals());
    await vi.waitFor(() => expect(rows.value).toHaveLength(3));

    expect(rows.value.map((row) => row.session)).toEqual([`agent-aaaa1111`, `job-infra-check`, `job-capability-demo`]);
});

test("the rail's badge stops counting work terminals while they don't tab, and counts them again once they do", async () => {
    daemonLists(shell(`web-1`), agent(`aaaa1111`), job(`capability-demo`));

    const activity = mounted(() => useTerminalActivity());
    await vi.waitFor(() => expect(activity.count.value).toBe(1));
    expect(activity.summary.value?.split(`, `)).toHaveLength(1);
    expect(activity.summary.value).toMatch(/^1 /);

    showWorkTerminals.value = true;

    expect(activity.count.value).toBe(3);
    expect(activity.summary.value?.split(`, `)).toHaveLength(3);
});

test("the preference persists per browser, so a reload doesn't hand the panel back the tabs it hid", async () => {
    showWorkTerminals.value = true;
    await nextTick();
    expect(store.get(`ui-work-terminals`)).toBe(`on`);

    showWorkTerminals.value = false;
    await nextTick();
    expect(store.get(`ui-work-terminals`)).toBe(`off`);
});
