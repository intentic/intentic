import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { mapPool } from "@intentic/base/async";
import { readText } from "../cgroup.js";
import { listPids, ownerOf, procUnits } from "../process-scan.js";
import { parseProcStat } from "../proc-stat.js";
import { heldSlots, poolQueueFiles, type QueueWaiter, queueRoot } from "./queue-slots.js";

/* THE QUIET LANE, AS A PARENT AND ITS CHILDREN SEE IT (2026-11-24, the shinobi-society fan-out). A parent spawned eight
   children that each timed benchmarks through `quiet`, which runs one command at a time across the sandbox and first
   waits out every heavy command already running; they queued behind each other for up to 51 minutes, and nothing told
   the parent that more children only made the line longer. A spawn's answer and a wait's progress now say who holds the
   lane and how many wait for it, read when that answer is written.

   bin/queue-run takes the gate under `<root>/.gate` before any slot. An exclusive command (every quiet run) holds the
   TURNSTILE (fd 7) exclusive, writes itself into `holder`, then holds RUNNING (fd 8) once every command let in before it
   has ended, and keeps both until it ends. An ordinary heavy command passes the turnstile shared, an instant, and holds
   RUNNING shared while it lives. So a process holding both descriptors runs alone, one with only the turnstile waits at
   it, and one with only RUNNING was let in and still runs. No file lists who waits at the gate (a `wait.<pid>` file is
   written only once a command is past it, waiting for a slot), so /proc is read for that, as queue-run reads it. */

const QUIET_POOL = "quiet";

const TURNSTILE_FD = 7;
const RUNNING_FD = 8;
// procfs reads in flight at once, as process-scan.ts bounds its own.
const READ_CONCURRENCY = 8;

// One process with a gate descriptor open, as /proc shows it.
export interface GateProcess {
    readonly pid: number;
    readonly ppid: number;
    readonly ageSeconds: number;
    readonly turnstile: boolean;
    readonly running: boolean;
    readonly argv: readonly string[];
    readonly conversation: string | undefined;
}

// What `queue-run` was asked, read off its own argv up to the `--` that starts the command (its own cut-first rule).
export interface QueueRunFlags {
    readonly pool: string | undefined;
    readonly label: string | undefined;
    readonly exclusive: boolean;
}

export const queueRunFlags = (argv: readonly string[]): QueueRunFlags => {
    const cut = argv.indexOf("--");
    const flags = cut < 0 ? argv : argv.slice(0, cut);
    const value = (name: string): string | undefined => {
        const at = flags.indexOf(name);
        const found = at < 0 ? undefined : flags[at + 1];
        return found === undefined || found === "" || found.startsWith("--") ? undefined : found;
    };
    return { pool: value("--pool"), label: value("--label"), exclusive: flags.includes("--exclusive") };
};

// `<pid> <since> <label> <conversation>`, as take_gate writes it; read the way queue-run's own `read -r` splits it.
export interface GateHolderLine {
    readonly pid: number;
    readonly label: string | undefined;
    readonly conversation: string | undefined;
}

export const parseGateHolder = (line: string | undefined): GateHolderLine | undefined => {
    const [pid, since, label, ...rest] = (line?.split("\n")[0] ?? "").trim().split(/\s+/u);
    if (pid === undefined || !/^\d+$/u.test(pid) || since === undefined || !/^\d+$/u.test(since)) {
        return undefined;
    }
    const conversation = rest.join(" ");
    return { pid: Number(pid), label: label === "" ? undefined : label, conversation: conversation === "" ? undefined : conversation };
};

// One command in the lane: whose it is, what queue-run calls it, and how long it has held or waited.
export interface LaneRun {
    readonly pid: number;
    readonly conversation: string | undefined;
    readonly label: string | undefined;
    readonly seconds: number;
}

export interface QuietLane {
    // What runs alone now (the gate's holder), else what holds the quiet pool; undefined when neither is held.
    readonly holder: LaneRun | undefined;
    // Heavy commands let in before the holder and still running: it waits them out before it starts, or runs beside
    // them once its own wait ran out.
    readonly before: number;
    // Commands waiting for their turn to run alone (quiet runs and other exclusive ones), longest wait first.
    readonly waiting: readonly LaneRun[];
    // Ordinary heavy commands held at the gate until the holder ends, longest wait first.
    readonly held: readonly LaneRun[];
}

export interface LaneReading {
    readonly gate: readonly GateProcess[];
    readonly holderLine: GateHolderLine | undefined;
    // The quiet pool's own holders and `wait.<pid>` waiters (queue-slots.ts), for a quiet run that took no gate.
    readonly poolHolders: readonly LaneRun[];
    readonly poolWaiters: readonly QueueWaiter[];
}

const longestFirst = (runs: readonly LaneRun[]): LaneRun[] => [...runs].sort((a, b) => b.seconds - a.seconds);

/**
 * The lane from what was read. A process whose parent also has a gate descriptor is part of that parent's command (a
 * pipeline, a `timeout`, a build's own children), so only the top of each tree counts.
 */
export const quietLaneOf = (reading: LaneReading): QuietLane => {
    const pids = new Set(reading.gate.map((row) => row.pid));
    const tops = reading.gate.filter((row) => !pids.has(row.ppid));
    const runOf = (row: GateProcess, label?: string): LaneRun => ({ pid: row.pid, conversation: row.conversation, label, seconds: row.ageSeconds });
    const alone = tops.filter((row) => row.turnstile && row.running).sort((a, b) => b.ageSeconds - a.ageSeconds)[0];
    const named = alone !== undefined && reading.holderLine?.pid === alone.pid ? reading.holderLine : undefined;
    const gateHolder =
        alone === undefined ? undefined : { ...runOf(alone, named?.label), conversation: alone.conversation ?? named?.conversation };
    const atTurnstile = tops.filter((row) => row.turnstile && !row.running).map((row) => ({ row, flags: queueRunFlags(row.argv) }));
    const waiting = new Map<number, LaneRun>(atTurnstile.filter(({ flags }) => flags.exclusive).map(({ row, flags }) => [row.pid, runOf(row, flags.label)]));
    for (const waiter of reading.poolWaiters) {
        if (!waiting.has(waiter.pid)) {
            waiting.set(waiter.pid, { pid: waiter.pid, conversation: waiter.conversation, label: waiter.label, seconds: waiter.waitSeconds });
        }
    }
    return {
        holder: gateHolder ?? longestFirst(reading.poolHolders)[0],
        before: alone === undefined ? 0 : tops.filter((row) => row.running && !row.turnstile).length,
        waiting: longestFirst([...waiting.values()]),
        held: longestFirst(atTurnstile.filter(({ flags }) => !flags.exclusive).map(({ row, flags }) => runOf(row, flags.label))),
    };
};

/** Whether anything holds the lane or waits for it: the one case a spawn's answer mentions it. */
export const laneInUse = (lane: QuietLane | undefined): lane is QuietLane => lane !== undefined && (lane.holder !== undefined || lane.waiting.length > 0);

const sameTarget = async (pid: number, fd: number, target: string): Promise<boolean> =>
    // allow(silent-catch): a process that exited or has no such descriptor is exactly one not in the lane
    (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined)) === target;

// Every process with a gate descriptor open. Never throws: an unreadable process is one that is not in the lane.
const gateProcesses = async (root: string): Promise<GateProcess[]> => {
    const turnstile = join(root, ".gate", "turnstile");
    const running = join(root, ".gate", "running");
    const [uptimeText, pids, { ticksPerSecond }] = await Promise.all([readText("/proc/uptime"), listPids(), procUnits()]);
    const uptime = Number((uptimeText ?? "").trim().split(/\s+/u)[0]);
    const found: GateProcess[] = [];
    await mapPool(pids, READ_CONCURRENCY, async (pid) => {
        const [onTurnstile, onRunning] = await Promise.all([sameTarget(pid, TURNSTILE_FD, turnstile), sameTarget(pid, RUNNING_FD, running)]);
        if (!onTurnstile && !onRunning) {
            return;
        }
        const [stat, cmdline, environ] = await Promise.all([readText(`/proc/${pid}/stat`), readText(`/proc/${pid}/cmdline`), readText(`/proc/${pid}/environ`)]);
        const parsed = stat === undefined ? undefined : parseProcStat(stat);
        if (parsed === undefined) {
            return;
        }
        const started = parsed.startTimeTicks;
        found.push({
            pid,
            ppid: parsed.ppid,
            ageSeconds: started === undefined || !Number.isFinite(uptime) ? 0 : Math.max(0, Math.round(uptime - started / ticksPerSecond)),
            turnstile: onTurnstile,
            running: onRunning,
            argv: (cmdline ?? "").split("\0").filter((arg) => arg !== ""),
            conversation: environ === undefined || ownerOf(environ) === "" ? undefined : ownerOf(environ),
        });
    });
    return found;
};

const hasSlots = async (poolDir: string): Promise<boolean> => (await readdir(poolDir).catch((): string[] => [])).some((name) => name.startsWith("slot."));

/** The lane as it stands. Never throws: a sandbox that never ran a quiet command has an empty lane. */
export const readQuietLane = async (root = queueRoot()): Promise<QuietLane> => {
    const poolDir = join(root, QUIET_POOL);
    const [gate, holderText, files] = await Promise.all([gateProcesses(root), readText(join(root, ".gate", "holder")), poolQueueFiles(poolDir)]);
    // The gate's holder is the quiet pool's too; the pool is read on its own only for a quiet run that took no gate.
    const alone = gate.some((row) => row.turnstile && row.running);
    const pool = alone || !(await hasSlots(poolDir)) ? [] : (await heldSlots(root, files.holders)).filter((slot) => slot.pool === QUIET_POOL);
    return quietLaneOf({
        gate,
        holderLine: parseGateHolder(holderText),
        poolHolders: pool.map((slot) => ({ pid: slot.pid, conversation: slot.conversation, label: QUIET_POOL, seconds: slot.holderAgeSeconds })),
        poolWaiters: files.waiters,
    });
};
