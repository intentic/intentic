import type { CiRunner, CiRunnerOp } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { FleetContext } from "./context.js";
import type { Holds } from "./fleet-holds.js";
import { answered } from "./sys.js";

/* STARTING AND STOPPING A RUNNER, never under a job: `stop` refuses a runner that is running one, `drain` and `restart`
   wait for it to end and then stop (and, for a restart, start) the unit, as wsl-workers.sh's drain does for a Windows
   smoke job. A runner stopped from here is held down (fleet-holds.ts) so the keeper does not start it again; `start` lifts
   the hold. The drain is watched every few seconds (startDrains), so a runner taking another job in the moment between
   its job ending and its stop is only a moment wide; one that does take one is waited for again. */

// systemd answers a start or stop of a runner unit in seconds; the runner's own shutdown waits up to 30 for its listener.
const UNIT_OP_MS = 90_000;
// How often a drain looks whether its runner's job has ended.
export const DRAIN_LOOK_MS = 3_000;
// How long `journalctl` may take for a tail.
const LOGS_MS = 30_000;

const runnerNamed = async (context: FleetContext, name: string): Promise<CiRunner> => {
    const { runners } = await context.discover();
    const runner = runners.find((candidate) => candidate.name === name);
    if (runner === undefined) {
        throw new Error(`No runner called "${name}" on this computer: ${runners.length === 0 ? "it has no runner units" : `it has ${runners.map((r) => r.name).join(", ")}`}.`);
    }
    return runner;
};

export const systemctl = async (context: FleetContext, verb: "start" | "stop", unit: string): Promise<void> => {
    answered(`systemctl ${verb} ${unit}`, await context.sys.run("systemctl", [verb, unit], { timeoutMs: UNIT_OP_MS }));
};

const withoutHold = (name: string) => (holds: Holds) => Object.fromEntries(Object.entries(holds).filter(([held]) => held !== name));

const drainEntry = (context: FleetContext, after: "stay" | "start") => ({ hold: "drain" as const, at: new Date(context.sys.now()).toISOString(), draining: true, after });

/** One op on one runner, by its name; answers what was done, in a sentence. */
export const runnerOp = async (context: FleetContext, name: string, op: CiRunnerOp): Promise<string> => {
    const release = context.busy.hold();
    try {
        const runner = await runnerNamed(context, name);
        if (runner.state === "not-installed") {
            throw new Error(`${name}'s unit (${runner.unit}) is gone from systemd, so there is nothing to ${op}: register it again, or run its own \`sudo ./svc.sh install\` in ${runner.dir}.`);
        }
        if (op === "start") {
            await context.holds.change(withoutHold(name));
            if (runner.held === "smoke") {
                return `${name} is paused for a Windows smoke job (wsl-workers.sh): it starts when that job resumes the workers.`;
            }
            await systemctl(context, "start", runner.unit);
            return `Started ${name}.`;
        }
        if (op === "stop") {
            if (runner.busy) {
                throw new Error(`${name} is running a job${runner.job === undefined ? "" : ` (${runner.job})`}: drain it instead, which stops it when the job ends.`);
            }
            await context.holds.change((holds) => ({ ...holds, [name]: { hold: "board", at: new Date(context.sys.now()).toISOString(), draining: false, after: "stay" } }));
            await systemctl(context, "stop", runner.unit);
            return `Stopped ${name}; it stays stopped until it is started from here.`;
        }
        const after = op === "restart" ? "start" : "stay";
        await context.holds.change((holds) => ({ ...holds, [name]: drainEntry(context, after) }));
        if (!runner.busy) {
            await finishDrain(context, runner, after);
            return op === "restart" ? `Restarted ${name}.` : `Stopped ${name}: it had no job.`;
        }
        return `${name} is running a job; it ${op === "restart" ? "restarts" : "stops"} the moment that job ends.`;
    } finally {
        release();
    }
};

// A drained runner's stop, and its start for a restart; the hold is what stays.
const finishDrain = async (context: FleetContext, runner: CiRunner, after: "stay" | "start"): Promise<void> => {
    await systemctl(context, "stop", runner.unit);
    if (after === "start") {
        await context.holds.change(withoutHold(runner.name));
        await systemctl(context, "start", runner.unit);
        context.log(`drain: restarted ${runner.name} once its job ended`);
        return;
    }
    await context.holds.change((holds) => ({ ...holds, [runner.name]: { hold: "drain", at: new Date(context.sys.now()).toISOString(), draining: false, after: "stay" } }));
    context.log(`drain: stopped ${runner.name} once its job ended`);
};

/** One look at every waiting drain: a runner whose job has ended is stopped (and started again for a restart). */
export const drainLook = async (context: FleetContext): Promise<void> => {
    const holds = await context.holds.read();
    const waiting = Object.entries(holds).filter(([, entry]) => entry.draining);
    if (waiting.length === 0) {
        return;
    }
    const { runners } = await context.discover();
    for (const [name, entry] of waiting) {
        const runner = runners.find((candidate) => candidate.name === name);
        if (runner === undefined) {
            // A runner removed while it drained has nothing left to stop.
            await context.holds.change(withoutHold(name));
            continue;
        }
        if (!runner.busy) {
            const release = context.busy.hold();
            try {
                // one runner at a time: each stop is systemd's own
                await finishDrain(context, runner, entry.after);
            } finally {
                release();
            }
        }
    }
};

export const journalArgs = (unit: string, tail: number): string[] => ["-u", unit, "-n", String(tail), "--no-pager", "-o", "short-iso"];

/** The end of a runner's journal. */
export const runnerLogs = async (context: FleetContext, name: string, tail: number): Promise<string> => {
    const runner = await runnerNamed(context, name);
    return answered(`journalctl -u ${runner.unit}`, await context.sys.run("journalctl", journalArgs(runner.unit, tail), { timeoutMs: LOGS_MS }));
};
