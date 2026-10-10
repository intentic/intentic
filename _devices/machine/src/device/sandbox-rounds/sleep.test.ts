import { fakeKeeper, fixRun, linkView } from "../../testing.js";
import type { IcRun } from "../tools/sandboxes.js";
import { newKeeperState, runKeeperRound } from "./keeper.js";
import {
    DEFAULT_SLEEP_MINUTES,
    IDLE_POLL_MS,
    newSleepers,
    newWakeState,
    readSleepRun,
    readWakesRun,
    runWakeRound,
    sleepArgs,
    sleepMinutesOf,
    withSleepMinutes,
} from "./sleep.js";
import { sleepWord } from "../sandbox-cli.js";

/* Putting unneeded sandboxes to sleep after the keeper's sweep, and waking the ones somebody asked for: every decision
   over fake runs of ic, with the clock moved by hand. */

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const URL = "https://sandbox-0123456789ab.sbx.intentic.dev";
const SLUG = "sandbox-0123456789ab";
const CLAP = "error: unrecognized subcommand 'sleep'\n\nUsage: ic sandbox <COMMAND>\n";

const run = (lines: readonly unknown[], code = 0): IcRun => ({ code, output: ["intentic: looking…", ...lines.map((line) => JSON.stringify(line))].join("\n") });

describe("what ic says", () => {
    test("the keeper asks for every sandbox quiet for the configured stretch, in JSON, as the agent", () => {
        expect(sleepArgs(30)).toEqual(["sandbox", "sleep", "--idle", "30", "--json", "--source", "agent"]);
    });

    test("a sleep run names what fell asleep; an ic without the verb is unavailable, not a sleep of nothing", () => {
        expect(readSleepRun(run([{ slug: "a", slept: true }, { slug: "b", slept: false, why: "busy" }]))).toEqual({ slept: ["a"] });
        expect(readSleepRun({ code: 2, output: CLAP })).toEqual({ unavailable: "Usage: ic sandbox <COMMAND>" });
        expect(readSleepRun(run([]))).toEqual({ slept: [] });
    });

    test("a wakes run names what it started, what would not, and how many still sleep", () => {
        expect(readWakesRun(run([{ slug: "a", woke: true }, { slug: "b", woke: false, error: "docker said no" }, { asleep: 1 }]))).toEqual({
            woke: ["a"],
            failed: [{ slug: "b", error: "docker said no" }],
            asleep: 1,
        });
        expect("unavailable" in readWakesRun({ code: 2, output: CLAP })).toBe(true);
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

describe("the wake round", () => {
    const setup = (answers: IcRun[]) => {
        const sleepers = newSleepers();
        const state = newWakeState();
        const lines: string[] = [];
        let clock = NOW;
        let calls = 0;
        const seams = {
            wakes: () => {
                calls += 1;
                return Promise.resolve(answers.shift() ?? run([{ asleep: 0 }]));
            },
            now: () => clock,
        };
        const round = async (at: number): Promise<void> => {
            clock = at;
            await runWakeRound(state, sleepers, seams, (line) => lines.push(line));
        };
        return { sleepers, lines, round, calls: () => calls };
    };

    test("asks every round while something sleeps, and starts what somebody asked for", async () => {
        const { sleepers, lines, round, calls } = setup([run([{ asleep: 1 }]), run([{ slug: SLUG, woke: true }, { asleep: 0 }])]);
        sleepers.slugs.add(SLUG);
        await round(NOW);
        await round(NOW + 15_000);
        expect(calls()).toBe(2);
        expect(sleepers.slugs.size).toBe(0);
        expect(lines).toEqual([`keeper ${SLUG}: somebody opened it, so it is starting again.`]);
    });

    test("with nothing known asleep it asks only at the idle pace, and learns of a sleep made by hand", async () => {
        const { sleepers, round, calls } = setup([run([{ asleep: 0 }]), run([{ asleep: 2 }])]);
        await round(NOW);
        await round(NOW + 15_000);
        expect(calls()).toBe(1);
        await round(NOW + IDLE_POLL_MS);
        expect(calls()).toBe(2);
        expect(sleepers.counted).toBe(2);
        await round(NOW + IDLE_POLL_MS + 15_000);
        expect(calls()).toBe(3);
    });
});
