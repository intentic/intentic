import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import type { Log } from "@intentic/local-agent";
import { holdIcFlow, icInFlight } from "../tools/sandboxes.js";

// THE SHAPE OF EVERY BACKGROUND `ic` ROUND this agent runs over its sandboxes (auto-prepare.ts, auto-backup.ts,
// probation-watch.ts): one slug at a time, never one a person's flow is touching, and a slug that keeps failing sits out
// a doubling number of rounds instead of failing loudly every time. The decisions live here, pure over their inputs,
// so each round is tested without timers or an `ic`.

// Backoff ceiling in rounds: a permanently failing slug is still retried, just rarely.
const MAX_SKIP_TICKS = 8;

// How many rounds a slug sits out after its n-th consecutive failure: 1, 2, 4, up to MAX_SKIP_TICKS.
export const ticksToSkip = (failures: number): number => (failures <= 0 ? 0 : Math.min(2 ** (failures - 1), MAX_SKIP_TICKS));

// Consecutive failures and remaining sit-out rounds, per slug; a slug that succeeds or leaves the fleet takes its
// entries with it.
export interface RoundState {
    readonly failures: Map<string, number>;
    readonly waits: Map<string, number>;
}

export const newRoundState = (): RoundState => ({ failures: new Map(), waits: new Map() });

export interface IcRun {
    readonly code: number;
    readonly output: string;
}

// One job of a round: what it is called in the log, the `ic` run for one slug, and what a run that exited 0 says (a
// success may say nothing, which is the watch's usual answer).
export interface SlugJob {
    readonly name: string;
    readonly run: (slug: string) => Promise<IcRun>;
    readonly said: (slug: string, run: IcRun) => string | undefined;
}

// ic's last output line names the outcome or, on failure, what broke.
export const lastLine = (output: string): string | undefined => output.split(/\r?\n/).findLast((line) => line.trim() !== "");

const runOne = async (state: RoundState, slug: string, job: SlugJob, log: Log): Promise<void> => {
    const release = holdIcFlow(slug, { moves: false });
    let run: IcRun;
    try {
        run = await job.run(slug);
    } catch (error) {
        // runIc throws when this machine has no ic at all; backoff keeps that from repeating every round.
        run = { code: 1, output: errorMessage(error) };
    } finally {
        release();
    }
    if (run.code === 0) {
        state.failures.delete(slug);
        state.waits.delete(slug);
        const said = job.said(slug, run);
        if (said !== undefined) {
            log(said);
        }
        return;
    }
    const failures = (state.failures.get(slug) ?? 0) + 1;
    state.failures.set(slug, failures);
    state.waits.set(slug, ticksToSkip(failures));
    log(
        `${job.name} ${slug}: failed (attempt ${failures}, retrying after ${plural(ticksToSkip(failures), "tick")}) — ${lastLine(run.output) ?? "no output"}`,
    );
};

// Serialised: two ic runs at once double the machine's worst moment for no benefit. `busy` is the slugs a flow of this
// process is touching right now, left alone until the next round.
export const runRound = async (state: RoundState, targets: readonly string[], job: SlugJob, log: Log, busy: ReadonlySet<string> = icInFlight): Promise<void> => {
    // Drops entries for slugs no longer here, so history can't leak onto a reused name.
    for (const slug of [...state.failures.keys(), ...state.waits.keys()]) {
        if (!targets.includes(slug)) {
            state.failures.delete(slug);
            state.waits.delete(slug);
        }
    }
    for (const slug of targets) {
        if (busy.has(slug)) {
            continue;
        }
        const wait = state.waits.get(slug) ?? 0;
        if (wait > 0) {
            state.waits.set(slug, wait - 1);
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one ic run at a time is the point (see above)
        await runOne(state, slug, job, log);
    }
};

export interface Rounds {
    readonly stop: () => void;
}

// A round after `first` ms, then one after each `next()` ms, never two at once: the next is scheduled only once the
// last has finished. A round that throws (docker missing or wedged, a config that does not read) costs that round
// alone, said under `name`: this agent just needs to still be there when the machine is back.
export const startRounds = (name: string, log: Log, first: number, next: () => number, round: () => Promise<void>): Rounds => {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const schedule = (delay: number): void => {
        timer = setTimeout(() => void tick(), delay);
    };
    const tick = async (): Promise<void> => {
        try {
            await round();
        } catch (error) {
            log(`${name}: skipped this round — ${errorMessage(error)}`);
        }
        if (!stopped) {
            schedule(next());
        }
    };
    schedule(first);
    return {
        stop: (): void => {
            stopped = true;
            clearTimeout(timer);
        },
    };
};
