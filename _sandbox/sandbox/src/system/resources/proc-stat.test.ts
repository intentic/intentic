import { parseProcStat } from "./proc-stat.js";

test("a process on a terminal names that terminal's foreground group, the one that may read it", () => {
    const line = "5150 (cat) S 5100 5150 5100 34817 5150 4194304 120 0 0 0 0 0 0 0 20 0 1 0 900000 2400000 200";
    expect(parseProcStat(line)).toMatchObject({ pgrp: 5150, session: 5100, foreground: 5150 });
});

test("a full stat line yields the comm, both CPU counters, the start time and the resident pages", () => {
    // The shape /proc/<pid>/stat has for a node process whose comm holds a space and parentheses of its own.
    const line = "4242 (node (vite)) S 4200 4242 4242 0 -1 4194560 912 0 0 0 1310 245 37 12 20 0 11 0 885210 1224318976 17344 18446744073709551615";
    expect(parseProcStat(line)).toEqual({
        comm: "node (vite)",
        ppid: 4200,
        pgrp: 4242,
        session: 4242,
        foreground: -1,
        cpuTicks: 1555,
        childCpuTicks: 49,
        startTimeTicks: 885_210,
        rssPages: 17_344,
    });
});
