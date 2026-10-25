import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import type { MachineConfig } from "../../environments/machine.js";
import { type IcRun, lastLine, type Rounds, startRounds } from "./ic-rounds.js";

/* The keeper sleeps idle sandboxes through ic; this loop wakes them on platform requests or ic's local schedule alarms.
 * Use --wait 25 with bounded immediate repolls after held asks; otherwise poll every 15s, or 5m when no sleeper is known.
 * Exit 2 without JSON means old ic rejected --wait: retry plainly and suppress that flag for an hour.
 * Poke links as each wake JSON line arrives, before ic exits; also redial sleepers started elsewhere to bypass retry backoff. */

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

export const sleepArgs = (minutes: number): string[] => ["sandbox", "sleep", "--idle", String(minutes), "--json", "--source", "agent"];
export const WAKES_ARGS: readonly string[] = ["sandbox", "wakes", "--json", "--source", "agent"];
// The longest ic lets the platform hold one ask (`--wait`, 0 to 25 seconds), all of which is asked for.
export const WAKES_WAIT_SECONDS = 25;
export const HELD_WAKES_ARGS: readonly string[] = [...WAKES_ARGS, "--wait", String(WAKES_WAIT_SECONDS)];

// A stop of every sleeper is a `docker stop` each, with its grace period.
export const SLEEP_DEADLINE_MS = 5 * 60_000;
// A wake starts what was asked for, which may apply a saved shape (a recreate); a held ask adds its 25 s to that.
export const WAKES_DEADLINE_MS = 5 * 60_000;
export const WAKE_POLL_MS = 15_000;
export const IDLE_POLL_MS = 5 * 60_000;
// The pace of held asks (see above): the next at once, and never two starting closer together than the spacing.
export const HELD_REPOLL_MS = 250;
export const HELD_SPACING_MS = 5_000;
// How long ic is asked without `--wait` once it has refused the flag.
export const WAIT_REFUSED_MS = 60 * 60_000;
// What clap exits with when it refuses the command line, before ic has run anything; ic's own codes are 1, 3 and 4.
const CLAP_USAGE_EXIT = 2;

const SleptSchema = z.object({ slug: z.string(), slept: z.boolean(), why: z.string().optional(), wakeAt: z.number().optional() });
const WokeSchema = z.object({ slug: z.string(), woke: z.boolean(), error: z.string().optional(), for: z.literal("alarm").optional() });
// `held`: the platform held the ask (`--wait`); absent from an ic or a platform from before the held ask.
const AsleepSchema = z.object({ asleep: z.number().int().nonnegative(), held: z.boolean().optional() });

const linesAs = <T>(schema: z.ZodType<T>, output: string): T[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
            const parsed = parseJsonWith(line, schema);
            return parsed === undefined ? [] : [parsed];
        });

// `alarms`: the moment each sleep's alarm is set for, by slug, for the ones that set one.
export type SleepReading =
    | { readonly unavailable: string }
    | { readonly slept: readonly string[]; readonly alarms: readonly { readonly slug: string; readonly at: number }[] };

// An ic that answered no line of the shape and failed is one without the verb (or no ic at all). Pure.
export const readSleepRun = (run: IcRun): SleepReading => {
    const answers = linesAs(SleptSchema, run.output);
    if (run.code !== 0 && answers.length === 0) {
        return { unavailable: lastLine(run.output)?.trim() ?? `ic exited with ${run.code}` };
    }
    const slept = answers.filter((answer) => answer.slept);
    return {
        slept: slept.map((answer) => answer.slug),
        alarms: slept.flatMap((answer) => (answer.wakeAt === undefined ? [] : [{ slug: answer.slug, at: answer.wakeAt }])),
    };
};

export type WakesReading =
    | { readonly unavailable: string }
    | {
          readonly woke: readonly string[];
          // Of `woke`, the ones started ahead of their alarm rather than for somebody opening them.
          readonly alarmed: readonly string[];
          readonly failed: readonly { readonly slug: string; readonly error: string }[];
          readonly asleep: number | undefined;
          // Whether the platform held the ask: the next one may follow at once.
          readonly held: boolean;
      };

export const readWakesRun = (run: IcRun): WakesReading => {
    const answers = linesAs(WokeSchema, run.output);
    const last = linesAs(AsleepSchema, run.output).at(-1);
    if (run.code !== 0 && answers.length === 0 && last === undefined) {
        return { unavailable: lastLine(run.output)?.trim() ?? `ic exited with ${run.code}` };
    }
    return {
        woke: answers.filter((answer) => answer.woke).map((answer) => answer.slug),
        alarmed: answers.filter((answer) => answer.woke && answer.for === "alarm").map((answer) => answer.slug),
        failed: answers.filter((answer) => !answer.woke).map((answer) => ({ slug: answer.slug, error: answer.error ?? "it did not start" })),
        asleep: last?.asleep,
        held: last?.held === true,
    };
};

// A held ask clap refused: an ic from before `--wait` (see above). The same of an ic without `wakes` at all, whose
// plain ask is then refused too and read as unavailable. Pure.
export const refusedFlag = (run: IcRun): boolean =>
    run.code === CLAP_USAGE_EXIT && run.timedOut !== true && !run.output.split(/\r?\n/).some((line) => line.trim().startsWith("{"));

// What the wake round reads off one line of ic's as it is printed: a sandbox it has just started. Pure.
export const wokeOf = (line: string): { readonly slug: string; readonly alarm: boolean } | undefined => {
    const answer = parseJsonWith(line.trim(), WokeSchema);
    return answer?.woke === true ? { slug: answer.slug, alarm: answer.for === "alarm" } : undefined;
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
        const alarm = reading.alarms.find((set) => set.slug === slug);
        const after =
            alarm === undefined
                ? "it starts again when somebody opens it."
                : `it starts again when somebody opens it, or ahead of what it has scheduled at ${new Date(alarm.at).toISOString()}.`;
        log(`keeper ${slug}: nobody needed it for ${minutes} min, so it is asleep; ${after}`);
    }
    sleepers.counted = Math.max(sleepers.counted, sleepers.slugs.size);
    return reading.slept;
};

export interface WakeState {
    nextIdlePollAt: number;
    unavailableUntil: number;
    // Until when ic is asked without `--wait`, having refused it.
    plainUntil: number;
    readonly said: Map<string, string>;
}

export const newWakeState = (): WakeState => ({ nextIdlePollAt: 0, unavailableUntil: 0, plainUntil: 0, said: new Map() });

export interface WakeSeams {
    // `ic sandbox wakes` with these arguments, each line handed to `onLine` as ic prints it.
    readonly wakes: (args: readonly string[], onLine: (line: string) => void) => Promise<IcRun>;
    // Dials at once every link to a sandbox now starting (resident.ts).
    readonly poke: (slug: string) => void;
    readonly now: () => number;
}

const askWakes = async (seams: WakeSeams, args: readonly string[], onLine: (line: string) => void): Promise<IcRun> =>
    await seams.wakes(args, onLine).catch((error: unknown): IcRun => ({ code: 127, output: errorMessage(error) }));

// The held ask, or the plain one when this ic refuses `--wait` (asked again at once, see above), with what that says.
const askHeldOrPlain = async (state: WakeState, holds: boolean, seams: WakeSeams, onLine: (line: string) => void, log: Log): Promise<IcRun> => {
    const run = await askWakes(seams, holds ? HELD_WAKES_ARGS : WAKES_ARGS, onLine);
    if (!holds) {
        return run;
    }
    if (!refusedFlag(run)) {
        state.said.delete(":wait");
        return run;
    }
    const plain = await askWakes(seams, WAKES_ARGS, onLine);
    if (!("unavailable" in readWakesRun(plain))) {
        state.plainUntil = seams.now() + WAIT_REFUSED_MS;
        const why = run.output.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? `ic exited with ${run.code}`;
        if (state.said.get(":wait") !== why) {
            state.said.set(":wait", why);
            log(`keeper: this machine's ic cannot hold an ask for wakes yet (${why}), so it asks every ${WAKE_POLL_MS / 1_000} s until it is updated.`);
        }
    }
    return plain;
};

// One look: ask only while something sleeps, or once per IDLE_POLL_MS for a sleep this agent did not see. Answers how
// long until the next look: at once after an ask the platform held, else WAKE_POLL_MS.
export const runWakeRound = async (state: WakeState, sleepers: Sleepers, seams: WakeSeams, log: Log): Promise<number> => {
    const now = seams.now();
    if (now < state.unavailableUntil || (!sleeping(sleepers) && now < state.nextIdlePollAt)) {
        return WAKE_POLL_MS;
    }
    state.nextIdlePollAt = now + IDLE_POLL_MS;
    // Only an ask about something asleep is held: the idle look is for a sleep made by hand, and waits on nothing.
    const holds = sleeping(sleepers) && now >= state.plainUntil;
    // Each start is said and its links dialled once, the moment ic prints it; the whole output is the final word.
    const started = new Set<string>();
    const woke = (slug: string, alarm: boolean): void => {
        if (started.has(slug)) {
            return;
        }
        started.add(slug);
        sleepers.slugs.delete(slug);
        log(alarm ? `keeper ${slug}: something it scheduled is due, so it is starting ahead of it.` : `keeper ${slug}: somebody opened it, so it is starting again.`);
        seams.poke(slug);
    };
    const onLine = (line: string): void => {
        const printed = wokeOf(line);
        if (printed !== undefined) {
            woke(printed.slug, printed.alarm);
        }
    };
    const run = await askHeldOrPlain(state, holds, seams, onLine, log);
    const reading = readWakesRun(run);
    if ("unavailable" in reading) {
        // An ic without the verb stays that way until it is updated: asked again at the idle pace, said once.
        state.unavailableUntil = now + IDLE_POLL_MS;
        if (state.said.get(":wakes") !== reading.unavailable) {
            state.said.set(":wakes", reading.unavailable);
            log(`keeper: this machine's ic cannot wake sleeping sandboxes yet (${reading.unavailable}); start one with \`intentic-machine sandbox start <slug>\`.`);
        }
        return WAKE_POLL_MS;
    }
    state.said.delete(":wakes");
    for (const slug of reading.woke) {
        woke(slug, reading.alarmed.includes(slug));
    }
    for (const { slug, error } of reading.failed) {
        log(`keeper ${slug}: somebody opened it, but it did not start — ${error}`);
    }
    if (reading.asleep !== undefined) {
        sleepers.counted = reading.asleep;
        if (reading.asleep === 0) {
            // Nothing sleeps: whatever this agent still took for asleep somebody else woke, and its links hear it too.
            for (const slug of sleepers.slugs) {
                seams.poke(slug);
            }
            sleepers.slugs.clear();
        }
    }
    return reading.held ? Math.max(HELD_REPOLL_MS, HELD_SPACING_MS - (seams.now() - now)) : WAKE_POLL_MS;
};

export const startWakeRound = (log: Log, sleepers: Sleepers, seams: WakeSeams): Rounds => {
    const state = newWakeState();
    let next = WAKE_POLL_MS;
    return startRounds(
        "keeper wakes",
        log,
        WAKE_POLL_MS,
        () => next,
        async () => {
            // A round that throws is paced as one the platform did not hold.
            next = WAKE_POLL_MS;
            next = await runWakeRound(state, sleepers, seams, log);
        },
    );
};
