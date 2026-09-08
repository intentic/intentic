import { expect, test } from "vitest";
import { leftoverProcesses, ownerOf, type ScannedProcess, WORKLOAD_ENV, workloadStamp } from "./leftovers.js";
import { parseProcStat } from "../resources/proc-stat.js";

const environ = (...pairs: string[]): string => `${pairs.join("\0")}\0`;

// A process tree: the CLI, an MCP server under it, and a browser under that, sharing one process group and owner.
const tree = (owner: string, pgrp = 7): ScannedProcess[] => [
    { pid: 100, ppid: 1, pgrp, owner },
    { pid: 101, ppid: 100, pgrp, owner },
    { pid: 102, ppid: 101, pgrp, owner },
];

// Default policy: this daemon's own group, none of its work still live, no registry entries.
const policy = (overrides: Partial<Parameters<typeof leftoverProcesses>[1]> = {}) => ({
    group: 7,
    ownerLive: () => false,
    ownerKnown: () => false,
    panePids: new Set<number>(),
    ...overrides,
});

test("the stamp says whose work it is and nothing else: no daemon identity to misread", () => {
    expect(workloadStamp("conv:with:colons")).toEqual({ [WORKLOAD_ENV]: "conv:with:colons" });
    expect(WORKLOAD_ENV).not.toBe("INTENTIC_WORKLOAD");
});

test("the owner is read out of a NUL-separated environ and ignores every other variable", () => {
    expect(ownerOf(environ("PATH=/usr/bin", `${WORKLOAD_ENV}=conv-1`, "HOME=/root"))).toBe("conv-1");
    expect(ownerOf(environ("PATH=/usr/bin"))).toBeUndefined();
});

test("ppid and pgrp are read from after the last paren, so an executable named with spaces and parens cannot shift them", () => {
    expect(parseProcStat("42 (node) S 7 9 42 0 -1 4194304")).toEqual({ ppid: 7, pgrp: 9 });
    expect(parseProcStat("42 (weird ) name) S 9 11 42 0 -1 4194304")).toEqual({ ppid: 9, pgrp: 11 });
    expect(parseProcStat("42 (weird ) name) S 9 11 42 0 -1 4194304 0 0 0 0 13 17 0 0 20 0 1 0 12345")).toEqual({
        ppid: 9,
        pgrp: 11,
        cpuTicks: 30,
        startTimeTicks: 12345,
    });
    expect(parseProcStat("garbage")).toBeUndefined();
});

test("a whole tree goes when its turn has finished: the grandchild nobody holds a handle on included", () => {
    expect(leftoverProcesses(tree("conv-1"), policy()).map((entry) => entry.pid)).toEqual([100, 101, 102]);
});

test("nothing goes while the turn is still live", () => {
    expect(leftoverProcesses(tree("conv-1"), policy({ ownerLive: (owner) => owner === "conv-1" }))).toEqual([]);
});

test("another daemon's processes are not this daemon's business, however they are stamped", () => {
    const theirs = tree("conv-1", 4242);
    expect(leftoverProcesses(theirs, policy())).toEqual([]);
    // The second call adds a `conv-1` process in this daemon's own group, to prove only the foreign group is excluded.
    expect(leftoverProcesses([...theirs, ...tree("conv-1")], policy()).map((entry) => entry.pid)).toEqual([100, 101, 102]);
});

// A pane's processes are forked by the tmux server and carry the pane's group, not the daemon's; only the registry can
// identify them.
test("an out-of-group survivor whose owner this registry knows is reclaimed once its pane is gone", () => {
    const survivor: ScannedProcess[] = [{ pid: 600, ppid: 1, pgrp: 601, owner: "conv-1" }];
    expect(leftoverProcesses(survivor, policy({ ownerKnown: (owner) => owner === "conv-1" })).map((entry) => entry.pid)).toEqual([600]);
    expect(leftoverProcesses(survivor, policy({ ownerKnown: () => true, ownerLive: () => true }))).toEqual([]);
    expect(leftoverProcesses(survivor, policy())).toEqual([]);
});

test("the reserved owners never pass the registry licence: the pools stay group-ruled", () => {
    const pooled: ScannedProcess[] = [{ pid: 700, ppid: 1, pgrp: 701, owner: "daemon" }];
    // ownerKnown here treats every owner except "daemon" as known, since "daemon" is not a conversation.
    expect(leftoverProcesses(pooled, policy({ ownerKnown: (owner) => owner !== "daemon" }))).toEqual([]);
});

test("unstamped processes are never touched: a sandbox is somebody's machine too", () => {
    const theirs: ScannedProcess[] = [
        { pid: 200, ppid: 1, pgrp: 7, owner: undefined },
        { pid: 201, ppid: 200, pgrp: 7, owner: undefined },
    ];
    expect(leftoverProcesses(theirs, policy())).toEqual([]);
});

test("a delegation under a live tmux pane is somebody's visible work, however deep below the shell it sits", () => {
    const delegated: ScannedProcess[] = [
        { pid: 300, ppid: 1, pgrp: 7, owner: undefined },
        { pid: 301, ppid: 300, pgrp: 7, owner: "conv-1" },
        { pid: 302, ppid: 301, pgrp: 7, owner: "conv-1" },
    ];
    expect(leftoverProcesses(delegated, policy({ panePids: new Set([300]) }))).toEqual([]);
});

test("the pane exemption is ancestry, not a pid match: a sibling tree of the same turn still goes", () => {
    const mixed: ScannedProcess[] = [
        { pid: 300, ppid: 1, pgrp: 7, owner: undefined },
        { pid: 301, ppid: 300, pgrp: 7, owner: "conv-1" },
        { pid: 400, ppid: 1, pgrp: 7, owner: "conv-1" },
    ];
    expect(leftoverProcesses(mixed, policy({ panePids: new Set([300]) })).map((entry) => entry.pid)).toEqual([400]);
});

test("an ancestry cycle procfs should not be able to show us still terminates", () => {
    const cyclic: ScannedProcess[] = [
        { pid: 500, ppid: 501, pgrp: 7, owner: "conv-1" },
        { pid: 501, ppid: 500, pgrp: 7, owner: undefined },
    ];
    expect(leftoverProcesses(cyclic, policy()).map((entry) => entry.pid)).toEqual([500]);
});
