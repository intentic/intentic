import "@intentic/testing/dom";
import type { SwapVerdict } from "@intentic/sandbox-contract/state/sandbox-build";
import { advanceTimersByTimeAsync, realYield } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";
import { followSwap, forgetSwapFollows } from "./swapFollow";

afterEach(() => {
    forgetSwapFollows();
    jest.useRealTimers();
});

const following = (verdict: () => Promise<SwapVerdict>, streaming = false) => {
    const here = ref(true);
    const reachable = ref(true);
    const progress = jest.fn();
    const follow = followSwap({ here: () => here.value, reachable: () => reachable.value, verdict, streaming, progress });
    let ending: `landed` | `failed` | undefined;
    void follow.landed.then(() => { ending = `landed`; }, () => { ending = `failed`; });
    return { follow, here, reachable, progress, ending: () => ending };
};

const reconnect = async (world: ReturnType<typeof following>): Promise<void> => {
    world.reachable.value = false;
    await nextTick();
    world.reachable.value = true;
    await nextTick();
};

test(`a verdict arriving after a sandbox switch waits until that sandbox is on screen again`, async () => {
    const answer = Promise.withResolvers<SwapVerdict>();
    const verdict = jest.fn(async (): Promise<SwapVerdict> => `landed`);
    verdict.mockImplementationOnce(() => answer.promise);
    const world = following(verdict);
    await reconnect(world);
    world.here.value = false;
    await nextTick();
    answer.resolve(`landed`);
    await realYield();
    expect(world.ending()).toBe(undefined);
    world.here.value = true;
    await nextTick();
    await world.follow.landed;
    expect(verdict).toHaveBeenCalledTimes(2);
    expect(world.ending()).toBe(`landed`);
});

test(`a verdict from before another disconnect cannot fail the new connection`, async () => {
    jest.useFakeTimers();
    const answer = Promise.withResolvers<SwapVerdict>();
    const verdict = jest.fn(async (): Promise<SwapVerdict> => `landed`);
    verdict.mockImplementationOnce(() => answer.promise);
    const world = following(verdict);
    await reconnect(world);
    await reconnect(world);
    answer.resolve(`unmoved`);
    await realYield();
    expect(world.ending()).toBe(undefined);
    await advanceTimersByTimeAsync(5_000);
    await world.follow.landed;
    expect(verdict).toHaveBeenCalledTimes(2);
    expect(world.ending()).toBe(`landed`);
});

test(`stop remains terminal when an outstanding verdict answers`, async () => {
    jest.useFakeTimers();
    const answer = Promise.withResolvers<SwapVerdict>();
    const verdict = jest.fn(() => answer.promise);
    const world = following(verdict);
    await reconnect(world);
    world.follow.stop();
    const progress = world.progress.mock.calls.length;
    answer.resolve(`landed`);
    await advanceTimersByTimeAsync(10 * 60_000);
    expect(world.ending()).toBe(undefined);
    expect(verdict).toHaveBeenCalledTimes(1);
    expect(world.progress).toHaveBeenCalledTimes(progress);
    expect(jest.getTimerCount()).toBe(0);
});

test(`a stream ending cannot discard a landing answer from the current connection`, async () => {
    const answer = Promise.withResolvers<SwapVerdict>();
    const verdict = jest.fn(() => answer.promise);
    const world = following(verdict, true);
    await reconnect(world);
    world.follow.streamDied();
    answer.resolve(`landed`);
    await realYield();
    expect({ ending: world.ending(), asks: verdict.mock.calls.length }).toEqual({ ending: `landed`, asks: 1 });
});
