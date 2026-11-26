import type { HostMemory } from "@intentic/sandbox-contract/schemas/hosts";
import { HOST_LOW_FLOOR_BYTES, hostMemoryLowBytes } from "@intentic/sandbox-contract/schemas/hosts";
import { fakeKeeper } from "../../../testing.js";
import type { IcRun } from "../ic-rounds.js";
import { newKeeperState, runKeeperRound } from "../keeper.js";
import type { ListedSandbox } from "../keeper-scope.js";
import {
    choose,
    isShort,
    linuxMemoryOf,
    LOOK_AGAIN_MS,
    lookDue,
    memorySleepArgs,
    type MemorySleepSeams,
    newMemorySleepState,
    noteReading,
    nothingSaid,
    QUIET_MINUTES,
    FLAGS_REFUSED_MS,
    runMemorySleep,
    SETTLE_MS,
    SHORT_FOR_MS,
    SIGNAL_STALE_MS,
    sleepReason,
    sleptLine,
    stayUp,
    WAKE_SOON_MS,
    type WorkSignal,
    workSignalOf,
} from "./memory-sleep.js";

/* Putting a sandbox nobody uses to sleep while the computer is short of memory: every decision over fake readings of
   memory, fake work signals and a fake ic, with the clock moved by hand. */

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const GIB = 1024 ** 3;
// rog: 31.4 GiB, whose low line is a tenth of it.
const TOTAL = 31.4 * GIB;
const LINE = hostMemoryLowBytes(TOTAL);
const SHORT: HostMemory = { availableBytes: 2.1 * GIB, totalBytes: TOTAL };
const ENOUGH: HostMemory = { availableBytes: 8 * GIB, totalBytes: TOTAL };

// A signal a quiet daemon writes: fresh, nothing running, quiet for `quietMin` minutes.
const quiet = (quietMin: number, extra: Partial<WorkSignal> = {}): WorkSignal => ({ liveTurns: 0, at: NOW - 30_000, quietSince: NOW - quietMin * MIN, ...extra });
const row = (slug: string, extra: Partial<ListedSandbox> = {}): ListedSandbox => ({ slug, container: `intentic-sandbox-${slug}`, running: true, ...extra });

describe("when the computer counts as short", () => {
    test("under the line both sides keep, and not at it", () => {
        expect(isShort({ availableBytes: LINE - 1, totalBytes: TOTAL })).toBe(true);
        expect(isShort({ availableBytes: LINE, totalBytes: TOTAL })).toBe(false);
        // A small machine's line is the floor, not a tenth.
        expect(isShort({ availableBytes: HOST_LOW_FLOOR_BYTES - 1, totalBytes: 8 * GIB })).toBe(true);
        expect(isShort({ availableBytes: HOST_LOW_FLOOR_BYTES, totalBytes: 8 * GIB })).toBe(false);
    });

    test("a streak, not a reading: it starts at the first short reading and ends at the first that is not, or none", () => {
        const state = newMemorySleepState();
        expect(noteReading(state, SHORT, NOW)).toBe(0);
        expect(noteReading(state, SHORT, NOW + 4 * MIN)).toBe(4 * MIN);
        expect(noteReading(state, ENOUGH, NOW + 5 * MIN)).toBeUndefined();
        expect(state.shortSince).toBeUndefined();
        expect(noteReading(state, SHORT, NOW + 6 * MIN)).toBe(0);
        // A reading that could not be taken is no evidence of shortness.
        expect(noteReading(state, undefined, NOW + 7 * MIN)).toBeUndefined();
        expect(state.shortSince).toBeUndefined();
    });

    test("a look is due only once the streak has held for minutes, and never before the last look's pace allows", () => {
        expect(lookDue({ nextLookAt: 0 }, undefined, NOW)).toBe(false);
        expect(lookDue({ nextLookAt: 0 }, SHORT_FOR_MS - 1, NOW)).toBe(false);
        expect(lookDue({ nextLookAt: 0 }, SHORT_FOR_MS, NOW)).toBe(true);
        expect(lookDue({ nextLookAt: NOW + 1 }, SHORT_FOR_MS, NOW)).toBe(false);
        expect(lookDue({ nextLookAt: NOW }, SHORT_FOR_MS, NOW)).toBe(true);
        expect(SHORT_FOR_MS).toBe(10 * MIN);
    });

    test("a Linux host's MemAvailable, with the total given", () => {
        expect(linuxMemoryOf("MemTotal:  16000000 kB\nMemFree: 100 kB\nMemAvailable:    2097152 kB\n", 16 * GIB)).toEqual({ availableBytes: 2 * GIB, totalBytes: 16 * GIB });
        expect(linuxMemoryOf("MemTotal: 16000000 kB\n", 16 * GIB)).toBeUndefined();
    });
});

describe("what keeps a sandbox up whatever memory is left", () => {
    test("the sandbox's own word decides: in use, working, kept awake, quiet too briefly, or due soon", () => {
        expect(stayUp(quiet(QUIET_MINUTES), NOW)).toBeUndefined();
        expect(stayUp(undefined, NOW)).toBe("its daemon says nothing of its work");
        expect(stayUp(quiet(90, { at: NOW - SIGNAL_STALE_MS - 1 }), NOW)).toBe("its daemon's work signal is stale");
        expect(stayUp(quiet(90, { at: NOW - SIGNAL_STALE_MS }), NOW)).toBeUndefined();
        expect(stayUp(quiet(90, { liveTurns: 1 }), NOW)).toBe("something is running in it");
        expect(stayUp(quiet(90, { keepAwake: true }), NOW)).toContain("kept awake");
        // No quietSince is how the daemon says somebody is connected or its own work is still going.
        expect(stayUp({ liveTurns: 0, at: NOW, personAt: NOW }, NOW)).toBe("it is in use (somebody at an editor within the last half hour, or work of its own still going)");
        expect(stayUp(quiet(QUIET_MINUTES - 1), NOW)).toBe(`it was used within the last ${QUIET_MINUTES} min`);
        expect(stayUp(quiet(90, { nextWakeAt: NOW + WAKE_SOON_MS }), NOW)).toBe("something it scheduled is due soon");
        // A promise further out does not hold it: the sleep sets an alarm for it.
        expect(stayUp(quiet(90, { nextWakeAt: NOW + WAKE_SOON_MS + 1 }), NOW)).toBeUndefined();
    });

    test("the signal reads as the daemon writes it, its boot's facts left out; anything else is no signal", () => {
        const written = JSON.stringify({ liveTurns: 0, at: NOW, bootedAt: NOW - 9, restartStorm: false, quietSince: NOW - 61 * MIN, personAt: 5 });
        expect(workSignalOf(`${written}\n`)).toEqual({ liveTurns: 0, at: NOW, quietSince: NOW - 61 * MIN, personAt: 5 });
        expect(workSignalOf(undefined)).toBeUndefined();
        expect(workSignalOf("cat: /run/intentic/work.json: No such file or directory")).toBeUndefined();
        expect(workSignalOf(JSON.stringify({ at: NOW }))).toBeUndefined();
    });
});

describe("who sleeps first", () => {
    const signals = (entries: Record<string, WorkSignal | undefined>): Map<string, WorkSignal | undefined> => new Map(Object.entries(entries));

    test("least recently used first: the longest quiet, then the person who left longest ago, then the slug", () => {
        const listed = [row("a"), row("b"), row("c"), row("d")];
        const choice = choose(listed, signals({ a: quiet(70), b: quiet(900), c: quiet(70, { personAt: NOW - 200 * MIN }), d: quiet(70, { personAt: NOW - 200 * MIN }) }), new Set(), NOW);
        expect(choice.order.map((candidate) => candidate.slug)).toEqual(["b", "a", "c", "d"]);
        expect(choice.kept).toEqual([]);
        expect(choice.only).toBe(false);
    });

    test("never the only sandbox running on the engine, however quiet", () => {
        expect(choose([row("a")], signals({ a: quiet(900) }), new Set(), NOW)).toEqual({ order: [], kept: [], only: true });
        // Asleep and stopped ones and runners leave it alone just the same.
        const listed = [row("a"), row("b", { asleep: true, running: false }), row("c", { running: false }), row("runner-omen")];
        expect(choose(listed, signals({ a: quiet(900) }), new Set(), NOW).only).toBe(true);
    });

    test("the other side's sandbox counts toward the engine's, and is never this side's to put to sleep", () => {
        const listed = [row("mine"), row("theirs", { keptElsewhere: "linux/archlinux" })];
        const choice = choose(listed, signals({ mine: quiet(900), theirs: quiet(9_000) }), new Set(), NOW);
        expect(choice.order.map((candidate) => candidate.slug)).toEqual(["mine"]);
        expect(choice.only).toBe(false);
    });

    // The owner's rule (2026-11-26): an editor nobody has been at for half an hour is nobody, for this sleep only.
    test("an editor left open counts as nobody once the daemon says so; its quiet runs from when somebody was last at it", () => {
        const leftAlone = (sinceMin: number): WorkSignal => ({ liveTurns: 0, at: NOW - 30_000, unattendedSince: NOW - sinceMin * MIN, personAt: NOW - 30_000, activeAt: NOW - sinceMin * MIN });
        const listed = [row("open"), row("recent"), row("closed")];
        const choice = choose(listed, signals({ open: leftAlone(900), recent: leftAlone(40), closed: quiet(70) }), new Set(), NOW);
        expect(choice.order).toEqual([
            { slug: "open", quietSince: NOW - 900 * MIN, activeAt: NOW - 900 * MIN, leftOpen: true },
            { slug: "closed", quietSince: NOW - 70 * MIN, activeAt: 0, leftOpen: false },
        ]);
        expect(choice.kept).toEqual([{ slug: "recent", why: `it was used within the last ${QUIET_MINUTES} min` }]);
        // Connected, and the daemon says no unattended streak: somebody was at an editor within the half hour.
        expect(stayUp({ liveTurns: 0, at: NOW, personAt: NOW, activeAt: NOW - 10 * MIN }, NOW)).toBe(
            "it is in use (somebody at an editor within the last half hour, or work of its own still going)",
        );
        // Everything else still holds it whatever the editor: work, its own keep-awake, a wake due.
        expect(stayUp({ ...leftAlone(900), liveTurns: 1 }, NOW)).toBe("something is running in it");
        expect(stayUp({ ...leftAlone(900), keepAwake: true }, NOW)).toContain("kept awake");
        expect(stayUp({ ...leftAlone(900), nextWakeAt: NOW + 5 * MIN }, NOW)).toBe("something it scheduled is due soon");
    });

    test("least recently used goes by the last real activity where the daemon says it, before the last presence", () => {
        const listed = [row("a"), row("b")];
        const choice = choose(listed, signals({ a: quiet(90, { personAt: NOW - 100 * MIN, activeAt: NOW - 300 * MIN }), b: quiet(90, { personAt: NOW - 200 * MIN }) }), new Set(), NOW);
        expect(choice.order.map((candidate) => candidate.slug)).toEqual(["a", "b"]);
    });

    test("one in use, one another flow is touching, and one with no signal stay up, each with its reason", () => {
        const listed = [row("used"), row("touched"), row("silent"), row("idle")];
        const choice = choose(listed, signals({ used: { liveTurns: 0, at: NOW }, touched: quiet(900), silent: undefined, idle: quiet(61) }), new Set(["touched"]), NOW);
        expect(choice.order.map((candidate) => candidate.slug)).toEqual(["idle"]);
        expect(choice.kept).toEqual([
            { slug: "used", why: "it is in use (somebody at an editor within the last half hour, or work of its own still going)" },
            { slug: "touched", why: "another ic run is working on it" },
            { slug: "silent", why: "its daemon says nothing of its work" },
        ]);
    });
});

describe("what is said", () => {
    test("which sandbox slept, why, and that opening it wakes it", () => {
        const candidate = { slug: "sandbox-a4ba63bf2aa5", quietSince: NOW - 900 * MIN, activeAt: NOW - 900 * MIN, leftOpen: false };
        expect(sleptLine(candidate, SHORT, 14 * MIN, NOW)).toBe(
            "keeper sandbox-a4ba63bf2aa5: put to sleep to give memory back: this computer has had less than 3.1 GB of memory available for 14 min (2.1 GB of 31.4 GB now), and nobody had used sandbox-a4ba63bf2aa5 for 900 min, longer than any other sandbox here. It starts again when somebody opens it.",
        );
        expect(sleptLine(candidate, SHORT, 14 * MIN, NOW, Date.parse("2026-11-26T18:00:00.000Z"))).toContain(
            "It starts again when somebody opens it, or ahead of what it has scheduled at 2026-11-26T18:00:00.000Z.",
        );
        // An editor still open on it, which counted as nobody: said, so its owner knows why their tab found it asleep.
        expect(sleptLine({ ...candidate, leftOpen: true }, SHORT, 14 * MIN, NOW)).toContain(
            "nobody had used sandbox-a4ba63bf2aa5 for 900 min (an editor is still open on it, untouched), longer than any other sandbox here.",
        );
    });

    test("the reason ic records in the sandbox names the memory, its line and that opening it wakes it", () => {
        expect(sleepReason(SHORT, 14 * MIN, { leftOpen: false })).toBe(
            "this computer was short of memory (2.1 GB of 31.4 GB available, under its 3.1 GB low line, for 14 min) and nobody had used this sandbox longer than any other there; opening it wakes it",
        );
        expect(sleepReason(SHORT, 14 * MIN, { leftOpen: true })).toContain("longer than any other there (an editor is still open on it, untouched); opening it wakes it");
    });

    test("a look that slept nothing says why, keyed without the figures so a standing reason is said once", () => {
        const one = nothingSaid(SHORT, 14 * MIN, { only: false, kept: [{ slug: "a", why: "something is running in it" }] });
        const later = nothingSaid({ ...SHORT, availableBytes: 1.9 * GIB }, 19 * MIN, { only: false, kept: [{ slug: "a", why: "something is running in it" }] });
        expect(one.line).toBe(
            "keeper: this computer has had less than 3.1 GB of memory available for 14 min (2.1 GB of 31.4 GB now), but no sandbox here can sleep to give it back (a: something is running in it).",
        );
        expect(later.key).toBe(one.key);
        expect(nothingSaid(SHORT, 14 * MIN, { only: true, kept: [] }).line).toContain("only one sandbox runs on it, and that one is never put to sleep");
    });

    test("ic is asked for that one sandbox, quiet for the hour, as the agent, an editor left alone counting as nobody, with the reason", () => {
        expect(memorySleepArgs("a", "why")).toEqual(["sandbox", "sleep", "a", "--idle", String(QUIET_MINUTES), "--json", "--source", "agent", "--unattended", "--reason", "why"]);
        expect(memorySleepArgs("a", undefined)).toEqual(["sandbox", "sleep", "a", "--idle", "60", "--json", "--source", "agent"]);
    });
});

/* THE LOOK, over fakes: the memory as each pass reads it, the signals each container would give, and ic's answers. */

interface FakeLook {
    clock: number;
    memory: HostMemory | undefined;
    on: boolean;
    listing: readonly ListedSandbox[] | Error;
    signals: Record<string, WorkSignal | undefined>;
    // What ic answers per slug, and whether it refuses `--reason`.
    answer: (slug: string) => IcRun;
    refusesReason: boolean;
    readonly asked: { slug: string; reason: string | undefined; held: boolean }[];
    readonly listed: number[];
    readonly said: string[];
    readonly busy: Set<string>;
}

// ic's line for a sandbox it put to sleep; JSON.stringify leaves an undefined `wakeAt` out, as ic does with no alarm.
const slept = (slug: string, wakeAt?: number): IcRun => ({ code: 0, output: JSON.stringify({ slug, slept: true, why: "quiet for 70 minutes", wakeAt }) });
const awake = (slug: string, why: string): IcRun => ({ code: 0, output: JSON.stringify({ slug, slept: false, why }) });
// What rog's ic 1.430.0, from before the flag, answered (2026-11-26).
const NO_REASON: IcRun = {
    code: 2,
    output: "error: unexpected argument '--reason' found\n\n  tip: a similar argument exists: '--json'\n\nUsage: ic.exe sandbox sleep --idle <MINUTES> --json --source <SOURCE> <SLUG>\n\nFor more information, try '--help'.",
};

const fakeLook = (): FakeLook => ({
    clock: NOW,
    memory: SHORT,
    on: true,
    listing: [row("a"), row("b")],
    signals: { a: quiet(70), b: quiet(900) },
    answer: (slug) => slept(slug),
    refusesReason: false,
    asked: [],
    listed: [],
    said: [],
    busy: new Set(),
});

const held = new Set<string>();
const seamsOf = (fake: FakeLook): MemorySleepSeams => ({
    enabled: async () => await Promise.resolve(fake.on),
    memory: async () => await Promise.resolve(fake.memory),
    signal: async (container) => {
        const signal = fake.signals[container.replace(/^intentic-sandbox-/, "")];
        return await Promise.resolve(signal === undefined ? undefined : `${JSON.stringify({ ...signal, at: fake.clock - 30_000 })}\n`);
    },
    sleep: async (slug, reason) => {
        fake.asked.push({ slug, reason, held: held.has(slug) });
        return await Promise.resolve(reason !== undefined && fake.refusesReason ? NO_REASON : fake.answer(slug));
    },
});
const depsOf = (fake: FakeLook) => ({
    listing: async (): Promise<readonly ListedSandbox[]> => {
        fake.listed.push(fake.clock);
        return fake.listing instanceof Error ? await Promise.reject(fake.listing) : await Promise.resolve(fake.listing);
    },
    busy: fake.busy,
    hold: (slug: string) => {
        held.add(slug);
        return () => void held.delete(slug);
    },
    now: () => fake.clock,
});
const pass = async (fake: FakeLook) => await runMemorySleep(state, seamsOf(fake), depsOf(fake), (line) => void fake.said.push(line));

let state = newMemorySleepState();
beforeEach(() => {
    state = newMemorySleepState();
    held.clear();
});

// Passes a minute apart until the streak has held long enough for a look, the clock moved by hand.
const holdShort = async (fake: FakeLook): Promise<void> => {
    for (let elapsed = 0; elapsed < SHORT_FOR_MS; elapsed += MIN) {
        expect(await pass(fake)).toBeUndefined();
        fake.clock += MIN;
    }
};

describe("one look", () => {
    test("short for ten minutes: the sandbox quiet longest is put to sleep, held while ic runs, with the reason, and said", async () => {
        const fake = fakeLook();
        await holdShort(fake);
        expect(fake.asked).toEqual([]);
        expect(fake.listed).toEqual([]);
        expect(await pass(fake)).toEqual({ slug: "b", alarmAt: undefined });
        expect(fake.asked).toEqual([{ slug: "b", reason: sleepReason(SHORT, SHORT_FOR_MS, { leftOpen: false }), held: true }]);
        expect(held.size).toBe(0);
        expect(fake.said).toEqual([sleptLine({ slug: "b", quietSince: NOW - 900 * MIN, activeAt: 0, leftOpen: false }, SHORT, SHORT_FOR_MS, NOW + SHORT_FOR_MS, undefined)]);
    });

    test("at most one: the next look waits to settle, reads memory again, and goes on only while it is still short", async () => {
        const fake = fakeLook();
        fake.listing = [row("a"), row("b"), row("c")];
        fake.signals = { a: quiet(70), b: quiet(900), c: quiet(80) };
        await holdShort(fake);
        expect((await pass(fake))?.slug).toBe("b");
        fake.listing = [row("a"), row("b", { running: false, asleep: true }), row("c")];
        fake.clock += SETTLE_MS - 1;
        expect(await pass(fake)).toBeUndefined();
        expect(fake.asked.map((asked) => asked.slug)).toEqual(["b"]);
        fake.clock += 1;
        expect((await pass(fake))?.slug).toBe("c");
        // Memory came back: the streak ends, and the last quiet sandbox stays up.
        fake.listing = [row("a"), row("b", { running: false, asleep: true }), row("c", { running: false, asleep: true })];
        fake.clock += SETTLE_MS;
        fake.memory = ENOUGH;
        expect(await pass(fake)).toBeUndefined();
        expect(fake.asked.map((asked) => asked.slug)).toEqual(["b", "c"]);
        expect(state.shortSince).toBeUndefined();
    });

    test("never the last one awake: with one left, the look says so once and asks ic nothing", async () => {
        const fake = fakeLook();
        fake.listing = [row("a"), row("b", { running: false, asleep: true })];
        await holdShort(fake);
        expect(await pass(fake)).toBeUndefined();
        fake.clock += LOOK_AGAIN_MS;
        expect(await pass(fake)).toBeUndefined();
        expect(fake.asked).toEqual([]);
        expect(fake.listed).toEqual([NOW + SHORT_FOR_MS, NOW + SHORT_FOR_MS + LOOK_AGAIN_MS]);
        expect(fake.said).toEqual([nothingSaid(SHORT, SHORT_FOR_MS, { only: true, kept: [] }).line]);
    });

    test("nobody quiet long enough: nothing is asked, the reasons are said once, and the next look waits its pace", async () => {
        const fake = fakeLook();
        fake.signals = { a: { liveTurns: 0, at: NOW, personAt: NOW }, b: quiet(30) };
        await holdShort(fake);
        expect(await pass(fake)).toBeUndefined();
        fake.clock += MIN;
        expect(await pass(fake)).toBeUndefined();
        expect(fake.listed).toHaveLength(1);
        fake.clock += LOOK_AGAIN_MS;
        expect(await pass(fake)).toBeUndefined();
        expect(fake.listed).toHaveLength(2);
        expect(fake.asked).toEqual([]);
        expect(fake.said).toHaveLength(1);
        expect(fake.said[0]).toContain(`(a: it is in use (somebody at an editor within the last half hour, or work of its own still going); b: it was used within the last ${QUIET_MINUTES} min).`);
    });

    test("ic has the last word: one it leaves awake is said, and the next quiet one is asked in the same look", async () => {
        const fake = fakeLook();
        fake.answer = (slug) => (slug === "b" ? awake("b", "its dev checkout asked: rebuilding its image") : slept(slug, NOW + 3 * 60 * MIN));
        fake.listing = [row("a"), row("b"), row("c", { keptElsewhere: "windows" })];
        await holdShort(fake);
        expect(await pass(fake)).toEqual({ slug: "a", alarmAt: NOW + 3 * 60 * MIN });
        expect(fake.asked.map((asked) => asked.slug)).toEqual(["b", "a"]);
        expect(fake.said).toHaveLength(1);
        expect(fake.said[0]).toContain("keeper a: put to sleep to give memory back");
        expect(fake.said[0]).toContain(`or ahead of what it has scheduled at ${new Date(NOW + 3 * 60 * MIN).toISOString()}`);
    });

    test("an ic from before --reason is asked again at once without it, and plainly for an hour", async () => {
        const fake = fakeLook();
        fake.refusesReason = true;
        fake.listing = [row("a"), row("b"), row("c")];
        fake.signals = { a: quiet(70), b: quiet(900), c: quiet(80) };
        await holdShort(fake);
        expect((await pass(fake))?.slug).toBe("b");
        fake.listing = [row("a"), row("b", { running: false, asleep: true }), row("c")];
        fake.clock += SETTLE_MS;
        expect((await pass(fake))?.slug).toBe("c");
        expect(fake.asked.map(({ slug, reason }) => [slug, reason === undefined ? "plain" : "reason"])).toEqual([
            ["b", "reason"],
            ["b", "plain"],
            ["c", "plain"],
        ]);
        expect(state.flagsRefusedUntil).toBe(NOW + SHORT_FOR_MS + FLAGS_REFUSED_MS);
    });

    test("an ic that cannot sleep at all is said once, and nothing is taken for asleep", async () => {
        const fake = fakeLook();
        fake.answer = () => ({ code: 2, output: "error: unrecognized subcommand 'sleep'\n\nUsage: ic sandbox <COMMAND>" });
        await holdShort(fake);
        expect(await pass(fake)).toBeUndefined();
        fake.clock += LOOK_AGAIN_MS;
        expect(await pass(fake)).toBeUndefined();
        expect(fake.said).toEqual(["keeper: this machine's ic could not put b to sleep to give memory back (Usage: ic sandbox <COMMAND>)."]);
    });

    test("switched off, unread, or a listing Docker will not give: nothing is looked at", async () => {
        const off = fakeLook();
        off.on = false;
        await holdShort(off);
        expect(await pass(off)).toBeUndefined();
        expect(off.listed).toEqual([]);
        expect(state.shortSince).toBeUndefined();

        state = newMemorySleepState();
        const unread = fakeLook();
        unread.memory = undefined;
        await holdShort(unread);
        expect(await pass(unread)).toBeUndefined();
        expect(unread.listed).toEqual([]);

        state = newMemorySleepState();
        const down = fakeLook();
        down.listing = new Error("docker: cannot connect");
        await holdShort(down);
        expect(await pass(down)).toBeUndefined();
        expect(down.asked).toEqual([]);
        expect(state.nextLookAt).toBe(NOW + SHORT_FOR_MS + LOOK_AGAIN_MS);
    });

    test("a sandbox with an editor left open is asked about with the unattended reading, and the line says so", async () => {
        const fake = fakeLook();
        fake.signals = { a: quiet(70), b: { liveTurns: 0, at: NOW, unattendedSince: NOW - 900 * MIN, personAt: NOW, activeAt: NOW - 900 * MIN } };
        await holdShort(fake);
        expect((await pass(fake))?.slug).toBe("b");
        expect(fake.asked).toEqual([{ slug: "b", reason: sleepReason(SHORT, SHORT_FOR_MS, { leftOpen: true }), held: true }]);
        expect(fake.said[0]).toContain("(an editor is still open on it, untouched)");
    });

    test("a sandbox another flow of this agent is touching is not even read, and stays up", async () => {
        const fake = fakeLook();
        fake.busy.add("b");
        await holdShort(fake);
        expect((await pass(fake))?.slug).toBe("a");
        expect(fake.asked.map((asked) => asked.slug)).toEqual(["a"]);
    });
});

/* THE KEEPER'S ROUND carries it: the same look on the keeper's tick, through the keeper's own listing, hold and switch. */

describe("the keeper puts a sandbox to sleep for memory", () => {
    const setup = () => {
        const fake = fakeKeeper(NOW);
        const look = fakeLook();
        fake.records = ["a", "b"];
        fake.listing = [row("a"), row("b")];
        // As ic's listing shows a sandbox it put to sleep, which the keeper's next sweep reads back.
        look.answer = (slug) => {
            fake.listing = [row("a"), row("b")].map((each) => (each.slug === slug ? { ...each, running: false, asleep: true } : each));
            return slept(slug);
        };
        const seams = { ...fake.seams, memorySleep: seamsOf(look) };
        const keeper = newKeeperState(NOW);
        const lines: string[] = [];
        // Rounds a minute apart from the first sweep on, each at the clock both fakes share.
        const roundsUntil = async (until: number): Promise<void> => {
            for (; fake.clock <= until; fake.clock += MIN) {
                look.clock = fake.clock;
                await runKeeperRound(keeper, seams, (line) => lines.push(line));
            }
        };
        return { fake, look, keeper, lines, roundsUntil };
    };

    test("once memory has been short for the streak: the quiet one sleeps, the wake round will ask about it, and the line says why", async () => {
        const { fake, look, keeper, lines, roundsUntil } = setup();
        // The first round is the sweep (the keeper's own sleep has no seam here), then one look a minute.
        await roundsUntil(NOW + SHORT_FOR_MS + SETTLE_MS);
        expect(look.asked.map((asked) => asked.slug)).toEqual(["b"]);
        expect([...keeper.sleepers.slugs]).toEqual(["b"]);
        expect(keeper.sleepers.counted).toBe(1);
        expect(lines.filter((line) => line.startsWith("keeper b: put to sleep to give memory back"))).toHaveLength(1);
        expect(fake.asked).toEqual([undefined]);
    });

    test("nothing for memory while the keeper's switch is off, or this side keeps no sandbox", async () => {
        const off = setup();
        off.fake.on = false;
        await off.roundsUntil(NOW + 2 * SHORT_FOR_MS);
        expect(off.look.asked).toEqual([]);

        const none = setup();
        none.fake.records = [];
        none.fake.listing = [row("a", { keptElsewhere: "windows" }), row("b", { keptElsewhere: "windows" })];
        await none.roundsUntil(NOW + 2 * SHORT_FOR_MS);
        expect(none.look.asked).toEqual([]);
    });
});
