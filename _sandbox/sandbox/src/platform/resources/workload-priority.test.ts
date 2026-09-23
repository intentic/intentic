import { childPids, daemonCgroupOf, strays } from "./workload-priority.js";

test("childPids accepts procfs whitespace and rejects anything that is not a positive integer pid", () => {
    expect(childPids(" 12  45\n91 ")).toEqual([12, 45, 91]);
    expect(childPids("0 -1 nope 3.5")).toEqual([]);
    expect(childPids("\n")).toEqual([]);
});

test("daemonCgroupOf names only the entrypoint's daemon leaf", () => {
    expect(daemonCgroupOf("0::/daemon\n")).toBe("/daemon");
    expect(daemonCgroupOf("0::/workload\n")).toBeUndefined();
    expect(daemonCgroupOf("0::/\n")).toBeUndefined();
    // cgroup v1 lines never name the unified hierarchy's path.
    expect(daemonCgroupOf("12:memory:/docker/abc\n")).toBeUndefined();
});

test("strays are every process in the daemon's cgroup but the daemon", () => {
    expect(strays("7\n120\n121\n", 7)).toEqual([120, 121]);
    expect(strays("7\n", 7)).toEqual([]);
});
