import { Worker } from "node:worker_threads";

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
// the same arithmetic the Worker runs below, asserted here without a thread.
export const stalledFor = (lastPing: number, now: number, limitMs: number): number | undefined =>
    now - lastPing >= limitMs ? Math.round((now - lastPing) / 1000) : undefined;

// The line the Worker writes before it ends the process, with the timestamp every other line of the log carries.
export const stallLine = (seconds: number, at: Date): string =>
    `[${at.toISOString()}] event loop stalled for ${seconds} s; exiting so the supervisor restarts the agent\n`;

// The Worker's whole program, as source text: a compiled binary has no second file to load, and nothing here may depend
// on the main thread, which is the thing that is stuck. It writes straight to fd 2 (where every supervisor sends the
// agent's log): a Worker's process.stderr is relayed through the main thread, which would never pass it on.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const stalledFor = ${stalledFor.toString()};
const stallLine = ${stallLine.toString()};
let last = Date.now();
parentPort.on("message", () => { last = Date.now(); });
setInterval(() => {
    const seconds = stalledFor(last, Date.now(), workerData.limitMs);
    if (seconds === undefined) return;
    try { writeSync(2, stallLine(seconds, new Date())); } catch { /* allow(silent-catch): a log that will not take the line must not keep a hung agent alive */ }
    process.kill(process.pid, "SIGKILL");
}, workerData.checkMs);
`;

export interface Watchdog {
    readonly stop: () => void;
}

// Started once by the resident agent, before anything else that could block. Neither the Worker nor the ping keeps the
// process alive by itself: the agent's own loop is what does.
export const startWatchdog = ({
    pingMs = WATCHDOG_PING_MS,
    limitMs = WATCHDOG_STALL_MS,
}: { readonly pingMs?: number; readonly limitMs?: number } = {}): Watchdog => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { limitMs, checkMs: Math.min(pingMs, limitMs) } });
    worker.unref();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage, which takes no origin
    const ping = setInterval(() => worker.postMessage(0), pingMs);
    ping.unref();
    return {
        stop: () => {
            clearInterval(ping);
            void worker.terminate();
        },
    };
};
