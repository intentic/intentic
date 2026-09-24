import type { Logger } from "pino";
import { forkedExec } from "@intentic/scaffold";
import { isNoTmuxServer } from "../terminal/tmux-server.js";
import { connectedCount } from "./presence.js";

// Stops the daemon (SIGTERM to self) when nobody is connected and nothing is running for a full window, since a hosted
// machine bills for as long as this process lives.
// - checked once a minute: presence, in-flight turns, subagents, armed watches, tmux terminal activity, and whether a
//   one-time wake is due before this machine could plausibly be back
// - quiet is a streak, not a snapshot: any busy answer resets the clock

// Freshest tmux session_activity across all panes, in ms; 0 when tmux has no server. A listing that failed throws, so
// the check skips its pass instead of reading a terminal it could not see as idle and stopping the machine under it.
const lastTerminalActivity = async (): Promise<number> => {
    const listed = await forkedExec("tmux", ["list-panes", "-a", "-F", "#{session_activity}"]).catch((error: unknown) => {
        if (isNoTmuxServer(error)) {
            return undefined;
        }
        throw error;
    });
    const stamps = (listed?.stdout ?? "")
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
    return stamps.length === 0 ? 0 : Math.max(...stamps) * 1000;
};

export interface IdleStopProbes {
    readonly connected: () => number;
    readonly turns: () => number;
    readonly delegates: () => number;
    // An armed condition watch; only the daemon can check and wake it, so stopping mid-watch means it never fires.
    readonly watchers: () => number;
    readonly terminalActivityAt: () => Promise<number>;
    // The soonest one-time wake, or 0 for none. Same problem as an armed watch: nothing outside restarts this machine
    // for a clock, so a moment somebody was promised passes unnoticed while it sleeps. Recurring schedules are left
    // out on purpose — see the scheduler's own note on why a cron is not worth a night of billing.
    readonly nextOneTimeWakeAt: () => Promise<number>;
}

// Everything the daemon can answer about itself. What its conversations are doing is not among it: turns, children and
// watches are held by the conversations' actors, which the composition root holds and supplies, as it does the
// workspace's own one-time wakes.
export const DEFAULT_PROBES: Omit<IdleStopProbes, "turns" | "delegates" | "watchers"> = {
    connected: connectedCount,
    terminalActivityAt: lastTerminalActivity,
    nextOneTimeWakeAt: () => Promise.resolve(0),
};

const CHECK_INTERVAL_MS = 60 * 1000;

// Starts the watchdog; returns a disposer. `stop` defaults to SIGTERM-ing self, which main.ts answers with an orderly
// exit 0.
export const startIdleStop = (
    args: { minutes: number; logger: Logger },
    probes: IdleStopProbes,
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
        const [activityAt, wakeAt] = await Promise.all([probes.terminalActivityAt(), probes.nextOneTimeWakeAt()]);
        // Re-checked after the tmux subprocess await, since something could have become busy while it ran; the clock is
        // re-read too, since the window is measured against now, not when the pass started.
        const now = Date.now();
        if (busy()) {
            quietSince = now;
            return;
        }
        // A wake landing within one window holds the machine up, because stopping now would miss it: only a visit
        // restarts this daemon, and nothing outside pays attention to a clock in here. One due further out is left to
        // sleep through — an always-awake machine to keep a nightly chore punctual costs more than the chore is worth —
        // and the scheduler fires it late, saying so, when somebody next comes back.
        if (wakeAt > 0 && wakeAt - now <= windowMs) {
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
