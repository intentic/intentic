import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type InputWait, inputWaitOf, type RunStillness, type RunToSample, sampleRuns, stillnessAfter } from "./input-wait.js";
import { jobRunnerPids } from "./job-processes.js";

// The runs the daemon is watching for an input wait (input-wait.ts says how one is told), by capture dir: every agent
// command still in its pane (agent-terminals.ts follows a foreground call until it returns) and every background job
// (background-jobs.ts follows it until it ends). One clock looks at all of them, and only while there are any.
//
// What a finding reaches: the marker file beside the capture, which bin/tmux-run returns a foreground call on instead of
// holding it to its soft timeout; and each follower's listener, which the job's card, a parked `wait` and the turn's
// ending read.

/** Beside a run's capture: present while the run is waiting for input, holding what is waiting. bin/tmux-run reads it. */
export const INPUT_WAIT_FILE = "input-wait";

// How often every followed run is looked at, in ms.
const LOOK_MS = 2_000;

// A run younger than this is not looked at: nearly every command is over before then, and a prompt is not a prompt
// until INPUT_WAIT_MS of stillness anyway.
const SETTLE_MS = 3_000;

type Listener = (wait: InputWait | undefined) => void;

interface Followed {
    readonly since: number;
    readonly listeners: Set<Listener>;
    leader: number | undefined;
    stillness: RunStillness | undefined;
    wait: InputWait | undefined;
}

const followed = new Map<string, Followed>();
let clock: NodeJS.Timeout | undefined;
let looking = false;
let started: ((dir: string, wait: InputWait) => void) | undefined;

/** Told of each run the moment it is found waiting for input: the daemon's log, so the record says what stalled. */
export const onInputWaitStarted = (listener: ((dir: string, wait: InputWait) => void) | undefined): void => {
    started = listener;
};

const same = (left: InputWait | undefined, right: InputWait | undefined): boolean =>
    left === right || (left !== undefined && right !== undefined && left.pid === right.pid && left.since === right.since);

// The marker tmux-run reads, written or taken away; a dir the tmp sweep already took has nothing to mark.
const mark = (dir: string, wait: InputWait | undefined): void => {
    try {
        if (wait === undefined) {
            rmSync(join(dir, INPUT_WAIT_FILE), { force: true });
        } else {
            writeFileSync(join(dir, INPUT_WAIT_FILE), `${wait.program} (pid ${String(wait.pid)})\n`, { mode: 0o600 });
        }
    } catch {
        // allow(silent-catch): the run's dir is gone with the run, so there is no reader left for the marker.
    }
};

const settle = (dir: string, entry: Followed, wait: InputWait | undefined): void => {
    if (same(entry.wait, wait)) {
        return;
    }
    const began = entry.wait === undefined && wait !== undefined;
    entry.wait = wait;
    mark(dir, wait);
    if (began && wait !== undefined) {
        started?.(dir, wait);
    }
    for (const listener of entry.listeners) {
        listener(wait);
    }
};

const stop = (): void => {
    if (clock !== undefined && followed.size === 0) {
        clearInterval(clock);
        clock = undefined;
    }
};

const arm = (): void => {
    if (clock === undefined) {
        clock = setInterval(() => void lookAtRuns(), LOOK_MS);
        clock.unref();
    }
};

/**
 * Follows the run whose capture is `dir` until the returned stop is called; `listener` hears each time it starts or
 * stops waiting for input. Several followers share one look: a foreground call filed as a job is followed by both
 * until the call's own follower lets go, so nothing it learned is lost in the hand-over.
 */
export const followRun = (dir: string, listener?: Listener, now: number = Date.now()): (() => void) => {
    let entry = followed.get(dir);
    if (entry === undefined) {
        entry = { since: now, listeners: new Set(), leader: undefined, stillness: undefined, wait: undefined };
        followed.set(dir, entry);
    }
    const own: Listener = listener ?? (() => undefined);
    entry.listeners.add(own);
    arm();
    const held = entry;
    return () => {
        held.listeners.delete(own);
        if (held.listeners.size === 0 && followed.get(dir) === held) {
            followed.delete(dir);
            mark(dir, undefined);
            stop();
        }
    };
};

/** What the run in `dir` is waiting on, if it is waiting for input. */
export const inputWaitAt = (dir: string): InputWait | undefined => followed.get(dir)?.wait;

/**
 * One look at every followed run old enough to look at; never throws, since it runs off a timer. Exported so a test can
 * look on its own clock, over its own /proc.
 */
export const lookAtRuns = async (procRoot = "/proc", now: number = Date.now()): Promise<void> => {
    if (looking) {
        return;
    }
    looking = true;
    try {
        const due = [...followed].filter(([, entry]) => now - entry.since >= SETTLE_MS);
        // A run that has finished or whose dir was swept waits on nobody; its followers let go in their own time.
        const live = due.filter(([dir, entry]) => {
            const over = existsSync(join(dir, "status")) || !existsSync(dir);
            if (over) {
                settle(dir, entry, undefined);
            }
            return !over;
        });
        const unresolved = live.filter(([, entry]) => entry.leader === undefined).map(([dir]) => dir);
        if (unresolved.length > 0) {
            const leaders = await jobRunnerPids(unresolved, procRoot);
            for (const [dir, leader] of leaders) {
                const entry = followed.get(dir);
                if (entry !== undefined) {
                    entry.leader = leader;
                }
            }
        }
        const runs = new Map<string, RunToSample>();
        for (const [dir, entry] of live) {
            if (entry.leader !== undefined) {
                runs.set(dir, { leader: entry.leader, outputPath: join(dir, "out") });
            }
        }
        const samples = await sampleRuns(runs, procRoot, now);
        for (const [dir] of runs) {
            const entry = followed.get(dir);
            if (entry === undefined) {
                continue;
            }
            const sample = samples.get(dir);
            if (sample === undefined) {
                // Its runner is gone: the status is on its way, and nothing is reading a terminal.
                entry.stillness = undefined;
                settle(dir, entry, undefined);
                continue;
            }
            entry.stillness = stillnessAfter(entry.stillness, sample);
            settle(dir, entry, inputWaitOf(entry.stillness));
        }
    } catch {
        // allow(silent-catch): a look that failed (a /proc that could not be listed) finds nothing; the next one tries again.
    } finally {
        looking = false;
    }
};
