import { expect, test } from "vitest";
import { disabledOf, FEATURES, parseFeatures } from "./features.js";

test("default: everything on", () => {
    expect([...parseFeatures(undefined)]).toEqual([...FEATURES]);
    expect(disabledOf(parseFeatures(""))).toEqual([]);
});

test("allow-list: any bare token means only-these", () => {
    expect([...parseFeatures("bm25")]).toEqual(["bm25"]);
    expect([...parseFeatures("bm25,semantic")].toSorted()).toEqual(["bm25", "semantic"]);
    // Mixed tokens: bare tokens win, minus tokens are ignored under allow-list semantics.
    expect([...parseFeatures("bm25,-rerank")]).toEqual(["bm25"]);
});

test("minus-list: all-default except the named stages", () => {
    const features = parseFeatures("-rerank,-prf");
    expect(features.has("rerank")).toBe(false);
    expect(features.has("prf")).toBe(false);
    expect(features.has("bm25")).toBe(true);
    expect(disabledOf(features)).toEqual(["rerank", "prf"]);
});

test("unknown feature is a usage error", () => {
    expect(() => parseFeatures("colbert")).toThrow('unknown feature "colbert"');
    expect(() => parseFeatures("-nope")).toThrow('unknown feature "nope"');
});
