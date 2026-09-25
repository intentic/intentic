import { askRoom, freeBytesOf, judge, readingFrom, readReadingSync } from "./memory-room.mjs";

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
            "/proc/meminfo": meminfo(64, 60),
            [`${CG}/memory.max`]: `${16 * GIB}\n`,
            [`${CG}/memory.current`]: `${10 * GIB}\n`,
            [`${CG}/memory.stat`]: `anon 1\nfile 2\ninactive_file ${3 * GIB}\n`,
            [`${CG}/memory.swap.current`]: `${2 * GIB}\n`,
            [`${CG}/memory.events`]: "low 0\nhigh 4\nmax 12\noom 1\noom_kill 2\n",
        }),
    );
    expect(reading).toEqual({ limitBytes: 16 * GIB, usedBytes: 9 * GIB, swapBytes: 2 * GIB, stallPercent: 0, oomKills: 2 });
    expect(freeBytesOf(reading)).toBe(7 * GIB);
});

// A hosted machine's daemon may sit in the root cgroup, which keeps no memory.current or memory.max: the machine's own
// figures are then the sandbox's.
test("at a root cgroup the machine's used memory and swap stand in for the cgroup's", () => {
    const reading = readingFrom(files({ "/proc/meminfo": meminfo(8, 3, 2, 1.5), "/proc/pressure/memory": "some avg10=40.00\nfull avg10=25.50 avg60=1\n" }));
    expect(reading).toEqual({ limitBytes: 8 * GIB, usedBytes: 5.5 * GIB, swapBytes: 0.5 * GIB, stallPercent: 25.5, oomKills: undefined });
});

test("the stall is PSI `full`, the cgroup's where it keeps one, and 0 where nothing reports it", () => {
    const cgroupFull = { [`${CG}/memory.pressure`]: "some avg10=60.00 avg60=1\nfull avg10=12.25 avg60=1\n", "/proc/pressure/memory": "full avg10=90.00\n" };
    expect(readingFrom(files(cgroupFull)).stallPercent).toBe(12.25);
    expect(readingFrom(files({})).stallPercent).toBe(0);
});

test("the verdict for work nobody waits on leaves a person's turn free on top of its own cost", () => {
    const reading = { limitBytes: 10 * GIB, usedBytes: 8 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    expect(judge(reading, { workload: "toolchain", attended: false })).toEqual({ verdict: "run", needBytes: 2 * GIB, freeBytes: 2 * GIB, reservedBytes: 0 });
    expect(judge(reading, { workload: "toolchain", attended: false, reservedBytes: 1 })).toMatchObject({ verdict: "wait", freeBytes: 2 * GIB - 1 });
    expect(judge(reading, { workload: "agentRuntime", attended: true, reservedBytes: GIB })).toMatchObject({ verdict: "run", needBytes: GIB });
});

test("a live reading of this machine parses to numbers or nothing, never throws", () => {
    const live = readReadingSync();
    expect(typeof live.stallPercent).toBe("number");
    expect(typeof live.swapBytes).toBe("number");
});

test("with no daemon to ask, a short box is waited on by the formula and started anyway at the deadline", async () => {
    const short = { limitBytes: 10 * GIB, usedBytes: 9.9 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    const answer = await askRoom({ workload: "toolchain", waitSeconds: 0.02, socketPath: "/nonexistent/room.sock", intervalMs: 5, read: () => short });
    expect(answer).toMatchObject({ verdict: "wait", source: "formula", diagnosis: "Sandbox memory is low: 9.9 GiB of 10.0 GiB used" });
});
