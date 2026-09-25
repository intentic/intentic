import { freshness, held } from "./held.js";

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
