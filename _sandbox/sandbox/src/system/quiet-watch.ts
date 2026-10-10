import type { Logger } from "pino";

// SINCE WHEN NOBODY HAS NEEDED THIS SANDBOX, for the host that may put it to sleep. A sandbox on somebody's own computer
// cannot stop itself the way a hosted machine does (idle-stop.ts): Docker starts a container whose daemon exited again
// at once, and only the computer's own keeper can stop it so it stays down (ic: `sandbox sleep`). So the daemon says
// what it knows, through the work signal (workload/work-signal.ts), and the keeper decides:
// - quietSince: when the present quiet streak began; absent while anything needs the sandbox now. Quiet is nobody
//   connected to the editor, nothing in flight that only this daemon's clock moves (bootstrap/working-now.ts, purpose
//   "idle-stop"), no person typing in a terminal, and nobody connected to a workspace app. The last terminal keystroke
//   moves the streak's start forward rather than breaking it, as idle-stop reads it.
// - nextWakeAt: the soonest moment the sandbox promised somebody (a one-time automation, a booked send), which a sleep
//   would silently miss; absent when none.
// Checked once a minute: tmux is a subprocess, and a sleep is measured in tens of minutes.

export interface QuietProbes {
    readonly connected: () => number;
    readonly working: () => number;
    // Freshest terminal activity a person made, in ms; 0 for none.
    readonly terminalActivityAt: () => Promise<number>;
    readonly appsInUse: () => Promise<boolean>;
    // The soonest promised wake, in ms; 0 for none.
    readonly nextWakeAt: () => Promise<number>;
}

export interface QuietReading {
    readonly quietSince?: number;
    readonly nextWakeAt?: number;
}

export interface QuietWatch {
    // The latest reading, synchronously, for a writer that keeps its own beat.
    readonly read: () => QuietReading;
    // One pass, as the timer runs it; exposed for tests.
    readonly check: () => Promise<void>;
    readonly stop: () => void;
}

const CHECK_INTERVAL_MS = 60_000;

const same = (a: QuietReading, b: QuietReading): boolean => a.quietSince === b.quietSince && a.nextWakeAt === b.nextWakeAt;

export const startQuietWatch = (
    probes: QuietProbes,
    options: { readonly logger: Pick<Logger, "warn">; readonly onChange?: () => void; readonly checkMs?: number; readonly now?: () => number },
): QuietWatch => {
    const now = options.now ?? Date.now;
    // When the streak began; undefined while something needs the sandbox.
    let streakStart: number | undefined;
    let reading: QuietReading = {};
    const busy = (): boolean => probes.connected() > 0 || probes.working() > 0;

    const settle = (next: QuietReading): void => {
        if (same(reading, next)) {
            return;
        }
        reading = next;
        options.onChange?.();
    };

    const check = async (): Promise<void> => {
        const wakeAt = await probes.nextWakeAt().catch(() => 0);
        const promised = wakeAt > 0 ? { nextWakeAt: wakeAt } : {};
        if (busy()) {
            streakStart = undefined;
            settle(promised);
            return;
        }
        const [activityAt, inUse] = await Promise.all([probes.terminalActivityAt(), probes.appsInUse()]);
        // Asked again after the awaits: somebody may have connected while tmux and the socket tables were read.
        if (busy() || inUse) {
            streakStart = undefined;
            settle(promised);
            return;
        }
        streakStart ??= now();
        settle({ quietSince: Math.max(streakStart, activityAt), ...promised });
    };

    // A probe that failed (tmux could not list its panes) changes nothing: guessing either way is worse than a minute late.
    const pass = (): void => void check().catch((error: unknown) => options.logger.warn({ err: error }, "quiet watch: a check failed"));
    const timer = setInterval(pass, options.checkMs ?? CHECK_INTERVAL_MS);
    // A watchdog must never hold the event loop open on its own.
    timer.unref();
    pass();
    return { read: () => reading, check, stop: () => clearInterval(timer) };
};
