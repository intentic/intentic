import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { activeTurnCount } from "../agent/anchors/agent-steering.js";
import { listSubagentSessions, subagentRunning } from "../agent/subagents/subagents.js";
import { armedWatcherCount } from "../agent/verification/watchers.js";
import { connectedCount } from "./presence.js";

// Stops the daemon (SIGTERM to self) when nobody is connected and nothing is running for a full window, since a hosted
// machine bills for as long as this process lives.
// - checked once a minute: presence, in-flight turns, subagents, armed watches, tmux terminal activity
// - quiet is a streak, not a snapshot: any busy answer resets the clock

const exec = promisify(execFile);

// Freshest tmux session_activity across all panes, in ms; 0 when tmux has no server or listing fails, both read as no
// activity rather than an error.
const lastTerminalActivity = async (): Promise<number> => {
    try {
        const { stdout } = await exec("tmux", ["list-panes", "-a", "-F", "#{session_activity}"]);
        const stamps = stdout
            .split("\n")
            .map((line) => Number(line.trim()))
            .filter((value) => Number.isFinite(value) && value > 0);
        return stamps.length === 0 ? 0 : Math.max(...stamps) * 1000;
    } catch {
        return 0;
    }
};

export interface IdleStopProbes {
    readonly connected: () => number;
    readonly turns: () => number;
    readonly delegates: () => number;
    // An armed condition watch; only the daemon can check and wake it, so stopping mid-watch means it never fires.
    readonly watchers: () => number;
    readonly terminalActivityAt: () => Promise<number>;
}

const DEFAULT_PROBES: IdleStopProbes = {
    connected: connectedCount,
    turns: activeTurnCount,
    delegates: () => listSubagentSessions().filter((session) => subagentRunning(session)).length,
    watchers: armedWatcherCount,
    terminalActivityAt: lastTerminalActivity,
};

const CHECK_INTERVAL_MS = 60 * 1000;

// Starts the watchdog; returns a disposer. `stop` defaults to SIGTERM-ing self, which main.ts answers with an orderly
// exit 0.
export const startIdleStop = (
    args: { minutes: number; logger: Logger },
    probes: IdleStopProbes = DEFAULT_PROBES,
    stop: () => void = () => process.kill(process.pid, "SIGTERM"),
): (() => void) => {
    const windowMs = args.minutes * 60 * 1000;
    let quietSince = Date.now();
    // The live states as one question; asked twice, once before and once after the terminal probe awaits.
    const busy = (): boolean => probes.connected() > 0 || probes.turns() > 0 || probes.delegates() > 0 || probes.watchers() > 0;
    const check = async (): Promise<void> => {
        // Live states reset the streak outright; a terminal timestamp only advances the streak's start.
        if (busy()) {
            quietSince = Date.now();
            return;
        }
        const activityAt = await probes.terminalActivityAt();
        // Re-checked after the tmux subprocess await, since something could have become busy while it ran; the clock is
        // re-read too, since the window is measured against now, not when the pass started.
        const now = Date.now();
        if (busy()) {
            quietSince = now;
            return;
        }
        quietSince = Math.max(quietSince, activityAt);
        if (now - quietSince >= windowMs) {
            args.logger.info({ minutes: args.minutes }, "idle-stop: nobody connected and nothing running for the whole window, stopping");
            stop();
        }
    };
    const timer = setInterval(
        () => void check().catch((error: unknown) => args.logger.warn({ err: error }, "idle-stop check failed")),
        CHECK_INTERVAL_MS,
    );
    // A watchdog must never hold the event loop open on its own.
    timer.unref();
    return () => clearInterval(timer);
};
