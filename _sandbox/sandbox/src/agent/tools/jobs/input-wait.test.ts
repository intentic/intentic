import { blockedDescriptor, blockedSet, INPUT_WAIT_MS, inputWaitOf, type RunSample, setDescriptors, stillnessAfter } from "./input-wait.js";

// The two decisions the probe makes without the machine: which descriptor a blocked syscall names, and whether a run has
// sat still long enough, reading its terminal, to be waiting on a person. input-wait.integration.test.ts runs it against
// real programs on a real terminal.

describe("the descriptor a blocked syscall waits on for input", () => {
    it("is the first argument of a read or an epoll wait, in hex", () => {
        // As /proc/<pid>/syscall printed them on x86-64 for python's input() and npm's prompt (2026-10-04).
        expect(blockedDescriptor("0 0x0 0x39689b90 0x400 0x0 0x0 0x0 0x7ffd 0x7f12", "x64")).toBe(0);
        expect(blockedDescriptor("281 0x10 0x7fffab1f95a0 0x400 0xffffffff 0x0 0x8\n", "x64")).toBe(16);
        // The same two on arm64, whose numbers differ.
        expect(blockedDescriptor("63 0x0 0xffffd1e0 0x400 0x0 0x0 0x0", "arm64")).toBe(0);
        expect(blockedDescriptor("22 0x10 0xffffd1e0 0x400 0xffffffff 0x0", "arm64")).toBe(16);
    });

    it("is nothing for a sleep, a socket read, a poll, a process on a CPU or an unreadable file", () => {
        // sleep's clock_nanosleep: its first argument is CLOCK_REALTIME, 0, which is not stdin.
        expect(blockedDescriptor("230 0x0 0x0 0x7ffc 0x0 0x0 0x0", "x64")).toBeUndefined();
        expect(blockedDescriptor("45 0x5 0x7f 0xa 0x0 0x0 0x0 0x7ffd 0x7f12", "x64")).toBeUndefined();
        expect(blockedDescriptor("7 0x7ffc8a3e1b20 0x1 0xffffffff", "x64")).toBeUndefined();
        expect(blockedDescriptor("running", "x64")).toBeUndefined();
        expect(blockedDescriptor("", "x64")).toBeUndefined();
        // An architecture with no table reads nothing rather than guessing.
        expect(blockedDescriptor("0 0x0 0x39689b90", "riscv64")).toBeUndefined();
    });
});

describe("the set a blocked poll or select waits on", () => {
    it("is where the pollfd array or the read set sits, and how many descriptors it holds", () => {
        // As /proc/<pid>/syscall printed python 3.13's REPL on x86-64 (2026-11-17): poll, one entry, a 100 ms timeout.
        expect(blockedSet("7 0x7eff12da0780 0x1 0x64 0x0 0x0 0x0 0x7ffebde4bb60 0x7eff12f0c3a7", "x64")).toEqual({ kind: "poll", address: 0x7eff12da0780, count: 1 });
        expect(blockedSet("271 0x7ffc10 0x2 0x0 0x0 0x8", "x64")).toEqual({ kind: "poll", address: 0x7ffc10, count: 2 });
        // select and pselect6 count first and point second.
        expect(blockedSet("23 0x1 0x7ffd20 0x0 0x0 0x0", "x64")).toEqual({ kind: "select", address: 0x7ffd20, count: 1 });
        expect(blockedSet("72 0x5 0xffffd1e0 0x0 0x0 0x0 0x0", "arm64")).toEqual({ kind: "select", address: 0xffffd1e0, count: 5 });
        // No read set, an empty one, a read, an unknown architecture: nothing to look at.
        expect(blockedSet("23 0x4 0x0 0x7ffd20 0x0 0x0", "x64")).toBeUndefined();
        expect(blockedSet("7 0x7ffc10 0x0 0x64", "x64")).toBeUndefined();
        expect(blockedSet("0 0x0 0x39689b90 0x400", "x64")).toBeUndefined();
        expect(blockedSet("7 0x7ffc10 0x1 0x64", "riscv64")).toBeUndefined();
        expect(blockedSet("running", "x64")).toBeUndefined();
    });

    it("waits for input on the descriptors asking for it: pollfds with POLLIN, select's set bits", () => {
        const pollfds = Buffer.alloc(24);
        pollfds.writeInt32LE(4, 0);
        pollfds.writeInt16LE(0x1, 4);
        // Writing only (POLLOUT) is not waiting for input; a negative descriptor is an entry poll skips.
        pollfds.writeInt32LE(7, 8);
        pollfds.writeInt16LE(0x4, 12);
        pollfds.writeInt32LE(-1, 16);
        pollfds.writeInt16LE(0x1, 20);
        expect(setDescriptors({ kind: "poll", address: 1, count: 3 }, pollfds)).toEqual([4]);
        // Descriptors 0 and 9 set; bits past the count are not the set's.
        expect(setDescriptors({ kind: "select", address: 1, count: 10 }, Buffer.from([0b0000_0001, 0b1000_0010]))).toEqual([0, 9]);
    });
});

const look = (at: number, over: Partial<RunSample> = {}): RunSample => ({
    at,
    cpuTicks: 37,
    members: "100 101 102",
    outputBytes: 12,
    reader: { pid: 102, program: "npm exec eslint src/a.vue" },
    ...over,
});

describe("a run waiting for input", () => {
    it("is a reader of its terminal that has sat still for the whole window, dated from when it went still", () => {
        const first = stillnessAfter(undefined, look(1_000));
        const later = stillnessAfter(first, look(1_000 + INPUT_WAIT_MS));
        expect(inputWaitOf(later)).toEqual({ since: 1_000, pid: 102, program: "npm exec eslint src/a.vue" });
    });

    it("is not yet one a moment short of the window", () => {
        const first = stillnessAfter(undefined, look(1_000));
        expect(inputWaitOf(stillnessAfter(first, look(1_000 + INPUT_WAIT_MS - 1)))).toBeUndefined();
    });

    it("starts its window again whenever anything moves: CPU, a process, output, or which process reads", () => {
        for (const moved of [{ cpuTicks: 38 }, { members: "100 101 102 103" }, { outputBytes: 13 }, { reader: { pid: 101, program: "bash" } }]) {
            const first = stillnessAfter(undefined, look(1_000));
            const after = stillnessAfter(first, look(1_000 + INPUT_WAIT_MS, moved));
            expect(after.since).toBe(1_000 + INPUT_WAIT_MS);
            expect(inputWaitOf(after)).toBeUndefined();
        }
    });

    it("is never one that reads no terminal, however long it has sat still", () => {
        const first = stillnessAfter(undefined, look(1_000, { reader: undefined }));
        expect(inputWaitOf(stillnessAfter(first, look(1_000 + 10 * INPUT_WAIT_MS, { reader: undefined })))).toBeUndefined();
    });
});
