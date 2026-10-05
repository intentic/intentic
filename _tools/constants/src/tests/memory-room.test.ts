import { askRoom, countedBytesOf, freeBytesOf, judge, readingFrom, readReadingSync, swapFullOf } from "../memory-room.mjs";

const GIB = 1024 ** 3;
const CG = "/sys/fs/cgroup";

// The files a reading is made of, as a reader answering from a table; anything absent reads as a missing file.
const files =
    (table: Record<string, string>) =>
    (path: string): string | undefined =>
        table[path];

const meminfo = (totalGib: number, availableGib: number, swapTotalGib = 0, swapFreeGib = 0): string =>
    [
        `MemTotal:       ${totalGib * 1024 * 1024} kB`,
        `MemFree:        1 kB`,
        `MemAvailable:   ${availableGib * 1024 * 1024} kB`,
        `SwapTotal:      ${swapTotalGib * 1024 * 1024} kB`,
        `SwapFree:       ${swapFreeGib * 1024 * 1024} kB`,
        "",
    ].join("\n");

test("the limit is memory.high, else memory.max, else the machine's memory, and never past the machine's", () => {
    const capped = { "/proc/meminfo": meminfo(64, 60), [`${CG}/memory.max`]: `${20 * GIB}\n`, [`${CG}/memory.current`]: "0\n" };
    expect(readingFrom(files({ ...capped, [`${CG}/memory.high`]: `${18 * GIB}\n` })).limitBytes).toBe(18 * GIB);
    expect(readingFrom(files({ ...capped, [`${CG}/memory.high`]: "max\n" })).limitBytes).toBe(20 * GIB);
    expect(readingFrom(files({ ...capped, [`${CG}/memory.max`]: "max\n" })).limitBytes).toBe(64 * GIB);
    expect(readingFrom(files({ ...capped, [`${CG}/memory.max`]: `${128 * GIB}\n` })).limitBytes).toBe(64 * GIB);
    expect(readingFrom(files({})).limitBytes).toBeUndefined();
});

test("used is the working set plus swap: current less the inactive file cache, plus what was swapped out", () => {
    const reading = readingFrom(
        files({
            "/proc/meminfo": meminfo(64, 60, 8, 6),
            [`${CG}/memory.max`]: `${16 * GIB}\n`,
            [`${CG}/memory.current`]: `${10 * GIB}\n`,
            [`${CG}/memory.stat`]: `anon 1\nfile 2\ninactive_file ${3 * GIB}\n`,
            [`${CG}/memory.swap.current`]: `${2 * GIB}\n`,
            [`${CG}/memory.events`]: "low 0\nhigh 4\nmax 12\noom 1\noom_kill 2\n",
        }),
    );
    expect(reading).toEqual({
        limitBytes: 16 * GIB,
        usedBytes: 9 * GIB,
        swapBytes: 2 * GIB,
        // No memory.swap.max: what is swapped plus the machine's free swap bounds it.
        swapLimitBytes: 8 * GIB,
        availableBytes: 60 * GIB,
        stallPercent: 0,
        stallSustainedPercent: 0,
        oomKills: 2,
    });
    // Free is counted against the resident part: swap leaves the limit's room free.
    expect(freeBytesOf(reading)).toBe(9 * GIB);
    // A machine with less available than the limit leaves is what binds: the sandbox cannot take memory it does not have.
    expect(freeBytesOf({ ...reading, availableBytes: 3 * GIB })).toBe(3 * GIB);
});

// A hosted machine's daemon may sit in the root cgroup, which keeps no memory.current or memory.max: the machine's own
// figures are then the sandbox's.
test("at a root cgroup the machine's used memory and swap stand in for the cgroup's", () => {
    const reading = readingFrom(
        files({ "/proc/meminfo": meminfo(8, 3, 2, 1.5), "/proc/pressure/memory": "some avg10=40.00\nfull avg10=25.50 avg60=1\n" }),
    );
    expect(reading).toEqual({
        limitBytes: 8 * GIB,
        usedBytes: 5.5 * GIB,
        swapBytes: 0.5 * GIB,
        swapLimitBytes: 2 * GIB,
        availableBytes: 3 * GIB,
        stallPercent: 25.5,
        stallSustainedPercent: 1,
        oomKills: undefined,
    });
});

test("the stall is PSI `full`, the cgroup's where it keeps one, and 0 where nothing reports it", () => {
    const cgroupFull = {
        [`${CG}/memory.pressure`]: "some avg10=60.00 avg60=1\nfull avg10=12.25 avg60=7.50 avg300=1\n",
        "/proc/pressure/memory": "full avg10=90.00 avg60=90.00\n",
    };
    expect(readingFrom(files(cgroupFull))).toMatchObject({ stallPercent: 12.25, stallSustainedPercent: 7.5 });
    expect(readingFrom(files({}))).toMatchObject({ stallPercent: 0, stallSustainedPercent: 0 });
});

// The reading of 2026-10-05 22:14: avg10 flickered under 20% for minutes while everything paged.
test("a minute of stall past STALL_SUSTAINED_PERCENT holds work the ten-second figure lets through", () => {
    const reading = { limitBytes: 20 * GIB, usedBytes: 8 * GIB, swapBytes: 0, stallPercent: 17.6, stallSustainedPercent: 12.4, oomKills: undefined };
    expect(judge(reading, { workload: "agentRuntime", attended: true })).toMatchObject({
        verdict: "refuse",
        diagnosis: "The sandbox is short of memory: for 12% of the last minute, everything in it was waiting on memory",
    });
    expect(judge({ ...reading, stallSustainedPercent: 9.9 }, { workload: "agentRuntime", attended: true })).toMatchObject({ verdict: "run" });
});

test("swap's limit is memory.swap.max, never more than what is swapped plus what the machine's swap can still take", () => {
    const cgroup = {
        "/proc/meminfo": meminfo(22, 7, 34, 16),
        [`${CG}/memory.max`]: `${20 * GIB}\n`,
        [`${CG}/memory.current`]: `${12 * GIB}\n`,
        [`${CG}/memory.swap.current`]: `${9.5 * GIB}\n`,
    };
    expect(readingFrom(files({ ...cgroup, [`${CG}/memory.swap.max`]: `${10 * GIB}\n` })).swapLimitBytes).toBe(10 * GIB);
    expect(readingFrom(files({ ...cgroup, [`${CG}/memory.swap.max`]: "max\n" })).swapLimitBytes).toBe(25.5 * GIB);
    expect(readingFrom(files({ ...cgroup, "/proc/meminfo": meminfo(22, 7, 34, 0.25), [`${CG}/memory.swap.max`]: "max\n" })).swapLimitBytes).toBe(
        9.75 * GIB,
    );
});

// The reading of 2026-10-05 22:14 that started every turn: 12 GiB resident, 10 of 10 GiB swapped, a 20 GiB limit.
test("once swap is nearly full the swapped pages count against the limit, and a sandbox past it is short", () => {
    const reading = {
        limitBytes: 20 * GIB,
        usedBytes: 22 * GIB,
        swapBytes: 10 * GIB,
        swapLimitBytes: 10 * GIB,
        availableBytes: 7 * GIB,
        stallPercent: 1.7,
        oomKills: undefined,
    };
    expect(swapFullOf(reading)).toBe(true);
    expect(countedBytesOf(reading)).toBe(22 * GIB);
    expect(freeBytesOf(reading)).toBe(0);
    expect(judge(reading, { workload: "agentRuntime", attended: true })).toMatchObject({
        verdict: "refuse",
        freeBytes: 0,
        diagnosis: "Sandbox memory is low: 12.0 GiB resident + 10.0 GiB swapped, against 20.0 GiB, with swap full",
        memory: { limitBytes: 20 * GIB, residentBytes: 12 * GIB, swapBytes: 10 * GIB },
    });
    // With room left in swap, the same pages are cold ones parked there, and only the resident part counts.
    const roomy = { ...reading, swapLimitBytes: 16 * GIB };
    expect(swapFullOf(roomy)).toBe(false);
    expect(freeBytesOf(roomy)).toBe(7 * GIB);
    expect(judge(roomy, { workload: "agentRuntime", attended: true })).toMatchObject({ verdict: "run" });
    // Swap off or unbounded is never full.
    expect(swapFullOf({ ...reading, swapBytes: 0, swapLimitBytes: 0 })).toBe(false);
    expect(swapFullOf({ ...reading, swapLimitBytes: undefined })).toBe(false);
});

test("the verdict for work nobody waits on leaves a person's turn free on top of its own cost", () => {
    const reading = { limitBytes: 10 * GIB, usedBytes: 8 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    expect(judge(reading, { workload: "toolchain", attended: false })).toEqual({
        verdict: "run",
        needBytes: 2 * GIB,
        freeBytes: 2 * GIB,
        reservedBytes: 0,
    });
    expect(judge(reading, { workload: "toolchain", attended: false, reservedBytes: 1 })).toMatchObject({ verdict: "wait", freeBytes: 2 * GIB - 1 });
    expect(judge(reading, { workload: "agentRuntime", attended: true, reservedBytes: GIB })).toMatchObject({ verdict: "run", needBytes: GIB });
});

test("a targeted toolchain run needs a worker's cost, not the class's, plus a person's turn", () => {
    const reading = { limitBytes: 10 * GIB, usedBytes: 8.4 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    expect(judge(reading, { workload: "toolchain", attended: false })).toMatchObject({ verdict: "wait", needBytes: 2 * GIB });
    expect(judge(reading, { workload: "toolchain", attended: false, size: "targeted" })).toMatchObject({ verdict: "run", needBytes: 1.5 * GIB });
    // A size names a toolchain command only; any other class keeps its own cost.
    expect(judge(reading, { workload: "agentRuntime", attended: false, size: "targeted" })).toMatchObject({ needBytes: 2 * GIB });
});

test("a live reading of this machine parses to numbers or nothing, never throws", () => {
    const live = readReadingSync();
    expect(typeof live.stallPercent).toBe("number");
    expect(typeof live.swapBytes).toBe("number");
});

test("with no daemon to ask, a short box is waited on by the formula and started anyway at the deadline", async () => {
    const short = { limitBytes: 10 * GIB, usedBytes: 9.9 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    const answer = await askRoom({
        workload: "toolchain",
        waitSeconds: 0.02,
        socketPath: "/nonexistent/room.sock",
        intervalMs: 5,
        read: () => short,
    });
    expect(answer).toMatchObject({ verdict: "wait", source: "formula", diagnosis: "Sandbox memory is low: 9.9 GiB of 10.0 GiB used" });
});
