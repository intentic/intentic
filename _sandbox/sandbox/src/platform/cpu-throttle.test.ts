import { describe, expect, it } from "vitest";
import { parseCpuStat, readCpuThrottle } from "./cpu-throttle.js";

describe("cpu throttle", () => {
    it("reads the two throttling counters off a cgroup v2 cpu.stat", () => {
        const stat = [
            "usage_usec 123456789",
            "user_usec 100",
            "system_usec 200",
            "nr_periods 4000",
            "nr_throttled 1200",
            "throttled_usec 95000000",
            "",
        ].join("\n");
        expect(parseCpuStat(stat)).toEqual({ throttledMs: 95_000, throttledPeriods: 1200 });
    });

    it("answers nothing, never zero, for a file that does not carry them", () => {
        expect(parseCpuStat("usage_usec 1\n")).toBeUndefined();
        expect(readCpuThrottle("/nonexistent/cpu.stat")).toBeUndefined();
    });
});
