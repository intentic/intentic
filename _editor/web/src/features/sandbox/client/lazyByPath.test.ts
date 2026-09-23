import { resetSandboxScope } from "@intentic/extension-api";
import { afterEach, expect, it, mock } from "bun:test";
import { ref } from "vue";

// Pins that the cache is one sandbox's: an answer that left before a switch is not filed under the sandbox switched
// to, whose next ask fetches afresh. The daemon's address is stood in for; nothing here waits on one resolving.

mock.module("../secrets/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase: ref(`https://box-a.test`) }) }));
const { lazyByPath } = await import("./lazyByPath");

// A load held open until the test answers it, one answer per ask.
const heldLoads = () => {
    const answers: ((value: string) => void)[] = [];
    const load = mock((_path: string) => new Promise<string>((resolve) => void answers.push(resolve)));
    return { load, answer: (index: number, value: string) => answers[index]?.(value) };
};

// The answer's own handler runs a microtask after it resolves.
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

afterEach(() => {
    resetSandboxScope();
});

it(`files an answer under the path it was asked for`, async () => {
    const { load, answer } = heldLoads();
    const cache = lazyByPath(load);

    expect(cache.get(`shots/home.png`)).toBeUndefined();
    answer(0, `the home page`);
    await settle();

    expect(cache.get(`shots/home.png`)).toBe(`the home page`);
    expect(load).toHaveBeenCalledTimes(1);
});

it(`drops an answer from the sandbox left behind, and asks the next one afresh`, async () => {
    const { load, answer } = heldLoads();
    const cache = lazyByPath(load);
    cache.get(`shots/home.png`);

    resetSandboxScope();
    answer(0, `the other box's home page`);
    await settle();

    expect(cache.cached(`shots/home.png`)).toBeUndefined();
    cache.get(`shots/home.png`);
    expect(load).toHaveBeenCalledTimes(2);
});
