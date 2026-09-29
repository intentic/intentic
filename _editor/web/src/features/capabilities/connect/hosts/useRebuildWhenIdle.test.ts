// The page's half of "rebuild when they're idle": the wait is the sandbox's, so this only asks, withdraws, and keeps
// re-reading /environment while one is under way, since nothing else tells the page when the sandbox moves it along.
import "@intentic/testing/dom";
import type { Environment } from "@intentic/sandbox-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, nextTick, ref } from "vue";

const state = ref<Environment | undefined>(undefined);
const refetch = jest.fn(async (): Promise<void> => undefined);
jest.mock(`../../../sandbox/environment/useEnvironment`, () => ({
    ENVIRONMENT_KEY: [`environment`],
    useEnvironment: () => ({ state, query: { refetch } }),
}));
const written: unknown[] = [];
jest.mock(`@tanstack/vue-query`, () => ({ useQueryClient: () => ({ setQueryData: (_key: unknown, value: unknown) => written.push(value) }) }));
const sandboxJson = jest.fn(async (_path: string, _init?: RequestInit): Promise<Environment> => ({ waitsForAgents: true }));
jest.mock(`../../../sandbox/client/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

const { useRebuildWhenIdle } = await import("./useRebuildWhenIdle");

let app: App | undefined;
const use = (): ReturnType<typeof useRebuildWhenIdle> => {
    let used: ReturnType<typeof useRebuildWhenIdle> | undefined;
    app = createApp(
        defineComponent({
            setup: () => {
                used = useRebuildWhenIdle();
                return () => null;
            },
        }),
    );
    app.mount(document.createElement(`div`));
    return used!;
};

afterEach(() => {
    jest.useRealTimers();
    app?.unmount();
    app = undefined;
    state.value = undefined;
    refetch.mockClear();
    sandboxJson.mockClear();
    written.length = 0;
});

it(`asks the sandbox to hold the rebuild, and withdraws it, taking the environment it answers with`, async () => {
    const idle = use();
    await idle.ask(`rog`, `approved`);
    expect(sandboxJson).toHaveBeenCalledWith(`/environment/rebuild-when-idle`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ host: `rog`, hash: `approved` }),
    });
    await idle.cancel();
    expect(sandboxJson).toHaveBeenLastCalledWith(`/environment/rebuild-when-idle`, { method: `DELETE` });
    expect(written).toEqual([{ waitsForAgents: true }, { waitsForAgents: true }]);
});

it(`offers the wait only where the sandbox says it can`, () => {
    const idle = use();
    expect(idle.supported.value).toBe(false);
    state.value = { waitsForAgents: true };
    expect(idle.supported.value).toBe(true);
});

it(`re-reads the environment while a rebuild waits or runs, and stops once it is settled`, async () => {
    jest.useFakeTimers();
    use();
    await advanceTimersByTimeAsync(10_000);
    expect(refetch).not.toHaveBeenCalled();

    state.value = { waitsForAgents: true, rebuildWhenIdle: { host: `rog`, hash: `approved`, requestedAt: 1, phase: `waiting`, waitingOn: [`Build the API`] } };
    await nextTick();
    await advanceTimersByTimeAsync(10_000);
    expect(refetch).toHaveBeenCalledTimes(2);

    state.value = { waitsForAgents: true };
    await nextTick();
    await advanceTimersByTimeAsync(10_000);
    expect(refetch).toHaveBeenCalledTimes(2);
});
