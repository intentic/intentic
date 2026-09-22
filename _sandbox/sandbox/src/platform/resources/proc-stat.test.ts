import { expect, test } from "bun:test";
import { parseProcStat } from "./proc-stat.js";

test("a full stat line yields the comm, both CPU counters, the start time and the resident pages", () => {
    // The shape /proc/<pid>/stat has for a node process whose comm holds a space and parentheses of its own.
    const line = "4242 (node (vite)) S 4200 4242 4242 0 -1 4194560 912 0 0 0 1310 245 37 12 20 0 11 0 885210 1224318976 17344 18446744073709551615";
    expect(parseProcStat(line)).toEqual({
        comm: "node (vite)",
        ppid: 4200,
        pgrp: 4242,
        cpuTicks: 1555,
        childCpuTicks: 49,
        startTimeTicks: 885_210,
        rssPages: 17_344,
    });
});
