import { defineSlice, distinctMembers, stopsOf } from "./slice.js";

interface Counter {
    readonly count: () => number;
}

describe("leaf slices", () => {
    test("distinct members pass, and a member two slices build throws naming both", () => {
        expect(() => distinctMembers([["aSlice", ["a"]], ["bSlice", ["b"]]], ["config"])).not.toThrow();
        expect(() => distinctMembers([["aSlice", ["a", "shared"]], ["bSlice", ["shared"]]], [])).toThrow(
            "composition: shared is built by both aSlice and bSlice",
        );
    });

    test("a member the core already holds throws", () => {
        expect(() => distinctMembers([["aSlice", ["logger"]]], ["config", "logger"])).toThrow(
            "composition: logger is built by both the composition core and aSlice",
        );
    });

    test("a slice with a stop tears down through it, and one without adds nothing", () => {
        const stopped: number[] = [];
        const counter: Counter = { count: () => 3 };
        const stopping = defineSlice<Counter, Record<never, never>>({ build: () => counter, stop: (members) => void stopped.push(members.count()) });
        const still = defineSlice<Counter, Record<never, never>>({ build: () => counter });
        expect(stopsOf(still, counter)).toEqual([]);
        const entries = stopsOf(stopping, stopping.build({}));
        expect(entries).toHaveLength(1);
        for (const entry of entries) {
            void entry();
        }
        expect(stopped).toEqual([3]);
    });
});
