import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { fakeKeeper, fixRun, linkView } from "../../testing.js";
import type { IcRun } from "../tools/sandboxes.js";
import { newKeeperState, runKeeperRound } from "./keeper.js";
import {
    DEFAULT_SLEEP_MINUTES,
    HELD_REPOLL_MS,
    HELD_SPACING_MS,
    HELD_WAKES_ARGS,
    IDLE_POLL_MS,
    newSleepers,
    newWakeState,
    readSleepRun,
    readWakesRun,
    refusedFlag,
    runWakeRound,
    sleepArgs,
    sleepMinutesOf,
    startWakeRound,
    WAIT_REFUSED_MS,
    WAKE_POLL_MS,
    WAKES_ARGS,
    withSleepMinutes,
    wokeOf,
} from "./sleep.js";
import { sleepWord } from "../sandbox-cli.js";

/* Putting unneeded sandboxes to sleep after the keeper's sweep, and waking the ones somebody asked for: every decision
   over fake runs of ic, with the clock moved by hand. */

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const URL = "https://sandbox-0123456789ab.sbx.intentic.dev";
const SLUG = "sandbox-0123456789ab";
const CLAP = "error: unrecognized subcommand 'sleep'\n\nUsage: ic sandbox <COMMAND>\n";
// What an ic from before the held ask says to `--wait` (clap 4's words, exit 2), and one from before `wakes` to the verb.
const NO_WAIT: IcRun = {
    code: 2,
    output: "error: unexpected argument '--wait' found\n\n  tip: to pass '--wait' as a value, use '-- --wait'\n\nUsage: ic sandbox wakes [OPTIONS]\n\nFor more information, try '--help'.",
};
const NO_WAKES: IcRun = { code: 2, output: "error: unrecognized subcommand 'wakes'\n\nUsage: ic sandbox <COMMAND>\n\nFor more information, try '--help'." };

const run = (lines: readonly unknown[], code = 0): IcRun => ({ code, output: ["intentic: looking…", ...lines.map((line) => JSON.stringify(line))].join("\n") });

describe("what ic says", () => {
    test("the keeper asks for every sandbox quiet for the configured stretch, in JSON, as the agent", () => {
        expect(sleepArgs(30)).toEqual(["sandbox", "sleep", "--idle", "30", "--json", "--source", "agent"]);
    });

    test("a sleep run names what fell asleep; an ic without the verb is unavailable, not a sleep of nothing", () => {
        expect(readSleepRun(run([{ slug: "a", slept: true }, { slug: "b", slept: false, why: "busy" }]))).toEqual({ slept: ["a"], alarms: [] });
        expect(readSleepRun({ code: 2, output: CLAP })).toEqual({ unavailable: "Usage: ic sandbox <COMMAND>" });
        expect(readSleepRun(run([]))).toEqual({ slept: [], alarms: [] });
        // A sleep that set an alarm says for when; one that stayed awake sets none whatever it carries.
        expect(readSleepRun(run([{ slug: "a", slept: true, wakeAt: 9_000 }, { slug: "b", slept: false, wakeAt: 5_000 }]))).toEqual({
            slept: ["a"],
            alarms: [{ slug: "a", at: 9_000 }],
        });
    });

    test("a wakes run names what it started, what would not, and how many still sleep", () => {
        expect(readWakesRun(run([{ slug: "a", woke: true }, { slug: "b", woke: false, error: "docker said no" }, { asleep: 1 }]))).toEqual({
            woke: ["a"],
            alarmed: [],
            failed: [{ slug: "b", error: "docker said no" }],
            asleep: 1,
            held: false,
        });
        expect(readWakesRun(run([{ slug: "a", woke: true, for: "alarm" }, { slug: "b", woke: false, for: "alarm" }, { asleep: 0 }]))).toEqual({
            woke: ["a"],
            alarmed: ["a"],
            failed: [{ slug: "b", error: "it did not start" }],
            asleep: 0,
            held: false,
        });
        expect("unavailable" in readWakesRun({ code: 2, output: CLAP })).toBe(true);
    });

    test("a held ask asks the platform to hold it for 25 s, and its last line says whether it did", () => {
        expect(HELD_WAKES_ARGS).toEqual(["sandbox", "wakes", "--json", "--source", "agent", "--wait", "25"]);
        expect(readWakesRun(run([{ slug: "a", woke: true }, { asleep: 1, held: true }]))).toEqual({ woke: ["a"], alarmed: [], failed: [], asleep: 1, held: true });
        expect(readWakesRun(run([{ asleep: 1, held: false }]))).toMatchObject({ asleep: 1, held: false });
        // Only the last count speaks for the run.
        expect(readWakesRun(run([{ asleep: 2, held: true }, { asleep: 1 }]))).toMatchObject({ asleep: 1, held: false });
    });

    test("clap's refusal of a command line, exit 2 with no JSON, is told from every other failure by its structure", () => {
        expect(refusedFlag(NO_WAIT)).toBe(true);
        expect(refusedFlag(NO_WAKES)).toBe(true);
        // Coloured, or worded by another clap: the same refusal.
        expect(refusedFlag({ code: 2, output: "\u001b[1m\u001b[31merror:\u001b[0m Found argument '\u001b[33m--wait\u001b[0m' which wasn't expected" })).toBe(true);
        // ic's own failures, a run that answered, and one stopped at its deadline are not.
        expect(refusedFlag({ code: 1, output: "error: the platform did not answer" })).toBe(false);
        expect(refusedFlag(run([{ asleep: 1 }], 2))).toBe(false);
        expect(refusedFlag({ code: 2, output: "", timedOut: true })).toBe(false);
        expect(refusedFlag(run([{ asleep: 1 }]))).toBe(false);
    });

    test("a line ic prints is a start when it says one woke, and nothing else is", () => {
        expect(wokeOf(JSON.stringify({ slug: "a", woke: true }))).toEqual({ slug: "a", alarm: false });
        expect(wokeOf(`  ${JSON.stringify({ slug: "a", woke: true, for: "alarm" })}\r`)).toEqual({ slug: "a", alarm: true });
        expect(wokeOf(JSON.stringify({ slug: "a", woke: false, error: "docker said no" }))).toBeUndefined();
        expect(wokeOf(JSON.stringify({ asleep: 0, held: true }))).toBeUndefined();
        expect(wokeOf("intentic: Waking it up: somebody opened it")).toBeUndefined();
    });

    test("the minutes default when absent or unreadable, 0 is never, and the default is stored as nothing", () => {
        expect(sleepMinutesOf({})).toBe(DEFAULT_SLEEP_MINUTES);
        expect(sleepMinutesOf({ sandboxSleepMinutes: 0 })).toBe(0);
        expect(sleepMinutesOf({ sandboxSleepMinutes: -3 })).toBe(DEFAULT_SLEEP_MINUTES);
        expect(withSleepMinutes({ sandboxSleepMinutes: 5 }, DEFAULT_SLEEP_MINUTES)).toEqual({});
        expect(withSleepMinutes({}, 0)).toEqual({ sandboxSleepMinutes: 0 });
        expect(sleepWord("off")).toEqual({ minutes: 0 });
        expect(sleepWord("45")).toEqual({ minutes: 45 });
        expect(() => sleepWord("soon")).toThrow(/not a number of minutes/);
    });
});

describe("the keeper puts unneeded sandboxes to sleep", () => {
    const setup = () => {
        const fake = fakeKeeper(NOW);
        const asked: number[] = [];
        let answer: IcRun = run([{ slug: SLUG, slept: true }]);
        const seams = {
            ...fake.seams,
            sleepMinutes: () => Promise.resolve(30),
            sleep: (minutes: number) => {
                asked.push(minutes);
                return Promise.resolve(answer);
            },
        };
        const state = newKeeperState(NOW);
        const lines: string[] = [];
        const round = async (at: number): Promise<void> => {
            fake.clock = at;
            await runKeeperRound(state, seams, (line) => lines.push(line));
        };
        return { fake, asked, state, lines, round, answer: (next: IcRun) => void (answer = next) };
    };

    test("right after a sweep, and what fell asleep is said and remembered", async () => {
        const { fake, asked, state, lines, round } = setup();
        fake.records = [SLUG];
        await round(NOW + MIN);
        expect(fake.asked).toEqual([undefined]);
        expect(asked).toEqual([30]);
        expect([...state.sleepers.slugs]).toEqual([SLUG]);
        expect(lines.some((line) => line.includes(`${SLUG}: nobody needed it for 30 min, so it is asleep`))).toBe(true);
    });

    test("a sleep that set an alarm says when its sandbox comes back for what it scheduled", async () => {
        const { fake, lines, round, answer } = setup();
        fake.records = [SLUG];
        answer(run([{ slug: SLUG, slept: true, wakeAt: Date.UTC(2026, 9, 19, 7, 0) }]));
        await round(NOW + MIN);
        expect(lines).toContain(
            `keeper ${SLUG}: nobody needed it for 30 min, so it is asleep; it starts again when somebody opens it, or ahead of what it has scheduled at 2026-10-19T07:00:00.000Z.`,
        );
    });

    test("a sleeping sandbox's dead link is never a repair", async () => {
        const { fake, state, round } = setup();
        fake.records = [SLUG];
        await round(NOW + MIN);
        fake.asked.length = 0;
        fake.links = [linkView(URL, NOW + MIN)];
        await round(NOW + 5 * MIN);
        expect(fake.asked).toEqual([]);
        // The listing is the truth: once it says the sandbox is awake, its dead link is the keeper's again.
        state.sleepers.slugs.clear();
        fake.answer = async (slug) => await Promise.resolve(fixRun([{ slug: slug ?? SLUG, outcome: "healthy" }]));
        // Before the next sweep (due five minutes after the first), so only the link can be why ic runs.
        await round(NOW + 5.5 * MIN);
        expect(fake.asked).toEqual([SLUG]);
    });

    test("an ic that cannot sleep is said once, and nothing is remembered asleep", async () => {
        const { fake, state, lines, round, answer } = setup();
        answer({ code: 2, output: CLAP });
        fake.records = [SLUG];
        await round(NOW + MIN);
        await round(NOW + 7 * MIN);
        expect(state.sleepers.slugs.size).toBe(0);
        expect(lines.filter((line) => line.includes("cannot put unused sandboxes to sleep"))).toHaveLength(1);
    });
});

// The fake ic's knobs: the clock, how far one run moves it, and what a run waits on before it ends.
interface FakeWakes {
    clock: number;
    takesMs: number;
    gate: Promise<void> | undefined;
}

describe("the wake round", () => {
    // A fake `ic sandbox wakes`: each answer's lines are handed to `onLine` one by one, as runIc does, and the run ends
    // once `gate` (when the test set one) has opened; `takesMs` is how far the clock moves while it runs.
    const setup = (answers: IcRun[]) => {
        const sleepers = newSleepers();
        const state = newWakeState();
        const lines: string[] = [];
        const asked: (readonly string[])[] = [];
        const poked: string[] = [];
        const fake: FakeWakes = { clock: NOW, takesMs: 0, gate: undefined };
        const seams = {
            wakes: async (args: readonly string[], onLine: (line: string) => void): Promise<IcRun> => {
                asked.push(args);
                const answer = answers.shift() ?? run([{ asleep: 0 }]);
                for (const line of answer.output.split("\n")) {
                    onLine(line);
                }
                await fake.gate;
                fake.clock += fake.takesMs;
                return answer;
            },
            poke: (slug: string) => void poked.push(slug),
            now: () => fake.clock,
        };
        const round = async (at: number): Promise<number> => {
            fake.clock = at;
            return await runWakeRound(state, sleepers, seams, (line) => lines.push(line));
        };
        return { sleepers, lines, asked, poked, fake, round };
    };

    test("asks every round while something sleeps, held, and starts what somebody asked for", async () => {
        const { sleepers, lines, asked, poked, round } = setup([run([{ asleep: 1 }]), run([{ slug: SLUG, woke: true }, { asleep: 0 }])]);
        sleepers.slugs.add(SLUG);
        await round(NOW);
        await round(NOW + 15_000);
        expect(asked).toEqual([HELD_WAKES_ARGS, HELD_WAKES_ARGS]);
        expect(sleepers.slugs.size).toBe(0);
        expect(lines).toEqual([`keeper ${SLUG}: somebody opened it, so it is starting again.`]);
        expect(poked).toEqual([SLUG]);
    });

    test("a start ahead of an alarm says so, not that somebody opened it, and its links are dialled too", async () => {
        const { sleepers, lines, poked, round } = setup([run([{ slug: SLUG, woke: true, for: "alarm" }, { asleep: 0 }])]);
        sleepers.slugs.add(SLUG);
        await round(NOW);
        expect(lines).toEqual([`keeper ${SLUG}: something it scheduled is due, so it is starting ahead of it.`]);
        expect(poked).toEqual([SLUG]);
    });

    test("with nothing known asleep it asks only at the idle pace, plainly, and learns of a sleep made by hand", async () => {
        const { sleepers, asked, round } = setup([run([{ asleep: 0 }]), run([{ asleep: 2 }])]);
        await round(NOW);
        await round(NOW + 15_000);
        expect(asked).toEqual([WAKES_ARGS]);
        await round(NOW + IDLE_POLL_MS);
        expect(asked).toEqual([WAKES_ARGS, WAKES_ARGS]);
        expect(sleepers.counted).toBe(2);
        // Something sleeps now, though this agent never saw it fall asleep: the next ask is held.
        await round(NOW + IDLE_POLL_MS + 15_000);
        expect(asked).toEqual([WAKES_ARGS, WAKES_ARGS, HELD_WAKES_ARGS]);
    });

    test("after an ask the platform held the next follows at once, never closer than the spacing; else in fifteen seconds", async () => {
        const { sleepers, fake, round } = setup([
            run([{ asleep: 1, held: true }]),
            run([{ asleep: 1, held: true }]),
            run([{ asleep: 1, held: true }]),
            run([{ asleep: 1 }]),
            run([{ asleep: 1, held: false }]),
        ]);
        sleepers.slugs.add(SLUG);
        // Held the whole 25 s: the next at once.
        fake.takesMs = 25_000;
        expect(await round(NOW)).toBe(HELD_REPOLL_MS);
        // Answered "held" after 3 s (somebody asked for a wake): the next 5 s after this one started.
        fake.takesMs = 3_000;
        expect(await round(NOW + MIN)).toBe(HELD_SPACING_MS - 3_000);
        // Said "held" without holding at all: the spacing, so no loop of ic runs.
        fake.takesMs = 0;
        expect(await round(NOW + 2 * MIN)).toBe(HELD_SPACING_MS);
        // A platform from before the held ask, which answers at once: today's pace.
        expect(await round(NOW + 3 * MIN)).toBe(WAKE_POLL_MS);
        expect(await round(NOW + 4 * MIN)).toBe(WAKE_POLL_MS);
        // Nothing asleep and the idle look not due: nothing asked, and the round ticks at its pace.
        sleepers.slugs.clear();
        sleepers.counted = 0;
        expect(await round(NOW + 4 * MIN + 1)).toBe(WAKE_POLL_MS);
    });

    test("an ic that refuses --wait is asked again at once without it, never read as one that cannot wake, and plainly for an hour", async () => {
        const { sleepers, lines, asked, poked, round } = setup([
            NO_WAIT,
            run([{ slug: SLUG, woke: true }, { asleep: 1 }]),
            run([{ asleep: 1 }]),
            run([{ asleep: 1 }]),
            NO_WAIT,
            run([{ asleep: 1 }]),
        ]);
        sleepers.slugs.add(SLUG);
        sleepers.slugs.add("sandbox-other");
        expect(await round(NOW)).toBe(WAKE_POLL_MS);
        expect(asked).toEqual([HELD_WAKES_ARGS, WAKES_ARGS]);
        expect(poked).toEqual([SLUG]);
        // The start is said as ic prints it; the refusal once the plain ask has shown ic knows the verb.
        expect(lines).toEqual([
            `keeper ${SLUG}: somebody opened it, so it is starting again.`,
            "keeper: this machine's ic cannot hold an ask for wakes yet (error: unexpected argument '--wait' found), so it asks every 15 s until it is updated.",
        ]);
        // Fifteen seconds on, and to the end of the hour: plain asks, though something still sleeps.
        await round(NOW + WAKE_POLL_MS);
        await round(NOW + WAIT_REFUSED_MS - 1);
        expect(asked.slice(2)).toEqual([WAKES_ARGS, WAKES_ARGS]);
        // Then the flag is tried again; refused again, it is asked plainly at once and is not news.
        await round(NOW + WAIT_REFUSED_MS);
        expect(asked.slice(4)).toEqual([HELD_WAKES_ARGS, WAKES_ARGS]);
        expect(lines.filter((line) => line.includes("cannot hold an ask"))).toHaveLength(1);
        expect(lines.filter((line) => line.includes("cannot wake sleeping sandboxes"))).toEqual([]);
    });

    test("an ic without `wakes` at all refuses the plain ask too, and that is an ic that cannot wake", async () => {
        const { sleepers, lines, asked, round } = setup([NO_WAKES, NO_WAKES]);
        sleepers.slugs.add(SLUG);
        await round(NOW);
        expect(asked).toEqual([HELD_WAKES_ARGS, WAKES_ARGS]);
        expect(lines).toEqual([
            "keeper: this machine's ic cannot wake sleeping sandboxes yet (For more information, try '--help'.); start one with `intentic-machine sandbox start <slug>`.",
        ]);
        // Waited out at the idle pace, as before the held ask.
        await round(NOW + WAKE_POLL_MS);
        expect(asked).toHaveLength(2);
    });

    test("a start is said and its links dialled the moment ic prints it, and once however often it is read", async () => {
        const { sleepers, lines, poked, fake, round } = setup([run([{ slug: SLUG, woke: true }, { slug: "sandbox-later", woke: true }, { asleep: 0, held: true }])]);
        sleepers.slugs.add(SLUG);
        sleepers.slugs.add("sandbox-later");
        let open: () => void = () => undefined;
        fake.gate = new Promise((resolve) => {
            open = resolve;
        });
        const ended = round(NOW);
        // ic has printed both starts and not exited: both are already acted on.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(poked).toEqual([SLUG, "sandbox-later"]);
        expect(lines).toEqual([`keeper ${SLUG}: somebody opened it, so it is starting again.`, "keeper sandbox-later: somebody opened it, so it is starting again."]);
        open();
        await ended;
        // The whole output, read again as the final word, says nothing twice.
        expect(poked).toEqual([SLUG, "sandbox-later"]);
        expect(lines).toHaveLength(2);
        expect(sleepers.slugs.size).toBe(0);
    });

    test("what this agent took for asleep is dialled once ic counts nothing asleep: somebody else woke it", async () => {
        const { sleepers, poked, round } = setup([run([{ slug: SLUG, woke: true }, { asleep: 0 }])]);
        sleepers.slugs.add(SLUG);
        sleepers.slugs.add("sandbox-started-by-hand");
        await round(NOW);
        expect(poked).toEqual([SLUG, "sandbox-started-by-hand"]);
        expect(sleepers.slugs.size).toBe(0);
    });

    test("the rounds are paced by the last one's answer: at once after a held ask, fifteen seconds after any other", async () => {
        jest.useFakeTimers();
        try {
            const sleepers = newSleepers();
            sleepers.slugs.add(SLUG);
            const asks: number[] = [];
            let clock = NOW;
            let held = true;
            const rounds = startWakeRound(() => undefined, sleepers, {
                wakes: async () => {
                    asks.push(clock);
                    clock += 25_000;
                    return await Promise.resolve(run([{ asleep: 1, held }]));
                },
                poke: () => undefined,
                now: () => clock,
            });
            await advanceTimersByTimeAsync(WAKE_POLL_MS);
            expect(asks).toHaveLength(1);
            await advanceTimersByTimeAsync(HELD_REPOLL_MS);
            expect(asks).toHaveLength(2);
            held = false;
            await advanceTimersByTimeAsync(HELD_REPOLL_MS);
            expect(asks).toHaveLength(3);
            await advanceTimersByTimeAsync(WAKE_POLL_MS - 1);
            expect(asks).toHaveLength(3);
            await advanceTimersByTimeAsync(1);
            expect(asks).toHaveLength(4);
            rounds.stop();
        } finally {
            jest.useRealTimers();
        }
    });
});
