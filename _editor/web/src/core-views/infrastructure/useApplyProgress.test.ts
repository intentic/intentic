// Following an apply's events stream. These pin when the stream is let go of: the moment the run is known to be over
// or the view following it goes away, not on whatever line the stream happens to read next, nor never.
import { waitFor } from "@intentic/testing/bun";
import { effectScope, nextTick, ref } from "vue";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

const APPLY_SESSION = `panel-infra-apply`;
const sessions = ref<{ readonly name: string; readonly running: boolean }[]>([]);
// The signal each attach opened its stream with.
const streams: AbortSignal[] = [];
// The daemon's tail as a run in progress holds it: open, saying nothing, until its request is aborted.
const applyEvents = jest.fn(async (_input: unknown, options?: { readonly signal?: AbortSignal }): Promise<AsyncIterable<unknown>> => {
    const signal = options?.signal ?? new AbortController().signal;
    streams.push(signal);
    return (async function* () {
        await new Promise<never>((_resolve, reject) => signal.addEventListener(`abort`, () => reject(signal.reason), { once: true }));
        yield undefined;
    })();
});

jest.mock("../../client/sandbox/sandboxRpc", () => ({
    // SAFETY: the suite answers the two procedures the view calls; their option and answer types are waived here only.
    sandboxRpc: fakeSandboxRpc({ intentic: { apply: (async () => ({})) as never, applyEvents: applyEvents as never } }),
}));
jest.mock("@tanstack/vue-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
jest.mock("../../features/terminal/terminalsQuery", () => ({ useTerminalsQuery: () => ({ sessions }), listTerminals: async () => sessions.value }));
jest.mock("../../features/terminal/useTerminalPanel", () => ({ useTerminalPanel: () => ({ openFocused: () => undefined }) }));

const { useApplyProgress } = await import("./useApplyProgress");

beforeEach(() => {
    sessions.value = [];
    streams.length = 0;
});

it(`lets go of the run's events stream the moment the view following it goes away`, async () => {
    const scope = effectScope();
    const progress = scope.run(() => useApplyProgress());
    await progress?.launch();
    await waitFor(() => expect(streams).toHaveLength(1));

    scope.stop();

    expect(streams[0]?.aborted).toBe(true);
});

it(`lets go of the stream at once when the terminals list shows the run ended, not on its next line`, async () => {
    const scope = effectScope();
    const progress = scope.run(() => useApplyProgress());
    await progress?.launch();
    await waitFor(() => expect(streams).toHaveLength(1));

    sessions.value = [{ name: APPLY_SESSION, running: true }];
    await nextTick();
    sessions.value = [];
    await nextTick();

    expect(progress?.applying.value).toBe(false);
    expect(streams[0]?.aborted).toBe(true);
    scope.stop();
});
