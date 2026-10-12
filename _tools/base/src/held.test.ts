import { BoundedMap, cachedAsync, freshness, held } from "./held.js";

const clock = () => {
    let at = 1_000;
    return {
        now: (): number => at,
        advance: (ms: number): void => {
            at += ms;
        },
    };
};

describe("freshness", () => {
    it("is stale until taken, fresh until the bound, and stale again on a reported change", () => {
        const time = clock();
        const reading = freshness({ maxAgeMs: 10, now: time.now });
        expect(reading.fresh()).toBe(false);
        reading.taken();
        time.advance(10);
        expect(reading.fresh()).toBe(true);
        time.advance(1);
        expect(reading.fresh()).toBe(false);
        reading.taken();
        reading.changed();
        expect(reading.fresh()).toBe(false);
    });
});

describe("held", () => {
    it("reads once per key while the feed is quiet, and again past the bound", () => {
        const time = clock();
        const readings = held<string, number>({ maxAgeMs: 10, now: time.now });
        let reads = 0;
        const read = (): number => ++reads;
        expect([readings.get("a", read), readings.get("a", read)]).toEqual([1, 1]);
        time.advance(11);
        expect(readings.get("a", read)).toBe(2);
    });

    it("reads again for a key the feed named, and for every key after an unnamed change", () => {
        const time = clock();
        const readings = held<string, string>({ maxAgeMs: 10_000, now: time.now });
        readings.get("a", () => "a1");
        readings.get("b", () => "b1");
        readings.drop("a");
        expect([readings.get("a", () => "a2"), readings.get("b", () => "b2")]).toEqual(["a2", "b1"]);
        readings.clear();
        expect(readings.get("b", () => "b3")).toBe("b3");
    });

    it("lets go of a key nobody asks for again once it is past the bound", () => {
        const time = clock();
        const readings = held<string, number>({ maxAgeMs: 10, now: time.now });
        readings.get("gone", () => 1);
        time.advance(11);
        readings.get("other", () => 2);
        expect(readings.size()).toBe(1);
    });
});

describe("BoundedMap", () => {
    it("drops the least recently written key past its limit", () => {
        const map = new BoundedMap<string, number>(2);
        map.set("a", 1).set("b", 2).set("a", 3).set("c", 4);
        expect([...map.entries()]).toEqual([
            ["a", 3],
            ["c", 4],
        ]);
    });
});

describe("cachedAsync", () => {
    const deferred = <T>() => Promise.withResolvers<T>();

    it("shares the load in flight, then serves it until the bound", async () => {
        const time = clock();
        const cache = cachedAsync<string, number>({ ttlMs: 10, now: time.now });
        const pending = deferred<number>();
        let loads = 0;
        const load = (): Promise<number> => {
            loads += 1;
            return loads === 1 ? pending.promise : Promise.resolve(loads);
        };
        const both = Promise.all([cache.get("a", load), cache.get("a", load)]);
        pending.resolve(1);
        expect(await both).toEqual([1, 1]);
        expect(await cache.get("a", load)).toBe(1);
        expect(cache.peek("a")).toBe(1);
        time.advance(10);
        expect(cache.peek("a")).toBeUndefined();
        expect(await cache.get("a", load)).toBe(2);
        expect(loads).toBe(2);
    });

    it("never holds a failure, nor a value keep refuses", async () => {
        const cache = cachedAsync<string, number>({ ttlMs: 1_000, keep: (value) => value > 0, now: clock().now });
        await expect(cache.get("a", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
        await expect(
            cache.get("a", () => {
                throw new Error("threw");
            }),
        ).rejects.toThrow("threw");
        expect(await cache.get("a", async () => 0)).toBe(0);
        expect(cache.size()).toBe(0);
        expect(await cache.get("a", async () => 5)).toBe(5);
        expect(cache.size()).toBe(1);
    });

    it("evicts the oldest past maxEntries, and sweeps keys nobody asks for again", async () => {
        const time = clock();
        const cache = cachedAsync<string, string>({ ttlMs: 10, maxEntries: 2, now: time.now });
        for (const key of ["a", "b", "c"]) {
            await cache.get(key, async () => key);
        }
        expect([cache.peek("a"), cache.peek("b"), cache.peek("c")]).toEqual([undefined, "b", "c"]);
        time.advance(11);
        await cache.get("d", async () => "d");
        expect(cache.size()).toBe(1);
    });

    it("loads afresh when asked, and a drop keeps the load in flight from landing", async () => {
        const cache = cachedAsync<string, number>({ ttlMs: 1_000, now: clock().now });
        await cache.get("a", async () => 1);
        expect(await cache.get("a", async () => 2, { fresh: true })).toBe(2);
        const pending = deferred<number>();
        const loading = cache.get("b", () => pending.promise);
        cache.drop("b");
        pending.resolve(3);
        expect(await loading).toBe(3);
        expect(cache.peek("b")).toBeUndefined();
    });
});
