import { numberParser } from "@stricli/core";
import { expect, test } from "vitest";
import { countParser } from "./flags.js";

test("a count is a finite non-negative number", () => {
    expect(countParser("0")).toBe(0);
    expect(countParser("4000")).toBe(4000);
});

test("the three values stricli's own parser lets through are refused here", () => {
    // Guards the reason this parser exists at all: each of these is accepted by @stricli/core's numberParser.
    expect(numberParser("-5")).toBe(-5);
    expect(numberParser("Infinity")).toBe(Infinity);
    expect(() => countParser("-5")).toThrow(/non-negative/);
    expect(() => countParser("Infinity")).toThrow(/non-negative/);
    expect(() => countParser("nonsense")).toThrow(/non-negative/);
});
