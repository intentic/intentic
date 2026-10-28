import { createKnownMatcher } from "../known-matcher.js";

test("tries longer matches across spelling buckets before shorter fallbacks", () => {
    const matcher = createKnownMatcher([
        { value: "id", payload: "short" },
        { value: "id-card", payload: "medium", spelling: "case" },
        { value: "id-card-tag", payload: "long", spelling: "folded" },
    ]);
    const tried: string[] = [];
    const found = matcher.find("id-card-tag", (_start, _end, payload) => {
        tried.push(payload);
        return payload !== "long";
    });

    expect(tried).toEqual(["long", "medium"]);
    expect(found).toEqual([{ start: 0, end: 7, payload: "medium" }]);
});

test("equal lengths keep spelling order, then insertion order within a bucket", () => {
    const matcher = createKnownMatcher([
        { value: "ABC", payload: "folded", spelling: "folded" },
        { value: "ABC", payload: "case", spelling: "case" },
        { value: "ABC", payload: "first exact" },
        { value: "ABC", payload: "second exact" },
    ]);
    const tried: string[] = [];

    expect(
        matcher.find("ABC", (_start, _end, payload) => {
            tried.push(payload);
            return payload === "folded";
        }),
    ).toEqual([{ start: 0, end: 3, payload: "folded" }]);
    expect(tried).toEqual(["first exact", "second exact", "case", "folded"]);
});

test("a longer value wins within one shared prefix and suppresses overlapping words", () => {
    const matcher = createKnownMatcher([
        { value: "unit", payload: "short", spelling: "folded" },
        { value: "unit part", payload: "long", spelling: "folded" },
        { value: "part", payload: "overlap" },
    ]);

    expect(matcher.find("unit part; unit")).toEqual([
        { start: 0, end: 9, payload: "long" },
        { start: 11, end: 15, payload: "short" },
    ]);
});

test("short prefix buckets, leading punctuation and JSON escape boundaries remain searchable", () => {
    const matcher = createKnownMatcher([
        { value: "A", payload: "one" },
        { value: "AB", payload: "two" },
        { value: "+ABC", payload: "lead" },
        { value: "ABC", payload: "three" },
    ]);
    const text = "A AB +ABC \\nABC ABCD";

    expect(matcher.find(text).map(({ start, end, payload }) => [text.slice(start, end), payload])).toEqual([
        ["A", "one"],
        ["AB", "two"],
        ["+ABC", "lead"],
        ["ABC", "three"],
    ]);
});

test("a rejected candidate does not consume its word or the rest of its prefix bucket", () => {
    const matcher = createKnownMatcher([
        { value: "unit long", payload: "long", spelling: "folded" },
        { value: "unit", payload: "short", spelling: "folded" },
        { value: "long", payload: "next" },
    ]);

    expect(matcher.find("unit long", (_start, _end, payload) => payload !== "long")).toEqual([
        { start: 0, end: 4, payload: "short" },
        { start: 5, end: 9, payload: "next" },
    ]);
});
