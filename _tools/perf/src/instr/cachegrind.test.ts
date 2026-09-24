import { parseInstructions } from "./cachegrind.js";
import { spread } from "./spread.js";

describe("parseInstructions", () => {
    it("reads cachegrind's summary line", () => {
        const stderr = ["==412== Cachegrind, a high-precision tracing profiler", "==412== ", "==412== I refs:        447,169,624", ""].join("\n");
        expect(parseInstructions(stderr)).toBe(447_169_624);
    });

    it("has no count for a run that died before its summary", () => {
        expect(parseInstructions("==412== Cachegrind\nSegmentation fault\n")).toBeUndefined();
    });
});

describe("spread", () => {
    it("is the range as a share of the smallest", () => {
        expect(spread([1_000_000, 1_000_002, 1_000_001])).toEqual({ min: 1_000_000, max: 1_000_002, relative: 2e-6 });
    });
});
