import type { Logger } from "pino";
import { forkedExec } from "@intentic/base/git";
import { PANEL_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { isNoTmuxServer } from "../../terminal/tmux-server.js";
import { connectedCount } from "../presence.js";

// Stops the daemon (SIGTERM to self) when nobody is connected and nothing is running for a full window, since a hosted
// machine bills for as long as this process lives.
// - checked once a minute: presence, in-flight work (turns, lands, workflows, subagents, armed watches, which is where a
//   background command a turn waits on lives), tmux terminal activity, and the soonest promised wake
// - quiet is a streak, not a snapshot: any busy answer resets the clock
// - a promise due sooner than a sleep is worth holds the machine up; one further out is saved as the platform's alarm
//   before it stops (sleep/hosted-sleep.ts), and the platform starts it again ahead of the moment
// - a boot that alarm made sleeps again after ALARM_GRACE_MS of quiet rather than the whole window, as ic's alarm grace
//   does for a local sandbox, so an hourly chore does not cost twenty minutes an hour. Quiet still waits for every turn,
//   subagent, workflow and watch to end; the grace is lost once a person connects, and waits while a command a turn
//   left running for the person is still up (2026-10-18).
// Webhook and listener automations do not hold a hosted machine up: an always-on receiver would spend a month's hours
// in days. A webhook that arrives while it sleeps is the sender's to retry.

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
    // The soonest promised moment (bootstrap/promised-wakes.ts): crons, one-time automations, booked sends, or 0 for none.
    readonly nextPromisedWakeAt: () => Promise<number>;
    // Background commands still running, a dev server a turn kept for the person among them (background-jobs.ts).
    readonly leftRunning?: () => number;
    // Whether this boot is one the platform's alarm made (sleep/hosted-sleep.ts); asked each pass.
    readonly alarmBoot?: () => boolean;
    // Save the earliest deadline outside this machine before stopping, with the last moment a person was here (0 for
    // none since this boot); false means no alarm was acknowledged.
    readonly prepareSleep?: (at: number, personAt: number) => Promise<boolean>;
    // Retract a saved alarm: a final reading that refuses sleep, or a sleep with nothing due.
    readonly cancelSleep?: (personAt: number) => Promise<boolean>;
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
// Sooner than this and a sleep frees nothing: the platform starts the machine two minutes ahead (hosted-wake-alarm.ts's
// HOSTED_WAKE_LEAD_MS) and five minutes asleep is the least worth a boot (ic's MIN_ASLEEP_MS for a local one).
const NOT_WORTH_SLEEPING_MS = 7 * 60_000;
// The quiet an alarm's boot that no person joined needs before it sleeps again (ic's ALARM_GRACE_MS).
const ALARM_GRACE_MS = 5 * 60_000;

// Starts the watchdog; returns a disposer. `stop` defaults to SIGTERM-ing self, which main.ts answers with an orderly
// exit 0.
export const startIdleStop = (
    args: { minutes: number; logger: Logger },
    probes: IdleStopProbes,
    stop: () => void = () => process.kill(process.pid, "SIGTERM"),
): (() => void) => {
    const windowMs = args.minutes * 60 * 1000;
    let quietSince = Date.now();
    // The last pass that saw a person connected, 0 for none since this boot.
    let personAt = 0;
    let checking = false;
    let disposed = false;
    const dueSoon = (at: number): boolean => at > 0 && at - Date.now() <= NOT_WORTH_SLEEPING_MS;
    // The live states as one question; asked twice, once before and once after the terminal probe awaits. A person seen
    // in either is what ends an alarm boot's grace.
    const busy = (): boolean => {
        if (probes.connected() > 0) {
            personAt = Date.now();
            return true;
        }
        return probes.working() > 0;
    };
    const windowNow = (): number =>
        personAt === 0 && probes.alarmBoot?.() === true && (probes.leftRunning?.() ?? 0) === 0 ? Math.min(windowMs, ALARM_GRACE_MS) : windowMs;
    // Nothing due needs no alarm, so a platform that does not answer cannot hold the machine up: the retraction is asked
    // for and its answer ignored, and an old alarm left standing costs one spurious wake. A deadline must be acknowledged.
    const armed = async (wakeAt: number): Promise<boolean> => {
        if (wakeAt === 0) {
            await probes.cancelSleep?.(personAt);
            return true;
        }
        return probes.prepareSleep === undefined ? false : probes.prepareSleep(wakeAt, personAt);
    };
    const check = async (): Promise<void> => {
        if (busy()) {
            quietSince = Date.now();
            return;
        }
        const [activityAt, wakeAt] = await Promise.all([probes.terminalActivityAt(), probes.nextPromisedWakeAt()]);
        // Re-checked after the tmux subprocess await, since something could have become busy while it ran; the clock is
        // re-read too, since the window is measured against now, not when the pass started.
        const now = Date.now();
        if (busy() || dueSoon(wakeAt)) {
            quietSince = now;
            return;
        }
        quietSince = Math.max(quietSince, activityAt);
        const limit = windowNow();
        if (now - quietSince < limit) {
            return;
        }
        if (!(await armed(wakeAt))) {
            return;
        }
        let stopping = false;
        try {
            // A booking can change while the platform is saving the alarm. Never stop on the obsolete one, or under work
            // that began during that exchange.
            const [currentWake, currentActivity] = await Promise.all([probes.nextPromisedWakeAt(), probes.terminalActivityAt()]);
            if (disposed || busy() || currentWake !== wakeAt || dueSoon(currentWake) || Date.now() - currentActivity < limit) {
                quietSince = Date.now();
                return;
            }
            args.logger.info(
                { minutes: args.minutes, graced: limit < windowMs, wakeAt: wakeAt === 0 ? undefined : wakeAt },
                "idle-stop: nobody connected and nothing running for the whole window, stopping",
            );
            disposed = true;
            stop();
            stopping = true;
        } finally {
            if (!stopping && wakeAt > 0) {
                await probes.cancelSleep?.(personAt);
            }
        }
    };
    const timer = setInterval(
        () => {
            if (checking || disposed) {
                return;
            }
            checking = true;
            void check()
                .catch((error: Error) => {
                    quietSince = Date.now();
                    args.logger.warn({ err: error }, "idle-stop check failed");
                })
                .finally(() => {
                    checking = false;
                });
        },
        CHECK_INTERVAL_MS,
    );
    // A watchdog must never hold the event loop open on its own.
    timer.unref();
    return () => {
        disposed = true;
        clearInterval(timer);
    };
};
