import {
    FIT_WINDOW_MS,
    fitReason,
    MIN_CHANGE_GB,
    outsideVmBytes,
    percentile,
    proposedVmGb,
    SAMPLE_EVERY_MS,
    VM_FLOOR_BYTES,
    vmBytesFromTasklist,
    withCaps,
    type WslMemoryReading,
    wslMemoryFit,
} from "./wsl-memory-fit.js";

const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;
// rog: 31.4 GiB of RAM, so a 3.14 GiB low line.
const ROG = 31.4 * GIB;

// Readings every five minutes, newest at NOW, each a (available, outside-the-VM) pair in GiB cycling through `pattern`;
// the VM holds the rest, as it did on rog.
const readings = (
    { total = ROG, count = FIT_WINDOW_MS / SAMPLE_EVERY_MS, every = SAMPLE_EVERY_MS, pattern }: {
        readonly total?: number;
        readonly count?: number;
        readonly every?: number;
        readonly pattern: readonly (readonly [available: number, outside: number])[];
    },
): WslMemoryReading[] =>
    Array.from({ length: count }, (_, index) => {
        const [available, outside] = pattern[index % pattern.length] ?? [0, 0];
        return { at: NOW - (count - 1 - index) * every, availableBytes: available * GIB, totalBytes: total, vmBytes: total - available * GIB - outside * GIB };
    });

// rog over an afternoon (2026-11-26): Windows at 2-5 GiB available, under its 3.1 GiB line seven readings in eight,
// Windows' own use outside the VM 12.0-12.5 GiB (31.4 - 2.3 - 16.6 = 12.5 measured once), the VM holding ~16.6 GiB.
const ROG_AFTERNOON: readonly (readonly [number, number])[] = [
    [2.1, 12.0],
    [2.4, 12.3],
    [2.8, 12.5],
    [3.0, 12.2],
    [2.6, 12.4],
    [4.8, 12.1],
    [2.3, 12.5],
    [2.9, 12.3],
];

interface Row {
    readonly name: string;
    readonly readings: readonly WslMemoryReading[];
    readonly configuredGb: number | undefined;
    // The proposal, or undefined for no finding.
    readonly proposedGb: number | undefined;
    readonly atFloor?: boolean;
}

const rows: readonly Row[] = [
    {
        // 31.4 - 12.5 (p90 outside) - 3.14 (low line) - 0.5 (margin) = 15.26, rounded down.
        name: "rog with memory=22GB: too big, 15 GB fits",
        readings: readings({ pattern: ROG_AFTERNOON }),
        configuredGb: 22,
        proposedGb: 15,
        atFloor: false,
    },
    {
        name: "the same afternoon over one hour only: a burst, not a size",
        readings: readings({ pattern: ROG_AFTERNOON, count: 13 }),
        configuredGb: 22,
        proposedGb: undefined,
    },
    {
        name: "four hours of readings, but too few of them (an agent that kept restarting)",
        readings: readings({ pattern: ROG_AFTERNOON, count: 12, every: 20 * 60_000 }),
        configuredGb: 22,
        proposedGb: undefined,
    },
    {
        // Under the line in 3 readings of 8: short sometimes, not most of the time.
        name: "Windows under its low line in under 60% of the readings",
        readings: readings({
            pattern: [
                [2.5, 12],
                [4, 12],
                [5, 12],
                [2.5, 12],
                [4, 12],
                [5, 12],
                [2.5, 12],
                [6, 12],
            ],
        }),
        configuredGb: 22,
        proposedGb: undefined,
    },
    {
        // Windows' own programs fill it (25 GiB outside a 4-5 GiB VM): a smaller VM would give Windows nothing.
        name: "Windows short, but the VM holds little of the RAM",
        readings: readings({ pattern: [[2.5, 25]] }),
        configuredGb: 22,
        proposedGb: undefined,
    },
    {
        // At the floor, a VM already under it: capping it there would give Windows nothing.
        name: "a small PC whose VM is already under the floor",
        readings: readings({ total: 16 * GIB, pattern: [[1.2, 9]] }),
        configuredGb: 12,
        proposedGb: undefined,
    },
    {
        name: "memory= already at the size that fits",
        readings: readings({ pattern: ROG_AFTERNOON }),
        configuredGb: 15,
        proposedGb: undefined,
    },
    {
        name: "memory= one GB over: not worth restarting every sandbox",
        readings: readings({ pattern: ROG_AFTERNOON }),
        configuredGb: 15 + MIN_CHANGE_GB - 1,
        proposedGb: undefined,
    },
    {
        // WSL's default is half the RAM, 15.7 GiB here: already under 15 + MIN_CHANGE_GB.
        name: "no memory= at all, on rog: WSL's own half is close enough",
        readings: readings({ pattern: ROG_AFTERNOON }),
        configuredGb: undefined,
        proposedGb: undefined,
    },
    {
        // A 64 GiB PC with no memory= (32 GiB by default), Windows' own use 30 GiB: 64 - 30 - 6.4 - 0.5 = 27.1.
        name: "a big PC on WSL's default half",
        readings: readings({ total: 64 * GIB, pattern: [[5, 30]] }),
        configuredGb: undefined,
        proposedGb: 27,
        atFloor: false,
    },
    {
        // 16 GiB with Windows using 6.5 outside and the VM 8.3: 16 - 6.5 - 1.6 - 0.5 = 7.4 fits Windows, but runs no sandbox.
        name: "a small PC: never under the floor that runs one sandbox",
        readings: readings({ total: 16 * GIB, pattern: [[1.2, 6.5]] }),
        configuredGb: 12,
        proposedGb: VM_FLOOR_BYTES / GIB,
        atFloor: true,
    },
];

for (const row of rows) {
    test(`fit: ${row.name}`, () => {
        const fit = wslMemoryFit(row.readings, row.configuredGb, NOW);
        expect(fit?.proposedGb).toBe(row.proposedGb);
        if (row.atFloor !== undefined) {
            expect(fit?.atFloor).toBe(row.atFloor);
        }
    });
}

test("readings older than the window are not decided on", () => {
    const old = readings({ pattern: ROG_AFTERNOON }).map((reading) => ({ ...reading, at: reading.at - FIT_WINDOW_MS }));
    expect(wslMemoryFit(old, 22, NOW)).toBeUndefined();
    // Old ones beside a full window change nothing.
    expect(wslMemoryFit([...old, ...readings({ pattern: ROG_AFTERNOON })], 22, NOW)?.proposedGb).toBe(15);
});

test("rog's finding says what was measured and what is proposed", () => {
    const fit = wslMemoryFit(readings({ pattern: ROG_AFTERNOON }), 22, NOW);
    expect(fit).toMatchObject({ readings: 48, windowMs: 47 * SAMPLE_EVERY_MS, configuredGb: 22, underLowShare: 7 / 8 });
    expect(fit?.lowLineBytes).toBeCloseTo(3.14 * GIB, -6);
    expect(fit?.outsideBytes).toBeCloseTo(12.5 * GIB, -6);
    expect(fit?.text).toBe(
        "Windows had less than its 3.1 GiB low line available in 88% of the readings over the last 3.9 hours (median 2.6 GiB of 31.4 GiB), while the WSL VM held a median 16.2 GiB in RAM; Windows' own use outside the VM reached 12.5 GiB (90th percentile). .wslconfig gives the VM memory=22GB; memory=15GB would leave Windows its own use, its low line and 0.5 GiB to spare.",
    );
    expect(fit === undefined ? undefined : fitReason(fit)).toBe("Windows was under its 3.1 GiB low line in 88% of 3.9 hours of readings while the VM held a median 16.2 GiB of 31.4 GiB");
});

// rog's two sandboxes run with an 18 GiB cap each, past the 15 GB proposed.
test("sandbox caps larger than the proposed VM are flagged", () => {
    const fit = wslMemoryFit(readings({ pattern: ROG_AFTERNOON }), 22, NOW);
    if (fit === undefined) {
        throw new Error("rog's readings should make a finding");
    }
    const flagged = withCaps(fit, [
        { name: "shinobi", memoryBytes: 18 * GIB },
        { name: "intentic", memoryBytes: 18 * GIB },
        { name: "small", memoryBytes: 8 * GIB },
    ]);
    expect(flagged.capsOver?.map((cap) => cap.name)).toEqual(["intentic", "shinobi"]);
    expect(flagged.text).toEndWith("2 sandboxes here are capped above that: intentic (18.0 GiB), shinobi (18.0 GiB); a cap past the VM's memory is no cap, so lower them too.");
    expect(withCaps(fit, [{ name: "small", memoryBytes: 8 * GIB }])).toBe(fit);
});

test("the proposal rounds down and stops at the floor", () => {
    expect(proposedVmGb(ROG, 12.5 * GIB)).toEqual({ gb: 15, atFloor: false });
    // 31.4 - 11.6 - 3.14 - 0.5 = 16.16: 16.
    expect(proposedVmGb(ROG, 11.6 * GIB)).toEqual({ gb: 16, atFloor: false });
    expect(proposedVmGb(ROG, 25 * GIB)).toEqual({ gb: 8, atFloor: true });
    expect(VM_FLOOR_BYTES).toBe(8 * GIB);
});

test("percentile is nearest-rank", () => {
    expect(percentile([], 0.9)).toBeUndefined();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([10, 1, 5], 0.5)).toBe(5);
    expect(outsideVmBytes({ at: 0, availableBytes: 2.3 * GIB, totalBytes: ROG, vmBytes: 16.6 * GIB })).toBeCloseTo(12.5 * GIB, -6);
});

// What rog's tasklist printed on 2026-11-26, and the same in other locales' grouping.
test("vmmemWSL's working set is read from tasklist's CSV", () => {
    expect(vmBytesFromTasklist(`"vmmemWSL","14616","Services","0","15,166,676 K"\r\n`)).toBe(15_166_676 * 1024);
    expect(vmBytesFromTasklist(`"vmmemWSL","14616","Services","0","15.166.676 K"`)).toBe(15_166_676 * 1024);
    expect(vmBytesFromTasklist(`"vmmemWSL","14616","Services","0","15 166 676 K"`)).toBe(15_166_676 * 1024);
    expect(vmBytesFromTasklist("INFO: No tasks are running which match the specified criteria.\r\n")).toBe(0);
});
