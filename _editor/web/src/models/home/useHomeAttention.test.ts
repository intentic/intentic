import { waitFor } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";
import { inSetup } from "../../testing/inSetup";
import { sandboxSummary } from "../../testing/sandboxSummary";
import { type AttentionSource, useHomeAttention } from "./useHomeAttention";

const box = (id: string) => sandboxSummary({ id, lastSeenAt: new Date(0).toISOString(), daemonUrl: `https://${id}.test` });
const sourceOf = () => ({
    sandboxes: ref([box(`a`), box(`b`)]),
    activeSandboxId: ref<string | undefined>(`a`),
    reachable: ref(false),
    onScreen: ref(true),
    read: jest.fn<AttentionSource[`read`]>().mockRejectedValue(new Error(`asleep`)),
});

let stop = (): void => undefined;
afterEach(() => stop());

it(`lights the reconnected sandbox immediately and refreshes its attention without waiting for the poll`, async () => {
    const source = sourceOf();
    const mounted = inSetup(() => useHomeAttention({ everyMs: 60_000 }, source));
    stop = mounted.stop;
    const readings = mounted.result;
    await waitFor(() => expect(readings.value.get(`a`)).toEqual({ needsYou: undefined, unreachable: true }));

    const refreshed = Promise.withResolvers<{ needsYou: number }>();
    source.read.mockReturnValue(refreshed.promise);
    source.reachable.value = true;
    await nextTick();

    expect(readings.value.get(`a`)).toEqual({ needsYou: undefined, unreachable: false });
    expect(readings.value.get(`b`)).toEqual({ needsYou: undefined, unreachable: true });
    expect(source.read.mock.calls).toEqual([[`a`], [`b`], [`a`]]);
    refreshed.resolve({ needsYou: 3 });
    await waitFor(() => expect(readings.value.get(`a`)).toEqual({ needsYou: 3, unreachable: false }));
});

it(`keeps a live sandbox lit when a request from before its wake fails late`, async () => {
    const source = sourceOf();
    const stale = Promise.withResolvers<{ needsYou: number }>();
    source.read.mockReturnValue(stale.promise);
    const mounted = inSetup(() => useHomeAttention({ everyMs: 60_000 }, source));
    stop = mounted.stop;

    source.reachable.value = true;
    await nextTick();
    stale.reject(new Error(`old connection closed`));
    await waitFor(() => expect(mounted.result.value.get(`b`)).toEqual({ needsYou: undefined, unreachable: true }));
    expect(mounted.result.value.get(`a`)).toEqual({ needsYou: undefined, unreachable: false });
    expect(source.read.mock.calls).toEqual([[`a`], [`b`]]);

    source.activeSandboxId.value = `b`;
    await nextTick();
    expect(mounted.result.value.get(`a`)).toEqual({ needsYou: undefined, unreachable: true });
    expect(mounted.result.value.get(`b`)).toEqual({ needsYou: undefined, unreachable: false });
});

it(`preserves the last attention count when its refresh fails on a live connection`, async () => {
    const source = sourceOf();
    source.read.mockResolvedValue({ needsYou: 4 });
    const mounted = inSetup(() => useHomeAttention({ everyMs: 60_000 }, source));
    stop = mounted.stop;
    await waitFor(() => expect(mounted.result.value.get(`a`)).toEqual({ needsYou: 4, unreachable: false }));

    source.read.mockRejectedValue(new Error(`attention unavailable`));
    source.reachable.value = true;
    await waitFor(() => expect(source.read).toHaveBeenCalledTimes(3));
    expect(mounted.result.value.get(`a`)).toEqual({ needsYou: 4, unreachable: false });
});
