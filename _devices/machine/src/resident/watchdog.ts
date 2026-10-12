import { Worker } from "node:worker_threads";
import type { ExitRecord } from "./last-exit.js";

/* THE AGENT'S OWN HANG WATCHDOG (2026-10-05). Every supervisor of this agent (the logon task through the launcher's
   `--wait`, a systemd user unit, a LaunchAgent, the Windows side for a distro) restarts it when it EXITS, and none can
   tell a hung one from a busy one: the heartbeat the agent stamps is only reported. An event loop stuck in a sync call
   or a runaway loop answers nothing, links included, for as long as the machine stays up.

   So the agent watches itself from a second thread. The main loop pings a Worker every five seconds; a Worker has an
   event loop of its own, which keeps running while the main one is stuck. Three minutes without a ping, and the Worker
   writes one line to the agent's log and kills the process. Nothing on the main thread can run by then, so it is a
   SIGKILL from inside: on POSIX the exit is "killed by signal 9", which systemd's `Restart=on-failure` and launchd's
   `KeepAlive { SuccessfulExit = false }` both restart; on Windows it is TerminateProcess with exit code 1, which the
   launcher passes through to the logon task (whose repetition trigger restarts it within five minutes either way) and
   the Windows side reads as a distro agent that stopped.

   Checked under the compiled binary (`bun build --compile`, _tools/scripts/build/build-agent-binaries.sh): a Worker made
   from source text (`eval: true`) runs there with no second file to bundle, and `process.kill(process.pid, "SIGKILL")`
   from it ends the whole process. `process.exit` in a Worker ends only the Worker, in Node and in Bun alike. */

// How often the main loop says it is alive, and how long without that counts as stuck: long enough for the slowest sync
// work the agent does on its loop (a cold `docker` spawnSync, a big JSON parse), short enough that a hung agent is
// back within minutes.
export const WATCHDOG_PING_MS = 5_000;
export const WATCHDOG_STALL_MS = 3 * 60_000;

// The seconds the loop has been stuck, when it has been stuck for at least `limitMs`; undefined while it answers. Pure:
// the same arithmetic the Worker runs below, asserted here without a thread. Read on the MONOTONIC clock: a wall clock
// stepped forward (a time sync, a WSL guest catching up after the host slept) moves no time a loop could have been stuck.
export const stalledFor = (lastPing: number, now: number, limitMs: number): number | undefined =>
    now - lastPing >= limitMs ? Math.round((now - lastPing) / 1000) : undefined;

// Whether the Worker's own checks were held apart by far more than their interval: then the whole process was paused
// (a laptop asleep, a suspended VM, a clock stepped forward), not its main loop alone, and the time since the last ping
// says nothing about a hang. The Worker starts the count again from then. Three intervals and at least three seconds, so
// a busy machine's late timer is not mistaken for one, but never more than half the limit, so every pause long enough to
// reach the limit is seen as one. Pure, and self-contained: it runs inside the Worker as source text. (2026-10-06: the
// first check after a sleep found the last ping minutes old and killed a healthy agent.)
export const pausedAcross = (previousCheck: number, now: number, checkMs: number, limitMs: number): boolean =>
    now - previousCheck >= Math.min(Math.max(checkMs * 3, 3000), limitMs / 2);

/* SLEEP IS NOT A STALL (2026-10-11). The pause above is read on the monotonic clock, which on Windows keeps counting
   through a sleep and on Linux does not: there a suspended machine wakes with its checks on time and its wall clock
   hours ahead. The two clocks drifting apart between two checks is that sleep (or a clock set forward), which is said
   in the log, so a restart minutes later can be read against it, and is never counted toward a stall. Pure and
   self-contained like the rest. */
export const wallJump = (previousCheck: number, now: number, previousWall: number, wall: number): number => wall - previousWall - (now - previousCheck);

// How far the wall clock must run ahead of the monotonic one between two checks to count: well past any slew a time
// daemon makes, short enough that a laptop lid closed for a minute is seen.
export const WALL_JUMP_MS = 10_000;

// How long after a sleep a real stall still names it: the minutes a machine spends waking (Docker, WSL, the network).
export const AFTER_SLEEP_MS = 10 * 60_000;

// The line a sleep or a clock jump leaves. `seconds` is how long the agent was away, as far as either clock can say.
export const sleepLine = (seconds: number, at: Date): string =>
    `[${at.toISOString()}] watchdog: the agent was paused for ${seconds} s (suspected sleep/resume, or the clock was set forward); not a stall, the count starts again\n`;

// The line the Worker writes before it ends the process, with the timestamp every other line of the log carries, and how
// long after a suspected sleep it came when one was seen in the last minutes.
export const stallLine = (seconds: number, at: Date, sinceSleepSeconds?: number): string =>
    `[${at.toISOString()}] event loop stalled for ${seconds} s${sinceSleepSeconds === undefined ? "" : ` (${sinceSleepSeconds} s after a suspected sleep/resume)`}; exiting so the supervisor restarts the agent\n`;

// The Worker's whole program, as source text: a compiled binary has no second file to load, and nothing here may depend
// on the main thread, which is the thing that is stuck. It writes straight to fd 2 (where every supervisor sends the
// agent's log): a Worker's process.stderr is relayed through the main thread, which would never pass it on. Before the
// kill it closes the agent's exit record (last-exit.ts) itself, once the main thread has handed it the record to close:
// nothing on the main thread runs again to say why it went.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync, writeFileSync } = require("node:fs");
const stalledFor = ${stalledFor.toString()};
const stallLine = ${stallLine.toString()};
const sleepLine = ${sleepLine.toString()};
const pausedAcross = ${pausedAcross.toString()};
const wallJump = ${wallJump.toString()};
const say = (line) => { try { writeSync(2, line); } catch { /* allow(silent-catch): a log that will not take the line must not keep a hung agent alive */ } };
let last = performance.now();
let checked = last;
let checkedWall = Date.now();
let sleptAt;
let record;
parentPort.on("message", (message) => {
    last = performance.now();
    if (typeof message === "object" && message !== null) record = message;
});
setInterval(() => {
    const now = performance.now();
    const wall = Date.now();
    const jump = wallJump(checked, now, checkedWall, wall);
    if (pausedAcross(checked, now, workerData.checkMs, workerData.limitMs) || jump >= workerData.jumpMs) {
        last = now;
        sleptAt = now;
        say(sleepLine(Math.round(Math.max(wall - checkedWall, now - checked) / 1000), new Date()));
    }
    checked = now;
    checkedWall = wall;
    const seconds = stalledFor(last, now, workerData.limitMs);
    if (seconds === undefined) return;
    const sinceSleep = sleptAt !== undefined && now - sleptAt <= workerData.afterSleepMs ? Math.round((now - sleptAt) / 1000) : undefined;
    const line = stallLine(seconds, new Date(), sinceSleep);
    say(line);
    if (record !== undefined) {
        try {
            writeFileSync(record.path, JSON.stringify({ ...record.base, reason: "watchdog", at: new Date().toISOString(), detail: line.slice(line.indexOf("]") + 2).trim() }) + "\\n");
        } catch { /* allow(silent-catch): an unwritten record must not keep a hung agent alive; the line above says it */ }
    }
    process.kill(process.pid, "SIGKILL");
}, workerData.checkMs);
`;

// The exit record the watchdog closes when it kills the agent: where it is, and what it said while the agent ran.
export interface WatchdogRecord {
    readonly path: string;
    readonly base: ExitRecord;
}

export interface Watchdog {
    readonly stop: () => void;
    // Hand the Worker this run's exit record, once the agent holds its environment and has started one.
    readonly record: (record: WatchdogRecord) => void;
}

// Started once by the resident agent, before anything else that could block. Neither the Worker nor the ping keeps the
// process alive by itself: the agent's own loop is what does.
export const startWatchdog = ({
    pingMs = WATCHDOG_PING_MS,
    limitMs = WATCHDOG_STALL_MS,
    jumpMs = WALL_JUMP_MS,
}: { readonly pingMs?: number; readonly limitMs?: number; readonly jumpMs?: number } = {}): Watchdog => {
    const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { limitMs, checkMs: Math.min(pingMs, limitMs), jumpMs, afterSleepMs: AFTER_SLEEP_MS },
    });
    worker.unref();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage, which takes no origin
    const ping = setInterval(() => worker.postMessage(0), pingMs);
    ping.unref();
    return {
        stop: () => {
            clearInterval(ping);
            void worker.terminate();
        },
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage, which takes no origin
        record: (record) => worker.postMessage(record),
    };
};
