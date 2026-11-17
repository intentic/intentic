/* HOW MANY OF ONE KIND OF DAEMON JOB RUN AT ONCE, AND IN WHAT ORDER (2026-11-17, the shinobi-society audit). Jobs the
   daemon runs itself in one place (ChatGPT images in one browser, chatgpt-image-jobs.ts) wait their turn here instead of
   being refused: each lane runs up to `most` at once, first come first served, and never two that name the same key at
   once (two prompts into one chat would read each other's answer). A lane runs one at a time until one of its runs has
   gone well since the daemon started (`warm`), since two first runs may race to make the same thing (the sandbox's one
   ChatGPT project). In memory only, like the work it orders. */

// Called once a run is over: `warm` when it went well, which lets the lane run `most` at once from then on.
export type LaneRelease = (warm: boolean) => void;

interface Waiter {
    readonly key: string | undefined;
    readonly admit: (release: LaneRelease) => void;
}

interface Lane {
    // The key of every run in it now, undefined for one that names none.
    readonly running: (string | undefined)[];
    readonly waiting: Waiter[];
    warm: boolean;
}

export interface JobLanes {
    /** Resolves with its release once `lane` has room for a run of `key`, or undefined if `signal` aborts first. */
    readonly enter: (lane: string, key: string | undefined, signal: AbortSignal) => Promise<LaneRelease | undefined>;
    /** How many runs the lane holds now, running and waiting. */
    readonly held: (lane: string) => number;
}

export const createJobLanes = (most: number): JobLanes => {
    const lanes = new Map<string, Lane>();
    const laneOf = (name: string): Lane => {
        const known = lanes.get(name);
        if (known !== undefined) {
            return known;
        }
        const made: Lane = { running: [], waiting: [], warm: false };
        lanes.set(name, made);
        return made;
    };
    const full = (lane: Lane): boolean => lane.running.length >= (lane.warm ? most : 1);
    const room = (lane: Lane, key: string | undefined): boolean => !full(lane) && (key === undefined || !lane.running.includes(key));
    // A run whose key is busy lets the ones behind it go first; a lane out of room stops the look.
    const pump = (name: string, lane: Lane): void => {
        let index = 0;
        while (index < lane.waiting.length && !full(lane)) {
            const waiter = lane.waiting[index];
            if (waiter !== undefined && room(lane, waiter.key)) {
                lane.waiting.splice(index, 1);
                waiter.admit(admitted(name, lane, waiter.key));
            } else {
                index += 1;
            }
        }
        if (lane.running.length === 0 && lane.waiting.length === 0 && !lane.warm) {
            lanes.delete(name);
        }
    };
    const admitted = (name: string, lane: Lane, key: string | undefined): LaneRelease => {
        lane.running.push(key);
        let released = false;
        return (warm) => {
            if (released) {
                return;
            }
            released = true;
            lane.running.splice(lane.running.indexOf(key), 1);
            lane.warm ||= warm;
            pump(name, lane);
        };
    };
    return {
        enter: async (name, key, signal) => {
            if (signal.aborted) {
                return undefined;
            }
            const lane = laneOf(name);
            // Queued, then looked at like every other waiter: one whose key is free goes past one whose key is busy.
            return await new Promise((resolve) => {
                const waiter: Waiter = {
                    key,
                    admit: (release) => {
                        signal.removeEventListener("abort", gone);
                        resolve(release);
                    },
                };
                const gone = (): void => {
                    lane.waiting.splice(lane.waiting.indexOf(waiter), 1);
                    pump(name, lane);
                    resolve(undefined);
                };
                signal.addEventListener("abort", gone, { once: true });
                lane.waiting.push(waiter);
                pump(name, lane);
            });
        },
        held: (name) => {
            const lane = lanes.get(name);
            return lane === undefined ? 0 : lane.running.length + lane.waiting.length;
        },
    };
};
