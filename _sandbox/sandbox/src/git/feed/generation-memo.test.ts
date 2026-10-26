import { useCheckoutFeed } from "./checkout-feed.js";
import { generationMemo } from "./generation-memo.js";

afterEach(() => { useCheckoutFeed(undefined); jest.useRealTimers(); });

test("reuses completed work, invalidates every checkout and metadata, and isolates returned values", async () => {
    const versions = new Map([["main", 1], ["copy", 1]]);
    useCheckoutFeed({ generation: async (dir) => versions.get(dir) });
    const memo = generationMemo<{ count: number }>({ maxAgeMs: 1000 });
    let reads = 0;
    const read = () => memo("review", ["main", "copy"], "base-a", async () => ({ count: ++reads }));
    (await read()).count = 100;
    expect(await read()).toEqual({ count: 1 });
    versions.set("copy", 2);
    expect(await read()).toEqual({ count: 2 });
    versions.set("main", 2);
    expect(await read()).toEqual({ count: 3 });
    expect(await memo("review", ["main", "copy"], "base-b", async () => ({ count: ++reads }))).toEqual({ count: 4 });
    versions.delete("copy");
    expect(await read()).toEqual({ count: 5 });
    expect(await read()).toEqual({ count: 6 });
});

test("shares in-flight reads, evicts failures, expires missed events and bounds retained entries", async () => {
    jest.useFakeTimers();
    useCheckoutFeed({ generation: async () => 1 });
    const memo = generationMemo<number>({ maxAgeMs: 1000, maxEntries: 1 });
    let calls = 0;
    const read = (key = "a") => memo(key, ["repo"], "", async () => ++calls);
    expect(await Promise.all([read(), read()])).toEqual([1, 1]);
    jest.advanceTimersByTime(1000);
    expect(await read()).toBe(2);
    expect(await read("b")).toBe(3);
    expect(await read()).toBe(4);
    await expect(memo("fail", ["repo"], "", async () => { throw new Error("read failed"); })).rejects.toThrow("read failed");
    expect(await read("fail")).toBe(5);
});

test("evidence that is still building refreshes even without a new filesystem generation", async () => {
    useCheckoutFeed({ generation: async () => 1 });
    const memo = generationMemo<number>({ maxAgeMs: 1000, cacheable: (value) => value !== 1 });
    let calls = 0;
    const read = () => memo("health", ["repo"], "", async () => ++calls);
    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
    expect(await read()).toBe(2);
});
