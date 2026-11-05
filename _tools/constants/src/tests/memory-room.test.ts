import { askRoom, costBytesOf, countedBytesOf, freeBytesOf, isRoomSize, judge, readingFrom, readReadingSync, SIZE_BYTES, swapFullOf } from "../memory-room.mjs";

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
        ioStallPercent: 0,
        ioStallSustainedPercent: 0,
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
        ioStallPercent: 0,
        ioStallSustainedPercent: 0,
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

test("disk stall is io PSI `full`, read like memory's: the cgroup's first, then the machine's", () => {
    const cgroupDisk = {
        [`${CG}/io.pressure`]: "some avg10=50.00 avg60=30.00\nfull avg10=41.86 avg60=22.50 avg300=1\n",
        "/proc/pressure/io": "full avg10=90.00 avg60=90.00\n",
    };
    expect(readingFrom(files(cgroupDisk))).toMatchObject({ ioStallPercent: 41.86, ioStallSustainedPercent: 22.5 });
    expect(readingFrom(files({ "/proc/pressure/io": "full avg10=3.00 avg60=1.00\n" }))).toMatchObject({ ioStallPercent: 3, ioStallSustainedPercent: 1 });
    expect(readingFrom(files({}))).toMatchObject({ ioStallPercent: 0, ioStallSustainedPercent: 0 });
});

// The reading of 2026-10-13 11:00, when a turn's setup failed: memory stalled 7%, the disk 42%, and plenty of bytes free.
test("a saturated disk holds work nobody waits on, and never refuses a person's turn", () => {
    const reading = { limitBytes: 18 * GIB, usedBytes: 9 * GIB, swapBytes: 0, stallPercent: 7.36, ioStallPercent: 41.86, ioStallSustainedPercent: 12, oomKills: undefined };
    expect(judge(reading, { workload: "toolchain", attended: false })).toMatchObject({
        verdict: "wait",
        diagnosis: "The sandbox's disk is saturated: for 42% of the last ten seconds, everything in it was waiting on the disk",
    });
    expect(judge(reading, { workload: "agentRuntime", attended: true })).toMatchObject({ verdict: "run" });
    // A minute's average catches a disk that flickers under the ten-second bar.
    expect(judge({ ...reading, ioStallPercent: 25, ioStallSustainedPercent: 21 }, { workload: "toolchain", attended: false })).toMatchObject({
        verdict: "wait",
        diagnosis: "The sandbox's disk is saturated: for 21% of the last minute, everything in it was waiting on the disk",
    });
    expect(judge({ ...reading, ioStallPercent: 29, ioStallSustainedPercent: 19 }, { workload: "toolchain", attended: false })).toMatchObject({ verdict: "run" });
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

// (2026-11-05) A 16 GiB sandbox as the entrypoint bounds it: memory.high at 90% of the cap, and the workload leaf, where
// everything the gate admits runs, walled at 12.5 GiB (the cap less the daemon's 3.5 GiB) with 4 GiB of swap. Outside the
// leaf, the daemon's 1.25 GiB.
const WL = `${CG}/workload`;
const bounded16 = (sandbox: { readonly residentGib: number; readonly swapGib: number }, leaf: { readonly residentGib: number; readonly swapGib: number }) => ({
    "/proc/meminfo": meminfo(32, 20, 34, 30),
    [`${CG}/memory.high`]: `${Math.floor((16 * GIB) / 100) * 90}\n`,
    [`${CG}/memory.max`]: `${16 * GIB}\n`,
    [`${CG}/memory.current`]: `${(sandbox.residentGib + 0.5) * GIB}\n`,
    [`${CG}/memory.stat`]: `inactive_file ${0.5 * GIB}\n`,
    [`${CG}/memory.swap.current`]: `${sandbox.swapGib * GIB}\n`,
    [`${CG}/memory.swap.max`]: "max\n",
    [`${WL}/memory.max`]: `${12.5 * GIB}\n`,
    [`${WL}/memory.current`]: `${(leaf.residentGib + 0.25) * GIB}\n`,
    [`${WL}/memory.stat`]: `inactive_file ${0.25 * GIB}\n`,
    [`${WL}/memory.swap.current`]: `${leaf.swapGib * GIB}\n`,
    [`${WL}/memory.swap.max`]: `${4 * GIB}\n`,
});

test("the workload leaf's wall, plus what runs outside it, is the limit where it is lower than the container's", () => {
    const reading = readingFrom(files(bounded16({ residentGib: 12, swapGib: 1 }, { residentGib: 10.75, swapGib: 1 })));
    // 12.5 GiB for the leaf and the daemon's 1.25 beside it, under the container's 14.4; used is still the whole sandbox's.
    expect(reading).toMatchObject({ limitBytes: 13.75 * GIB, usedBytes: 13 * GIB, swapBytes: GIB, swapLimitBytes: 4 * GIB });
    // Free is the leaf's own room, 12.5 − 10.75 GiB, where the container alone would read 2.4 GiB.
    expect(freeBytesOf(reading)).toBe(1.75 * GIB);
    // So a build nobody waits on (its 1 GiB and a person's turn) waits for room instead of meeting the leaf's OOM, and a
    // person's turn still fits.
    expect(judge(reading, { workload: "toolchain", attended: false })).toMatchObject({ verdict: "wait", freeBytes: 1.75 * GIB });
    expect(judge(reading, { workload: "agentRuntime", attended: true })).toMatchObject({ verdict: "run" });
    // Outside the leaf grown past what the container leaves it: the container's own limit is the lower, and stands.
    const crowded = readingFrom(files(bounded16({ residentGib: 13, swapGib: 0 }, { residentGib: 9, swapGib: 0 })));
    expect(crowded.limitBytes).toBe(Math.floor((16 * GIB) / 100) * 90);
});

test("the leaf's swap bound is swap's limit, and once it is nearly spent the leaf is judged by its own pages", () => {
    // 3.75 of the leaf's 4 GiB swapped, and 0.25 GiB swapped outside it (a Docker container beside the leaves).
    const reading = readingFrom(files(bounded16({ residentGib: 7.25, swapGib: 4 }, { residentGib: 6, swapGib: 3.75 })));
    expect(reading.swapLimitBytes).toBe(4.25 * GIB);
    expect(swapFullOf(reading)).toBe(true);
    // The swapped pages now count: free is the leaf's wall less its own resident and swapped pages, 12.5 − 6 − 3.75 GiB.
    expect(freeBytesOf(reading)).toBe(2.75 * GIB);
    // A sandbox with no cap has no wall, but its leaf's swap is still bounded.
    const uncapped = { ...bounded16({ residentGib: 7.25, swapGib: 4 }, { residentGib: 6, swapGib: 3.75 }), [`${CG}/memory.high`]: "max\n", [`${CG}/memory.max`]: "max\n", [`${WL}/memory.max`]: "max\n" };
    expect(readingFrom(files(uncapped))).toMatchObject({ limitBytes: 32 * GIB, swapLimitBytes: 4.25 * GIB });
});

test("a workload leaf that is absent or unbounded leaves the reading the container's", () => {
    const container = Object.fromEntries(Object.entries(bounded16({ residentGib: 12, swapGib: 1 }, { residentGib: 10.75, swapGib: 1 })).filter(([path]) => !path.startsWith(WL)));
    const before = readingFrom(files(container));
    expect(before).toMatchObject({ limitBytes: Math.floor((16 * GIB) / 100) * 90, swapLimitBytes: 31 * GIB });
    const unbounded = { ...bounded16({ residentGib: 12, swapGib: 1 }, { residentGib: 10.75, swapGib: 1 }), [`${WL}/memory.max`]: "max\n", [`${WL}/memory.swap.max`]: "max\n" };
    expect(readingFrom(files(unbounded))).toEqual(before);
    // A leaf with bounds but no charge of its own to tell inside from outside by is no wall either.
    expect(readingFrom(files({ ...container, [`${WL}/memory.max`]: `${GIB}\n`, [`${WL}/memory.swap.max`]: `${GIB}\n` }))).toEqual(before);
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

test("the editor's full typecheck is priced at its measured peak, and a changed-files one at what it loads", () => {
    expect(SIZE_BYTES).toEqual({ targeted: GIB / 2, "cargo-build": 7 * GIB, "editor-typecheck": 7 * GIB, "scoped-typecheck": 4 * GIB });
    const reading = { limitBytes: 16 * GIB, usedBytes: 9 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    // 7 GiB free: a toolchain command's 1 GiB or a changed-files check's 4 with a person's turn fit, the editor's 7 does not.
    expect(judge(reading, { workload: "toolchain", attended: false })).toMatchObject({ verdict: "run", needBytes: 2 * GIB });
    expect(judge(reading, { workload: "toolchain", attended: false, size: "editor-typecheck" })).toMatchObject({ verdict: "wait", needBytes: 8 * GIB });
    expect(judge(reading, { workload: "toolchain", attended: false, size: "scoped-typecheck" })).toMatchObject({ verdict: "run", needBytes: 5 * GIB });
});

// (2026-11-02) rog: the sandbox's VM had room while Windows under it had 1.1 GB left and froze.
test("work nobody waits on waits while it would take the machine running the sandbox under its reserve", () => {
    const roomy = { limitBytes: 16 * GIB, usedBytes: 4 * GIB, swapBytes: 0, stallPercent: 0, oomKills: undefined };
    const rog = { name: "rog", availableBytes: 1.1 * GIB, totalBytes: 32 * GIB, reserveBytes: 3.2 * GIB };
    const held = judge({ ...roomy, host: rog }, { workload: "toolchain", attended: false });
    expect(held).toMatchObject({ verdict: "wait", freeBytes: 12 * GIB });
    expect(held.diagnosis).toBe(
        "rog, the machine this sandbox runs on, is low on memory: it has 1.1 GiB available of 32.0 GiB, and heavy work waits while starting it would leave it under 3.2 GiB",
    );
    // Room for the work's own cost above the reserve is enough: a person's share is the sandbox's, not the host's.
    expect(judge({ ...roomy, host: { ...rog, availableBytes: 4.2 * GIB } }, { workload: "toolchain", attended: false })).toMatchObject({ verdict: "run" });
    // The editor's typecheck needs its 7 GiB above the reserve; what other work holds counts against the host too.
    expect(judge({ ...roomy, host: { ...rog, availableBytes: 9 * GIB } }, { workload: "toolchain", attended: false, size: "editor-typecheck" })).toMatchObject({ verdict: "wait" });
    expect(judge({ ...roomy, host: { ...rog, availableBytes: 4.2 * GIB } }, { workload: "toolchain", attended: false, reservedBytes: GIB })).toMatchObject({
        verdict: "wait",
        diagnosis: expect.stringContaining("it has 4.2 GiB available of 32.0 GiB, 1.0 GiB of it held for work that just started, and heavy work waits"),
    });
    // A person's turn is never held for the host, and a sandbox that measures nothing still answers to it.
    expect(judge({ ...roomy, host: rog }, { workload: "agentRuntime", attended: true })).toMatchObject({ verdict: "run" });
    expect(judge({ limitBytes: undefined, usedBytes: undefined, swapBytes: 0, stallPercent: 0, oomKills: undefined, host: rog }, { workload: "toolchain", attended: false })).toMatchObject({
        verdict: "wait",
        freeBytes: undefined,
    });
    // No host reading is no host constraint.
    expect(judge(roomy, { workload: "toolchain", attended: false })).toMatchObject({ verdict: "run" });
});

test("only a name the gate knows is a size; any other is priced as its class", () => {
    expect(["targeted", "editor-typecheck", "scoped-typecheck", "cargo-build"].filter((name) => isRoomSize(name))).toHaveLength(4);
    expect(isRoomSize("huge")).toBe(false);
    expect(isRoomSize("toString")).toBe(false);
    expect(costBytesOf("service", "editor-typecheck")).toBe(costBytesOf("service"));
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

test("two Cargo admission reservations fit an 18 GiB sandbox with a person reserve", () => {
    expect(costBytesOf("toolchain", "cargo-build")).toBe(7 * GIB);
    const reading = { limitBytes: 18 * GIB, usedBytes: GIB, swapBytes: 0, stallPercent: 0, oomKills: 0 };
    expect(judge(reading, { workload: "toolchain", attended: false, size: "cargo-build", reservedBytes: 7 * GIB })).toMatchObject({ verdict: "run", needBytes: 8 * GIB });
});
