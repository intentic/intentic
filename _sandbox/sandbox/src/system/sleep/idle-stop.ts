import type { Logger } from "pino";
import { forkedExec } from "@intentic/base/git";
import { PANEL_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { isNoTmuxServer } from "../../terminal/tmux-server.js";
import { connectedCount } from "../presence.js";

// Stops the daemon (SIGTERM to self) when nobody is connected and nothing is running for a full window, since a hosted
// machine bills for as long as this process lives.
// - checked once a minute: presence, in-flight work (turns, lands, workflows, subagents, armed watches), tmux terminal
//   activity, continuous receivers, and whether a promised wake is due before this machine could plausibly be back
// - quiet is a streak, not a snapshot: any busy answer resets the clock

// The freshest activity stamp in a `#{session_name} #{session_activity}` listing, in ms; 0 for none. A dev server's
// panel session is left out: its output is a server talking to itself, not a person, and a chatty one would otherwise
// hold a machine nobody uses awake for good (a workspace app in use is seen by its connections instead). Pure.
export const freshestPersonActivity = (listing: string): number => {
    const stamps = listing
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .filter(([session]) => session !== undefined && session !== "" && !session.startsWith(PANEL_SESSION_PREFIX))
        .map(([, stamp]) => Number(stamp))
        .filter((value) => Number.isFinite(value) && value > 0);
    return stamps.length === 0 ? 0 : Math.max(...stamps) * 1000;
};

// Freshest tmux session_activity across all panes but dev servers', in ms; 0 when tmux has no server. A listing that
// failed throws, so the check skips its pass instead of reading a terminal it could not see as idle and stopping the
// machine under it.
export const lastTerminalActivity = async (): Promise<number> => {
    const listed = await forkedExec("tmux", ["list-panes", "-a", "-F", "#{session_name} #{session_activity}"]).catch((error: Error) => {
        if (isNoTmuxServer(error)) {
            return undefined;
        }
        throw error;
    });
    return freshestPersonActivity(listed?.stdout ?? "");
};

export interface IdleStopProbes {
    readonly connected: () => number;
    // What is mid-flight that stopping would cut or strand: turns, lands, workflows, subagents parked or running, and
    // armed watches, which only this daemon can check and wake (bootstrap/working-now.ts, purpose "idle-stop").
    readonly working: () => number;
    readonly terminalActivityAt: () => Promise<number>;
    // The soonest promised moment (bootstrap/promised-wakes.ts), including cron and scheduled sends, or 0 for none.
    // A nearby deadline keeps the machine up; a distant one must be saved outside the machine before stopping.
    readonly nextPromisedWakeAt: () => Promise<number>;
    // Continuous receivers have no outside durable inbox: an enabled webhook or listener must keep receiving.
    readonly keepAwake?: () => Promise<boolean>;
    // Save the earliest deadline outside this machine before stopping; false means no alarm was acknowledged.
    readonly prepareSleep?: (at: number) => Promise<boolean>;
    // Retract a saved alarm if the final reading refuses sleep (including a failed reading).
    readonly cancelSleep?: () => Promise<boolean>;
}

// Everything the daemon can answer about itself. What its conversations are doing is not among it: turns, children and
// watches are held by the conversations' actors, which the composition root holds and supplies, as it does the
// sandbox's promised wakes.
export const DEFAULT_PROBES: Omit<IdleStopProbes, "working"> = {
    connected: connectedCount,
    terminalActivityAt: lastTerminalActivity,
    nextPromisedWakeAt: () => Promise.resolve(0),
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
    let checking = false;
    let disposed = false;
    const dueSoon = (at: number): boolean => at > 0 && at - Date.now() <= Math.max(windowMs, 3 * 60_000);
    // The live states as one question; asked twice, once before and once after the terminal probe awaits.
    const busy = (): boolean => probes.connected() > 0 || probes.working() > 0;
    const check = async (): Promise<void> => {
        // Live states reset the streak outright; a terminal timestamp only advances the streak's start.
        if (busy()) {
            quietSince = Date.now();
            return;
        }
        const [activityAt, wakeAt, kept] = await Promise.all([probes.terminalActivityAt(), probes.nextPromisedWakeAt(), probes.keepAwake?.()]);
        // Re-checked after the tmux subprocess await, since something could have become busy while it ran; the clock is
        // re-read too, since the window is measured against now, not when the pass started.
        const now = Date.now();
        if (busy() || kept === true) {
            quietSince = now;
            return;
        }
        // Close deadlines stay awake; distant ones must be acknowledged by the platform's durable alarm. Include room
        // for its two-minute boot lead even when the idle window has been configured shorter than that.
        if (dueSoon(wakeAt)) {
            quietSince = now;
            return;
        }
        quietSince = Math.max(quietSince, activityAt);
        if (now - quietSince >= windowMs) {
            const armed = probes.prepareSleep === undefined ? wakeAt === 0 : await probes.prepareSleep(wakeAt);
            if (!armed) { return; }
            let stopping = false;
            try {
                // A booking can change while the platform is saving the alarm. Never stop on the obsolete one, or under
                // work or a receiver that became active during that exchange.
                const [currentWake, currentKept, currentActivity] = await Promise.all([
                    probes.nextPromisedWakeAt(), probes.keepAwake?.(), probes.terminalActivityAt(),
                ]);
                if (disposed || busy() || currentKept === true || currentWake !== wakeAt || dueSoon(currentWake) || Date.now() - currentActivity < windowMs) {
                    quietSince = Date.now();
                    return;
                }
                args.logger.info({ minutes: args.minutes }, "idle-stop: nobody connected and nothing running for the whole window, stopping");
                disposed = true;
                stop();
                stopping = true;
            } finally {
                if (!stopping) { await probes.cancelSleep?.(); }
            }
        }
    };
    const timer = setInterval(
        () => {
            if (checking || disposed) { return; }
            checking = true;
            void check().catch((error: Error) => {
                quietSince = Date.now();
                args.logger.warn({ err: error }, "idle-stop check failed");
            }).finally(() => { checking = false; });
        },
        CHECK_INTERVAL_MS,
    );
    // A watchdog must never hold the event loop open on its own.
    timer.unref();
    return () => { disposed = true; clearInterval(timer); };
};
