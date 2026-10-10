import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import type { MachineConfig } from "../../environments/machine.js";
import { type IcRun, lastLine, type Rounds, startRounds } from "./ic-rounds.js";

/* UNUSED SANDBOXES SLEEP, AND COME BACK WHEN SOMEBODY ASKS (2026-10-10). A PC holding a dozen sandboxes, of which one or
   two are in use, held every one of them up: about 1.4 GB each, measured on rog. A sandbox cannot put itself to sleep
   here (Docker starts a container whose daemon exited again at once), so the keeper does, right after its sweep:
   `ic sandbox sleep --idle <minutes>` stops, through Docker, every sandbox whose daemon has said for that long that
   nobody needs it (its work signal's `quietSince`, workload/work-signal.ts in the sandbox), and ic records it asleep.
   Waking is the other half, and the platform cannot do it: it never calls a machine. A browser that finds a sleeping
   sandbox asks the platform to wake it, and this agent asks the platform for such requests every fifteen seconds while
   anything of its sleeps (`ic sandbox wakes`), starting what was asked for. While nothing is known to sleep it still asks
   every five minutes, for a sandbox somebody put to sleep by hand. */

// How long a sandbox goes unneeded before it sleeps, unless machine.json says otherwise; 0 there is never.
export const DEFAULT_SLEEP_MINUTES = 30;

export const sleepMinutesOf = (config: MachineConfig): number => {
    const minutes = config.sandboxSleepMinutes;
    return minutes === undefined || !Number.isInteger(minutes) || minutes < 0 ? DEFAULT_SLEEP_MINUTES : minutes;
};

// The config with the minutes set as asked: the default is stored as the key's absence, as every switch here is. Pure.
export const withSleepMinutes = (config: MachineConfig, minutes: number): MachineConfig => {
    const { sandboxSleepMinutes: _was, ...rest } = config;
    return minutes === DEFAULT_SLEEP_MINUTES ? rest : { ...rest, sandboxSleepMinutes: minutes };
};

export const sleepStatus = (minutes: number): string =>
    minutes === 0
        ? "Sleep: off. Every sandbox on this machine stays up until somebody stops it. `intentic-machine sandbox sleep-after 30` turns it back on."
        : `Sleep: after ${minutes} min. A sandbox on this machine that nobody has needed for that long (no editor open on it, no agent working, no terminal typed in, no app of it open) is stopped by the keeper, and starts again by itself when somebody opens it. \`intentic-machine sandbox sleep-after off\` keeps them all up.`;

export const sleepArgs = (minutes: number): string[] => ["sandbox", "sleep", "--idle", String(minutes), "--json", "--source", "agent"];
export const WAKES_ARGS: readonly string[] = ["sandbox", "wakes", "--json", "--source", "agent"];

// A stop of every sleeper is a `docker stop` each, with its grace period.
export const SLEEP_DEADLINE_MS = 5 * 60_000;
// A wake starts what was asked for, which may apply a saved shape (a recreate).
export const WAKES_DEADLINE_MS = 5 * 60_000;
export const WAKE_POLL_MS = 15_000;
export const IDLE_POLL_MS = 5 * 60_000;

const SleptSchema = z.object({ slug: z.string(), slept: z.boolean(), why: z.string().optional() });
const WokeSchema = z.object({ slug: z.string(), woke: z.boolean(), error: z.string().optional() });
const AsleepSchema = z.object({ asleep: z.number().int().nonnegative() });

const linesAs = <T>(schema: z.ZodType<T>, output: string): T[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
            try {
                const parsed = schema.safeParse(JSON.parse(line));
                return parsed.success ? [parsed.data] : [];
            } catch {
                // allow(silent-catch): a line that is not JSON is ic's prose, which says nothing a JSON line does not
                return [];
            }
        });

export type SleepReading = { readonly unavailable: string } | { readonly slept: readonly string[] };

// An ic that answered no line of the shape and failed is one without the verb (or no ic at all). Pure.
export const readSleepRun = (run: IcRun): SleepReading => {
    const answers = linesAs(SleptSchema, run.output);
    if (run.code !== 0 && answers.length === 0) {
        return { unavailable: lastLine(run.output)?.trim() ?? `ic exited with ${run.code}` };
    }
    return { slept: answers.filter((answer) => answer.slept).map((answer) => answer.slug) };
};

export type WakesReading =
    | { readonly unavailable: string }
    | {
          readonly woke: readonly string[];
          readonly failed: readonly { readonly slug: string; readonly error: string }[];
          readonly asleep: number | undefined;
      };

export const readWakesRun = (run: IcRun): WakesReading => {
    const answers = linesAs(WokeSchema, run.output);
    const asleep = linesAs(AsleepSchema, run.output).at(-1)?.asleep;
    if (run.code !== 0 && answers.length === 0 && asleep === undefined) {
        return { unavailable: lastLine(run.output)?.trim() ?? `ic exited with ${run.code}` };
    }
    return {
        woke: answers.filter((answer) => answer.woke).map((answer) => answer.slug),
        failed: answers.filter((answer) => !answer.woke).map((answer) => ({ slug: answer.slug, error: answer.error ?? "it did not start" })),
        asleep,
    };
};

/* WHAT THIS AGENT KNOWS SLEEPS, shared by the keeper (which puts sandboxes to sleep, leaves a sleeping one's dead link
   alone, and reads the listing) and the wake round (which polls only while something sleeps). */
export interface Sleepers {
    readonly slugs: Set<string>;
    // The count ic last gave, which can name sleepers this agent never saw fall asleep (a sleep made by hand).
    counted: number;
}

export const newSleepers = (): Sleepers => ({ slugs: new Set(), counted: 0 });

const sleeping = (sleepers: Sleepers): boolean => sleepers.slugs.size > 0 || sleepers.counted > 0;

export interface SleepSeams {
    readonly minutes: () => Promise<number>;
    readonly sleep: (minutes: number) => Promise<IcRun>;
}

// One pass after the keeper's sweep. Said: what fell asleep, and once per reason, an ic that cannot do it.
export const runSleep = async (sleepers: Sleepers, seams: SleepSeams, said: Map<string, string>, log: Log): Promise<readonly string[]> => {
    // allow(silent-catch): a config that does not read is the keeper's own switch failing, said by it; nothing sleeps meanwhile
    const minutes = await seams.minutes().catch(() => 0);
    if (minutes <= 0) {
        return [];
    }
    const run = await seams.sleep(minutes).catch((error: unknown): IcRun => ({ code: 127, output: errorMessage(error) }));
    const reading = readSleepRun(run);
    if ("unavailable" in reading) {
        const line = `keeper: this machine's ic cannot put unused sandboxes to sleep yet (${reading.unavailable}); they stay up until it is updated.`;
        if (said.get(":sleep") !== line) {
            said.set(":sleep", line);
            log(line);
        }
        return [];
    }
    said.delete(":sleep");
    for (const slug of reading.slept) {
        sleepers.slugs.add(slug);
        log(`keeper ${slug}: nobody needed it for ${minutes} min, so it is asleep; it starts again when somebody opens it.`);
    }
    sleepers.counted = Math.max(sleepers.counted, sleepers.slugs.size);
    return reading.slept;
};

export interface WakeState {
    nextIdlePollAt: number;
    unavailableUntil: number;
    readonly said: Map<string, string>;
}

export const newWakeState = (): WakeState => ({ nextIdlePollAt: 0, unavailableUntil: 0, said: new Map() });

export interface WakeSeams {
    readonly wakes: () => Promise<IcRun>;
    readonly now: () => number;
}

// One look: ask only while something sleeps, or once per IDLE_POLL_MS for a sleep this agent did not see.
export const runWakeRound = async (state: WakeState, sleepers: Sleepers, seams: WakeSeams, log: Log): Promise<void> => {
    const now = seams.now();
    if (now < state.unavailableUntil || (!sleeping(sleepers) && now < state.nextIdlePollAt)) {
        return;
    }
    state.nextIdlePollAt = now + IDLE_POLL_MS;
    const run = await seams.wakes().catch((error: unknown): IcRun => ({ code: 127, output: errorMessage(error) }));
    const reading = readWakesRun(run);
    if ("unavailable" in reading) {
        // An ic without the verb stays that way until it is updated: asked again at the idle pace, said once.
        state.unavailableUntil = now + IDLE_POLL_MS;
        if (state.said.get(":wakes") !== reading.unavailable) {
            state.said.set(":wakes", reading.unavailable);
            log(`keeper: this machine's ic cannot wake sleeping sandboxes yet (${reading.unavailable}); start one with \`intentic-machine sandbox start <slug>\`.`);
        }
        return;
    }
    state.said.delete(":wakes");
    for (const slug of reading.woke) {
        sleepers.slugs.delete(slug);
        log(`keeper ${slug}: somebody opened it, so it is starting again.`);
    }
    for (const { slug, error } of reading.failed) {
        log(`keeper ${slug}: somebody opened it, but it did not start — ${error}`);
    }
    if (reading.asleep !== undefined) {
        sleepers.counted = reading.asleep;
        if (reading.asleep === 0) {
            sleepers.slugs.clear();
        }
    }
};

export const startWakeRound = (log: Log, sleepers: Sleepers, seams: WakeSeams): Rounds => {
    const state = newWakeState();
    return startRounds("keeper wakes", log, WAKE_POLL_MS, () => WAKE_POLL_MS, async () => await runWakeRound(state, sleepers, seams, log));
};
