import { expect, test } from "vitest";
import { leftoverProcesses, parsePpid, parseStamp, type ScannedProcess, stampOf, WORKLOAD_ENV, workloadStamp } from "./leftovers.js";

const environ = (...pairs: string[]): string => `${pairs.join("\0")}\0`;

// A tree the sweep has to reason about: the CLI, an MCP server under it, and the browser under that — all
// carrying one stamp, because the environment is the thing that got inherited.
const tree = (owner: string, boot = "boot-a"): ScannedProcess[] => [
    { pid: 100, ppid: 1, stamp: { bootId: boot, owner } },
    { pid: 101, ppid: 100, stamp: { bootId: boot, owner } },
    { pid: 102, ppid: 101, stamp: { bootId: boot, owner } },
];

const policy = (overrides: Partial<Parameters<typeof leftoverProcesses>[1]> = {}) => ({
    bootId: "boot-a",
    ownerLive: () => false,
    panePids: new Set<number>(),
    ...overrides,
});

test("a stamp round-trips, and an owner containing a colon survives it", () => {
    const stamped = workloadStamp("conv:with:colons");
    expect(parseStamp(stamped[WORKLOAD_ENV])?.owner).toBe("conv:with:colons");
    expect(parseStamp(stamped[WORKLOAD_ENV])?.bootId).not.toContain(":");
});

test("a value with no colon, or a leading one, is not a stamp", () => {
    expect(parseStamp("nocolon")).toBeUndefined();
    expect(parseStamp(":owner")).toBeUndefined();
    expect(parseStamp(undefined)).toBeUndefined();
});

test("the stamp is read out of a NUL-separated environ and ignores every other variable", () => {
    expect(stampOf(environ("PATH=/usr/bin", `${WORKLOAD_ENV}=boot-a:conv-1`, "HOME=/root"))?.owner).toBe("conv-1");
    expect(stampOf(environ("PATH=/usr/bin"))).toBeUndefined();
});

test("ppid is read from after the last paren, so an executable named with spaces and parens cannot shift it", () => {
    expect(parsePpid("42 (node) S 7 42 42 0 -1 4194304")).toBe(7);
    expect(parsePpid("42 (weird ) name) S 9 42 42 0 -1 4194304")).toBe(9);
    expect(parsePpid("garbage")).toBeUndefined();
});

test("a whole tree goes when its turn has finished — the grandchild nobody holds a handle on included", () => {
    expect(leftoverProcesses(tree("conv-1"), policy()).map((entry) => entry.pid)).toEqual([100, 101, 102]);
});

test("nothing goes while the turn is still live", () => {
    expect(leftoverProcesses(tree("conv-1"), policy({ ownerLive: (owner) => owner === "conv-1" }))).toEqual([]);
});

test("a stamp from a previous daemon life is reclaimable without asking whose it was", () => {
    const previous = leftoverProcesses(tree("conv-1", "boot-earlier"), policy({ ownerLive: () => true }));
    expect(previous.map((entry) => entry.reason)).toEqual(["previous-boot", "previous-boot", "previous-boot"]);
});

test("unstamped processes are never touched — a sandbox is somebody's machine too", () => {
    const theirs: ScannedProcess[] = [
        { pid: 200, ppid: 1, stamp: undefined },
        { pid: 201, ppid: 200, stamp: undefined },
    ];
    expect(leftoverProcesses(theirs, policy())).toEqual([]);
});

test("a delegation running under a tmux pane is exempt however deep below the pane it sits", () => {
    const delegated: ScannedProcess[] = [
        { pid: 300, ppid: 1, stamp: undefined }, // the pane's root shell
        { pid: 301, ppid: 300, stamp: { bootId: "boot-a", owner: "conv-1" } },
        { pid: 302, ppid: 301, stamp: { bootId: "boot-a", owner: "conv-1" } },
    ];
    expect(leftoverProcesses(delegated, policy({ panePids: new Set([300]) }))).toEqual([]);
});

test("a pane exemption does not leak to a sibling tree that is not under it", () => {
    const mixed: ScannedProcess[] = [
        { pid: 300, ppid: 1, stamp: undefined },
        { pid: 301, ppid: 300, stamp: { bootId: "boot-a", owner: "conv-1" } },
        { pid: 400, ppid: 1, stamp: { bootId: "boot-a", owner: "conv-1" } },
    ];
    expect(leftoverProcesses(mixed, policy({ panePids: new Set([300]) })).map((entry) => entry.pid)).toEqual([400]);
});

test("an ancestry cycle procfs should not be able to show us still terminates", () => {
    const cyclic: ScannedProcess[] = [
        { pid: 500, ppid: 501, stamp: { bootId: "boot-a", owner: "conv-1" } },
        { pid: 501, ppid: 500, stamp: undefined },
    ];
    expect(leftoverProcesses(cyclic, policy()).map((entry) => entry.pid)).toEqual([500]);
});
