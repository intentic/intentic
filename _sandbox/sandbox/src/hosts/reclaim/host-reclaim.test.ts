import type { HostRoom } from "@intentic/constants/memory-room";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import {
    MAX_RECLAIM_COOLDOWN_MS,
    nextReclaimCooldown,
    PRESSURE_CEILING_PERCENT,
    RECLAIM_COOLDOWN_MS,
    type ReclaimReading,
    reclaimTarget,
    resetSwappinessProbe,
    startHostReclaim,
} from "./host-reclaim.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// A 32 GiB host (rog): low line is max(1.5 GiB, 10% of 32) = 3.2 GiB.
const host = (availableGib: number, totalGib = 32): HostRoom => ({
    name: "rog",
    availableBytes: availableGib * GIB,
    totalBytes: totalGib * GIB,
    reserveBytes: Math.max(1.5 * GIB, 0.1 * totalGib * GIB),
});

const cgroup = (memoryGib: number, pressureFull = 0): ReclaimReading => ({
    memoryBytes: memoryGib * GIB,
    pressure: { memory: { some: pressureFull / 2, full: pressureFull } },
});

// --- reclaimTarget (pure decision) ---

test("no reclaim when host is above its low line", () => {
    expect(reclaimTarget(host(4), cgroup(5), 0)).toBe(0);
    expect(reclaimTarget(host(10), cgroup(8), 0)).toBe(0);
});

test("reclaim when host is under its low line", () => {
    // Host at 2 GiB of 32 GiB: shortfall is 3.2 - 2.0 = 1.2 GiB.
    const target = reclaimTarget(host(2), cgroup(5), 0);
    expect(target).toBeGreaterThan(0);
    // Should not reclaim more than MAX_RECLAIM_BYTES (2 GiB).
    expect(target).toBeLessThanOrEqual(2 * GIB);
});

test("idle sandbox reclaims more than active one", () => {
    const idle = reclaimTarget(host(2), cgroup(5), 0);
    const active = reclaimTarget(host(2), cgroup(5), 3);
    expect(idle).toBeGreaterThan(active);
});

test("larger sandbox reclaims more than smaller one", () => {
    const large = reclaimTarget(host(2), cgroup(8), 0);
    const small = reclaimTarget(host(2), cgroup(2), 0);
    expect(large).toBeGreaterThan(small);
});

test("tiny sandbox is not asked to reclaim", () => {
    expect(reclaimTarget(host(1), cgroup(0.3), 0)).toBe(0);
});

test("no reclaim when memory pressure is too high", () => {
    expect(reclaimTarget(host(1), cgroup(5, PRESSURE_CEILING_PERCENT), 0)).toBe(0);
    expect(reclaimTarget(host(1), cgroup(5, PRESSURE_CEILING_PERCENT + 5), 0)).toBe(0);
});

test("reclaim is allowed just under the pressure ceiling", () => {
    expect(reclaimTarget(host(1), cgroup(5, PRESSURE_CEILING_PERCENT - 1), 0)).toBeGreaterThan(0);
});

test("host under the 1.5 GiB floor gets reclaim too", () => {
    // 8 GiB host: low line is 1.5 GiB (floor). Host at 1.0 GiB.
    expect(reclaimTarget(host(1, 8), cgroup(3), 0)).toBeGreaterThan(0);
});

test("no reclaim when cgroup has no memory reading", () => {
    const noReading: ReclaimReading = { memoryBytes: undefined, pressure: { memory: undefined } };
    expect(reclaimTarget(host(1), noReading, 0)).toBe(0);
});

// --- nextReclaimCooldown (pure pacing) ---

test("a reclaim the host felt keeps the base pace; one it did not doubles the wait, up to the cap", () => {
    expect(nextReclaimCooldown(4 * RECLAIM_COOLDOWN_MS, 200 * MIB, 150 * MIB)).toBe(RECLAIM_COOLDOWN_MS);
    expect(nextReclaimCooldown(RECLAIM_COOLDOWN_MS, 200 * MIB, 50 * MIB)).toBe(2 * RECLAIM_COOLDOWN_MS);
    expect(nextReclaimCooldown(RECLAIM_COOLDOWN_MS, 200 * MIB, -300 * MIB)).toBe(2 * RECLAIM_COOLDOWN_MS);
    expect(nextReclaimCooldown(MAX_RECLAIM_COOLDOWN_MS, 200 * MIB, 0)).toBe(MAX_RECLAIM_COOLDOWN_MS);
    // Nothing given back says nothing about the host: the wait still grows.
    expect(nextReclaimCooldown(RECLAIM_COOLDOWN_MS, 0, 1 * GIB)).toBe(2 * RECLAIM_COOLDOWN_MS);
});

// --- startHostReclaim (integration) ---

afterEach(() => resetSwappinessProbe());

// A failure the way Node reports one from a write to a cgroup file: an Error carrying its errno code.
const errno = (code: string): Error => Object.assign(new Error(`${code}: write`), { code });

const harness = (opts: {
    hostRoom?: HostRoom | undefined;
    cgroupReading?: ReclaimReading;
    activeTurns?: number;
    swappinessProbeSucceeds?: boolean;
    // The reclaim write (not the probe) fails with this errno code.
    writeFails?: string;
}) => {
    let clock = 1_800_000_000_000;
    let hostRoom = opts.hostRoom;
    const writes: { path: string; data: string }[] = [];
    const { logger, lines } = recordingLogger();

    const writeFn = async (path: string, data: string): Promise<void> => {
        // Swappiness probe: "0 swappiness=0" on the reclaim path.
        if (data === "0 swappiness=0") {
            if (opts.swappinessProbeSucceeds === false) {
                throw errno("EINVAL");
            }
            return;
        }
        writes.push({ path, data });
        if (opts.writeFails !== undefined) {
            throw errno(opts.writeFails);
        }
    };

    // The cgroup reading returned after reclaim has less memory (simulate the reclaim effect).
    let readCount = 0;
    const reading = opts.cgroupReading ?? cgroup(5);
    const afterReading: ReclaimReading = {
        ...reading,
        memoryBytes: reading.memoryBytes !== undefined ? Math.max(0, reading.memoryBytes - 200 * MIB) : undefined,
    };

    const reclaim = startHostReclaim(logger, {
        hostSource: async () => hostRoom,
        readCgroup: async () => {
            readCount += 1;
            return readCount <= 1 ? reading : afterReading;
        },
        activeTurns: () => opts.activeTurns ?? 0,
        now: () => clock,
        write: writeFn,
    });

    return {
        reclaim,
        writes,
        lines,
        advance: (ms: number) => void (clock += ms),
        setHost: (room: HostRoom) => void (hostRoom = room),
    };
};

test("no host: no reclaim", async () => {
    const run = harness({ hostRoom: undefined });
    await run.reclaim.pass();
    expect(run.writes).toEqual([]);
    expect(run.lines).toEqual([]);
});

test("host above low line: no reclaim", async () => {
    const run = harness({ hostRoom: host(5) });
    await run.reclaim.pass();
    expect(run.writes).toEqual([]);
});

test("host under low line, idle sandbox: reclaims with swappiness=200", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), activeTurns: 0, swappinessProbeSucceeds: true });
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]!.path).toBe("/sys/fs/cgroup/memory.reclaim");
    expect(run.writes[0]!.data).toMatch(/swappiness=200$/);
    expect(run.lines).toEqual([expect.objectContaining({ level: "info", freed: "200 MiB", partial: false, message: expect.stringContaining("host-reclaim: reclaimed 200 MiB") })]);
});

test("host under low line, active turns: reclaims with swappiness=0", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), activeTurns: 2, swappinessProbeSucceeds: true });
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]!.data).toMatch(/ swappiness=0$/);
});

test("swappiness not supported: reclaims without it", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), activeTurns: 0, swappinessProbeSucceeds: false });
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]!.data).toMatch(/^\d+$/);
});

test("a reclaim is read back on the host a settle later, and one the host did not feel doubles the wait", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), swappinessProbeSucceeds: true });
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    // Within the settle: nothing, not even the read-back.
    run.advance(RECLAIM_COOLDOWN_MS - 1);
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.lines).toHaveLength(1);
    // A settle later the host has not moved: the read-back says so, and the next reclaim waits twice as long.
    run.advance(1);
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.lines[1]).toEqual(
        expect.objectContaining({ level: "info", hostGained: "0 MiB", nextReclaimInS: (2 * RECLAIM_COOLDOWN_MS) / 1000, message: expect.stringContaining("the host had 2.00 GiB available (2.00 GiB before)") }),
    );
    run.advance(RECLAIM_COOLDOWN_MS);
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(2);
});

test("a reclaim the host felt keeps the base pace", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), swappinessProbeSucceeds: true });
    await run.reclaim.pass();
    run.setHost(host(2.5));
    run.advance(RECLAIM_COOLDOWN_MS);
    await run.reclaim.pass();
    expect(run.lines[1]).toEqual(expect.objectContaining({ hostGained: "512 MiB", nextReclaimInS: RECLAIM_COOLDOWN_MS / 1000 }));
    // Still under the low line, the base pace has passed: this same pass reclaimed again.
    expect(run.writes).toHaveLength(2);
});

test("the host climbing back over its line ends the spell without another reclaim", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), swappinessProbeSucceeds: true });
    await run.reclaim.pass();
    run.setHost(host(5));
    run.advance(RECLAIM_COOLDOWN_MS);
    await run.reclaim.pass();
    run.advance(RECLAIM_COOLDOWN_MS);
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
});

test("EAGAIN (the kernel took less than asked) is a partial reclaim, logged like a full one", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), writeFails: "EAGAIN" });
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.lines).toEqual([
        expect.objectContaining({ level: "info", freed: "200 MiB", partial: true, message: expect.stringContaining("the kernel found no more to take") }),
    ]);
});

test("a write that fails for a passing reason is warned and tried again after the cooldown", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), writeFails: "EIO" });
    await run.reclaim.pass();
    expect(run.lines).toEqual([expect.objectContaining({ level: "warn", message: "host-reclaim: write failed", error: "EIO: write" })]);
    run.advance(RECLAIM_COOLDOWN_MS);
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(2);
});

test("memory.reclaim that cannot be written turns reclaim off after one warning", async () => {
    const run = harness({ hostRoom: host(2), cgroupReading: cgroup(5), writeFails: "EACCES" });
    await run.reclaim.pass();
    expect(run.lines).toEqual([expect.objectContaining({ level: "warn", message: expect.stringContaining("reclaim is off until the daemon restarts") })]);
    run.advance(RECLAIM_COOLDOWN_MS * 10);
    await run.reclaim.pass();
    expect(run.writes).toHaveLength(1);
    expect(run.lines).toHaveLength(1);
});

test("tick does not overlap with a pass already underway", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let wrote: ((data: string) => void) | undefined;
    const written = new Promise<string>((resolve) => {
        wrote = resolve;
    });
    let hostReads = 0;
    const writes: string[] = [];
    const reclaim = startHostReclaim(recordingLogger().logger, {
        hostSource: async () => {
            hostReads += 1;
            await held;
            return host(2);
        },
        readCgroup: async () => cgroup(5),
        activeTurns: () => 0,
        write: async (_path, data) => {
            if (data === "0 swappiness=0") {
                return;
            }
            writes.push(data);
            wrote?.(data);
        },
    });
    reclaim.tick();
    reclaim.tick();
    reclaim.tick();
    // A pass reaches the host source synchronously, so the two later ticks would have read it too had they started.
    expect(hostReads).toBe(1);
    release?.();
    await written;
    expect(writes).toHaveLength(1);
});
