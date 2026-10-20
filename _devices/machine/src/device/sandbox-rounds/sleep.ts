import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
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
   sandbox asks the platform to wake it, and this agent asks the platform for such requests while anything of its
   sleeps (`ic sandbox wakes`), starting what was asked for. While nothing is known to sleep it still asks every five
   minutes, for a sandbox somebody put to sleep by hand.
   THE ASK IS HELD (2026-10-19). Asked every fifteen seconds, a wake waited 7.5 s on average for the next ask, the largest
   part of a wake nothing required. So the ask is `--wait 25`: the platform holds it until somebody asks for a wake or
   the 25 s are up, ic prints each `{"slug","woke"}` line as that start finishes, and its last line says `"held":true`
   when the platform did hold. After a held ask the next follows at once (HELD_REPOLL_MS, never closer than
   HELD_SPACING_MS to the last one's start, so a platform that says held without holding cannot make a loop of ic runs);
   after one that was not (a platform from before the held ask answers at once) the pace stays fifteen seconds. An ic
   from before `--wait` refuses the flag through clap, which exits 2 having printed no JSON (ic itself never exits 2):
   that run is asked again at once without the flag, never read as an ic that cannot wake, and if the plain ask answers,
   ic is asked plainly for an hour (WAIT_REFUSED_MS) before the flag is tried again, since ic is brought up to date under
   a running agent (ic-binary.ts). Matching clap's sentence instead was rejected: its wording moves between clap
   releases, and the exit code says the same thing (docs/architecture/conventions.md, "Reading another program's
   output").
   A WOKEN SANDBOX'S LINK IS DIALLED AT ONCE (2026-10-19). The sleep left this agent's link to it on the dial loop's
   ladder, which past twenty failures rests a quarter of an hour between tries: on rog a sandbox woken at 16:48 had its
   device tools back at 17:12. Each start is acted on the moment ic prints its line, not when ic exits, and `poke` has
   the resident redial every link naming that slug (peer-dial's `retryNow`); so does a sandbox somebody else woke (a
   person's `ic sandbox start`, the desktop app's own `ic sandbox wakes`), once ic counts nothing asleep or the keeper's
   listing shows it running (keeper.ts, relist).
   An ALARM wakes it too (2026-10-18): ic records, as it puts a sandbox to sleep, the soonest moment its daemon promised
   (a cron, a one-time automation), and the same `ic sandbox wakes` starts it a little ahead of that moment, off this
   machine's clock alone, so what it scheduled runs on time. Nothing here changes for it but what the log says. */

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
