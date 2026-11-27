import { errorMessage } from "@intentic/base/errors";

/* WHEN A ROUND OF READING POSTHOG RUNS. Every `every` milliseconds; a nudge (a PostHog alert posting to the door, the
   view's Refresh) brings the next one forward, never closer than `gap` to the end of the last; and two never run at
   once: a nudge or a refresh during a round asks for one more after it, which the waiting refresh then resolves with. */

export interface RoundTiming {
    readonly every: number;
    readonly gap: number;
    readonly first: number;
}

export interface RoundScheduler {
    // A round now, answered when it (and any asked for while it ran) ends.
    readonly refresh: () => Promise<void>;
    // A round soon, for a caller that does not wait.
    readonly nudge: () => void;
    readonly start: () => void;
    readonly stop: () => void;
}

export const roundScheduler = (round: () => Promise<void>, timing: RoundTiming, now: () => number, log: (message: string) => void): RoundScheduler => {
    let running: Promise<void> | undefined;
    let again = false;
    let lastEnded = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = { stopped: false };

    const schedule = (delay: number): void => {
        if (live.stopped) {
            return;
        }
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => void refresh(), delay);
    };

    // One round; answers whether another was asked for while it ran.
    const once = async (): Promise<boolean> => {
        again = false;
        await round().catch((error: Error) => log(`a PostHog round failed: ${errorMessage(error)}`));
        return again && !live.stopped;
    };

    const refresh = async (): Promise<void> => {
        if (running !== undefined) {
            again = true;
            return running;
        }
        running = (async () => {
            try {
                let more = await once();
                while (more) {
                    more = await once();
                }
            } finally {
                lastEnded = now();
                running = undefined;
                schedule(timing.every);
            }
        })();
        return running;
    };

    return {
        refresh,
        nudge: () => {
            if (running !== undefined) {
                again = true;
                return;
            }
            schedule(Math.max(0, lastEnded + timing.gap - now()));
        },
        start: () => schedule(timing.first),
        stop: () => {
            live.stopped = true;
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        },
    };
};
