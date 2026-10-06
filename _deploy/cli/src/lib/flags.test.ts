import { countAtLeast } from "./flags.js";

const atLeastOne = countAtLeast(1);

test("a whole number at or above the floor parses to itself", () => {
    expect(atLeastOne("1")).toBe(1);
    expect(atLeastOne("200")).toBe(200);
});

test.each(["NaN", "Infinity", "-5", "0", "2.5", "", " ", "ten"])('"%s" is refused with what was typed', (raw) => {
    expect(() => atLeastOne(raw)).toThrow(`expected a whole number of at least 1, got "${raw}"`);
});
