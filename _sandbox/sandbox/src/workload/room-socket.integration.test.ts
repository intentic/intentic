import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFree, askRoom, type MemoryReading } from "@intentic/constants/memory-room";
import { fileCommandPeaks } from "../system/resources/queue/command-peaks.js";
import { createPeakWatch } from "../system/resources/queue/peak-watch.js";
import { fakePeakProc, PAGE_BYTES, queuedCmdline } from "../system/resources/queue/peak-watch.testing.js";
import { createResourceBudget, type ResourceBudget } from "./resource-budget.js";
import { type CommandPeaks, type RoomSocket, startRoomSocket } from "./room-socket.js";

/* The room socket over a real Unix socket, asked the way queue-run asks it (memory-room): its answer has to be the
   verdict the same budget gives in process, or a heavy command and a turn would be judged by two policies again. */

const GIB = 1024 ** 3;
const box = (limitGib: number, usedGib: number): MemoryReading => ({
    limitBytes: limitGib * GIB,
    usedBytes: usedGib * GIB,
    swapBytes: 0,
    stallPercent: 0,
    oomKills: undefined,
});

const budgetOn = (reading: MemoryReading): ResourceBudget => createResourceBudget({ read: async () => reading, sampleMs: 0, waitIntervalMs: 5 });

let dir: string;
let socket: RoomSocket | undefined;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "room-socket-"));
});

afterEach(async () => {
    await socket?.close();
    socket = undefined;
    await rm(dir, { recursive: true, force: true });
});

const serve = async (budget: ResourceBudget, peaks?: CommandPeaks): Promise<string> => {
    const path = join(dir, "room.sock");
    socket = await startRoomSocket(budget, { warn: () => {} }, { path, peaks });
    return path;
};

test.each([
    ["roomy", box(16, 4)],
    ["short", box(16, 14.5)],
] as const)("on a %s box the socket answers what the budget decides in process", async (_case, reading) => {
    const socketPath = await serve(budgetOn(reading));
    const asked = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath });
    const inProcess = await budgetOn(reading).admit({ workload: "toolchain", attended: false, where: "local" });
    expect(asked.source).toBe("daemon");
    expect(asked.verdict).toBe(inProcess.verdict);
});

test("an admission over the socket is held in the same ledger as a turn's", async () => {
    const budget = budgetOn(box(16, 12));
    const socketPath = await serve(budget);
    expect((await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath })).verdict).toBe("run");
    expect((await budget.snapshot()).reservedBytes).toBe(GIB);
    expect(await askFree({ socketPath })).toEqual({ freeBytes: 3 * GIB, source: "daemon" });
});

test("a wait asked over the socket is held there until the room comes", async () => {
    let reading = box(16, 15);
    const budget = createResourceBudget({ read: async () => reading, sampleMs: 0, waitIntervalMs: 5, now: (() => {
        let at = 0;
        return () => (at += 1_100);
    })() });
    const socketPath = await serve(budget);
    const asked = askRoom({ workload: "toolchain", waitSeconds: 30, socketPath });
    setTimeout(() => {
        reading = box(16, 4);
    }, 30);
    expect(await asked).toMatchObject({ verdict: "run", source: "daemon" });
});

// 2026-11-17, the shinobi-society audit: waits sat out their two minutes and printed only how much was free.
test("a wait over the socket that cannot help is given up early, with why it waited and what is still short", async () => {
    let at = 0;
    const budget = createResourceBudget({ read: async () => box(10, 9.9), sampleMs: 0, waitIntervalMs: 1, now: () => (at += 1_100) });
    const socketPath = await serve(budget);
    const asked = await askRoom({ workload: "toolchain", waitSeconds: 600, socketPath });
    const short = "Sandbox memory is low: 9.9 GiB of 10.0 GiB used";
    expect(asked).toMatchObject({ verdict: "refuse", source: "daemon", stuck: true, diagnosis: short, waitedFor: short });
    expect(asked.waitedMs).toBeLessThan(600_000);
});

test("a class the budget does not know is refused, and the caller falls back to the formula", async () => {
    const socketPath = await serve(budgetOn(box(16, 4)));
    // @ts-expect-error: the point is a class no WorkloadClass names.
    const asked = await askRoom({ workload: "spaceship", waitSeconds: 0, socketPath, read: () => box(16, 4) });
    expect(asked.source).toBe("formula");
});

test.each([
    ["editor-typecheck", 7 * GIB],
    ["scoped-typecheck", 4 * GIB],
] as const)("a %s asked over the socket is held at the price the budget gives it", async (size, held) => {
    const budget = budgetOn(box(16, 4));
    const socketPath = await serve(budget);
    expect((await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size })).verdict).toBe("run");
    expect((await budget.snapshot()).reservedBytes).toBe(held);
});

/* (2026-11-22, the shinobi-society audit) A COMMAND MEASURED HEAVIER THAN ITS RULE SAYS. The owner's table priced every
   cargo command at 512 MiB (`targeted`); `cargo test -p integra-render` ran a test binary that peaked at 7 to 13.5 GB and
   was killed by the memory guard, again and again, after the gate admitted it beside other work. */
const MIB = 1024 ** 2;
const KEY = "cargo-verify @shinobi-society: cargo test --lib -p integra-render";
const COMMAND = "cargo test --lib -p integra-render";
const SIGNATURE = { key: KEY, command: COMMAND, start: 10 };

// Learned peaks from a table, every process found where it was named, and nothing measured.
const knownPeaks = (peakBytes: Record<string, number>): CommandPeaks => ({
    learned: async (key) => (peakBytes[key] === undefined ? undefined : { command: COMMAND, peakBytes: peakBytes[key], runs: 2 }),
    resolve: async (pid) => pid,
    watch: async () => undefined,
    stop: () => undefined,
});

test("a command measured heavier than its rule's price is held at its peak with the margin, and the answer says why", async () => {
    const budget = budgetOn(box(18, 4));
    const socketPath = await serve(budget, knownPeaks({ [KEY]: 9.7 * GIB }));
    const asked = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size: "targeted", signature: SIGNATURE });
    const priced = Math.ceil((9.7 * GIB * 1.15) / MIB) * MIB;
    expect(asked).toMatchObject({ verdict: "run", source: "daemon", costBytes: priced, priced: { bytes: priced, peakBytes: 9.7 * GIB, runs: 2, command: COMMAND } });
    expect((await budget.snapshot()).reservedBytes).toBe(priced);
});

test("a command never measured, or measured lighter than its rule, is priced exactly as before", async () => {
    const budget = budgetOn(box(16, 4));
    const socketPath = await serve(budget, knownPeaks({ "cargo @shinobi-society: cargo build": 3 * GIB }));
    const unmeasured = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size: "targeted", signature: SIGNATURE });
    expect(unmeasured).toMatchObject({ verdict: "run", costBytes: 512 * MIB });
    expect(unmeasured.priced).toBeUndefined();
    const lighter = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size: "cargo-build", signature: { ...SIGNATURE, key: "cargo @shinobi-society: cargo build" } });
    expect(lighter).toMatchObject({ verdict: "run", costBytes: 7 * GIB });
    expect(lighter.priced).toBeUndefined();
    expect((await budget.snapshot()).reservedBytes).toBe(512 * MIB + 7 * GIB);
});

test("a peak past what the sandbox could hold prices the command at the sandbox's limit, where it waits like any large one", async () => {
    const socketPath = await serve(budgetOn(box(16, 4)), knownPeaks({ [KEY]: 15 * GIB }));
    const asked = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size: "targeted", signature: SIGNATURE });
    expect(asked).toMatchObject({ verdict: "wait", costBytes: 16 * GIB, needBytes: 17 * GIB });
});

// The stuck rule starts a command whose wait cannot help: one measured to need more than is free is known to be killed
// if it starts short, so it is held to its deadline, and starts only if room came.
test("a command priced by its measured peak is not given up early on: it waits out its deadline for room", async () => {
    let at = 0;
    let reading = box(18, 14);
    const budget = createResourceBudget({ read: async () => reading, sampleMs: 0, waitIntervalMs: 1, now: () => (at += 1_100) });
    const socketPath = await serve(budget, knownPeaks({ [KEY]: 9.7 * GIB }));
    const short = await askRoom({ workload: "toolchain", waitSeconds: 120, socketPath, size: "targeted", signature: SIGNATURE });
    expect(short).toMatchObject({ verdict: "refuse", source: "daemon" });
    expect(short.stuck).toBeUndefined();
    expect(short.waitedMs).toBeGreaterThanOrEqual(120_000);
    at = 0;
    setTimeout(() => {
        reading = box(18, 2);
    }, 30);
    expect(await askRoom({ workload: "toolchain", waitSeconds: 600, socketPath, size: "targeted", signature: { ...SIGNATURE, start: 11 } })).toMatchObject({ verdict: "run" });
});

test("a run the socket admitted is measured, and the next run of the same command is priced by its peak", async () => {
    const { proc, processes } = fakePeakProc();
    processes.set(500, { ppid: 400, start: 10, rssPages: 1_000, cmdline: queuedCmdline("cargo", "test", "-p", "integra-render", "--lib") });
    const records = fileCommandPeaks(dir);
    const watch = createPeakWatch({ record: records.record, proc, sampleMs: 0 });
    const budget = createResourceBudget({ read: async () => box(18, 4), sampleMs: 0, waitIntervalMs: 5, alive: () => true });
    const socketPath = await serve(budget, { ...watch, learned: records.learned });

    const first = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size: "targeted", pid: 500, signature: SIGNATURE });
    expect(first).toMatchObject({ verdict: "run", costBytes: 512 * MIB });
    // queue-run execs into cargo, whose test binary grows to 8.8 GiB, and the run ends.
    processes.set(500, { ppid: 400, start: 10, rssPages: 2_000, cmdline: "cargo\0test\0" });
    const binaryPages = Math.round((8.8 * GIB) / PAGE_BYTES);
    processes.set(501, { ppid: 500, start: 11, rssPages: binaryPages, cmdline: "integra_render-1f\0" });
    await watch.look();
    processes.delete(500);
    processes.delete(501);
    await watch.look();

    const peak = (2_000 + binaryPages) * PAGE_BYTES;
    const learned = Math.round(peak / MIB) * MIB;
    const next = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath, size: "targeted", pid: 600, signature: { ...SIGNATURE, start: 20 } });
    const priced = Math.ceil(Math.ceil(learned * 1.15) / MIB) * MIB;
    expect(next).toMatchObject({ verdict: "run", costBytes: priced, priced: { bytes: priced, peakBytes: learned, runs: 1, command: COMMAND } });
});
