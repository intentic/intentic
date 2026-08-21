import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { activeTurnCount } from "../agent/agent-steering.js";
import { listSubagentSessions, subagentRunning } from "../agent/subagents.js";
import { armedWatcherCount } from "../agent/watchers.js";
import { connectedCount } from "./presence.js";

/* THE HOSTED LANE'S ECONOMICS, DAEMON-SIDE. On a machine the platform runs, compute bills for as long as this
 * process lives, so a sandbox nobody is in and nothing is happening on should not be running. This module is
 * the verdict and the act: once every minute it asks five questions, and only when all five have answered
 * "quiet" for the whole configured window does it send the daemon its own SIGTERM, the ordinary graceful
 * shutdown (marker stamped "exited", subsystems stopped, exit 0), which under the hosted flavor's bounded
 * on-failure restart policy is precisely what stops the machine without ever reading as a crash. The platform
 * starts the machine again on the next visit; /work and /history are the volume and lose nothing.
 *
 * The four questions, and why each one:
 *   - anybody connected? (presence roster), a tab left open is a person who expects the box alive, even one
 *     that reported itself idle; stopping under a watcher is the one unforgivable version of this feature.
 *   - a turn in flight?, turns outlive the tab that started them by design (close the laptop, the agent
 *     works on); the machine must too.
 *   - a delegate child alive?, same reason, one level down: codex/opencode runs the roster tracks as
 *     pending/running/blocked/paused are work in progress even between their parent turns.
 *   - a condition watch armed?, a promise made between turns: the agent told the user it would act when an
 *     outside thing happens, and this daemon is the only process that can notice it happening.
 *   - a terminal saying anything?, tmux session_activity within the window covers the rest of the living
 *     world: a build somebody left running, a dev server logging requests (which is what keeps a sandbox
 *     alive while its preview URL is being visited), a chatty automation in its job-* pane. A pane sitting
 *     at a silent prompt goes quiet with everything else, which is the point. An sshd session (desktop sync
 *     mid-transfer) is covered the same way. Mutagen's agent writes into no pane, but sync exists to mirror
 *     an EDITOR someone is using, and that someone shows up in presence.
 *
 * Quiet is a STREAK, not a snapshot: any busy answer resets the clock, and the stop fires only when the
 * streak outlasts the window. The check itself is cheap (two map sizes, one tmux list), so a minute's cadence
 * costs nothing and reacts fast enough for a 20-minute window. */

const exec = promisify(execFile);

// The freshest tmux session_activity across all panes, ms epoch: 0 when tmux has no server (nothing ever
// ran) or the listing fails, both of which read as "no terminal activity" rather than as an error.
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
    // An armed condition watch (agent/watchers.ts), the daemon is the only thing that can run its check and
    // wake the agent on it, so a machine mid-watch is not idle: stopping it is how a watch silently never fires.
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

// Start the watchdog; returns its stop. `stop` (the act, injected for tests) defaults to the daemon's own
// graceful path. SIGTERM to self, which main.ts answers with an orderly exit 0.
export const startIdleStop = (
    args: { minutes: number; logger: Logger },
    probes: IdleStopProbes = DEFAULT_PROBES,
    stop: () => void = () => process.kill(process.pid, "SIGTERM"),
): (() => void) => {
    const windowMs = args.minutes * 60 * 1000;
    let quietSince = Date.now();
    const check = async (): Promise<void> => {
        const now = Date.now();
        // The live states reset the streak outright; terminal activity is a TIMESTAMP, so it advances the
        // streak's start instead, one window after the last line of output, not two.
        if (probes.connected() > 0 || probes.turns() > 0 || probes.delegates() > 0 || probes.watchers() > 0) {
            quietSince = now;
            return;
        }
        quietSince = Math.max(quietSince, await probes.terminalActivityAt());
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
