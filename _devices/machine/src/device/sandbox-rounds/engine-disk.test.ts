import type { IcRun } from "./ic-rounds.js";
import {
    CONSUMERS_STALE_MS,
    type DiskWatchDeps,
    type DiskWatchState,
    diskActArgs,
    diskAnswer,
    diskMeasureArgs,
    diskReadArgs,
    diskRound,
    MEASURE_RETRY_MS,
    measureDue,
    newDiskWatchState,
    RELIEVE_AGAIN_MS,
    reliefDue,
} from "./engine-disk.js";

/* The engine-disk watch's DECISIONS, with ic faked by what it answers to each command line: when it clears, when it
   tells, and the words it tells in. No timers and no ic. */

const GIB = 1024 ** 3;
const TOTAL = 1000 * GIB;
const HOUR = 60 * 60_000;

// What ic printed, exiting 0.
const said = (answer: Record<string, unknown>): IcRun => ({ code: 0, output: JSON.stringify(answer) });

// One `ic engine disk --json` answer, measured at `level` with `left` GiB left to write.
const measured = (level: string, left: number, extra: Record<string, unknown> = {}): IcRun =>
    said({ engine: "intentic", state: "measured", level, totalBytes: TOTAL, availableBytes: left * GIB, ...extra });

const CONSUMERS = [
    { kind: "volume", bytes: 430 * GIB, owner: { kind: "sandbox", id: "sandbox-a4ba63bf2aa5" }, what: "sandbox a4ba63bf2aa5's history volume" },
    { kind: "buildCache", bytes: 82 * GIB, what: "the build cache" },
    { kind: "images", bytes: 50 * GIB, owner: { kind: "sandbox", id: "sandbox-82789f4106b4" }, what: "sandbox 82789f4106b4's images" },
    { kind: "volume", bytes: 3 * GIB, owner: { kind: "compose", id: "shop" }, what: "compose project shop's volume pgdata" },
];

// ic as a table from command line to answer; each call is kept, and a line nobody wrote answers as a failure.
const fakeIc = (answers: Record<string, IcRun>) => {
    const calls: string[] = [];
    const run: DiskWatchDeps["run"] = async (args) => {
        const line = args.join(" ");
        calls.push(line);
        return await Promise.resolve(answers[line] ?? { code: 1, output: `no answer for ${line}` });
    };
    return { calls, run };
};

const watch = (answers: Record<string, IcRun>, { reliefOn = true, at = 10 * HOUR } = {}) => {
    const ic = fakeIc(answers);
    const lines: string[] = [];
    const clock = { now: at };
    const deps: DiskWatchDeps = { run: ic.run, reliefOn: async () => await Promise.resolve(reliefOn), log: (line) => lines.push(line), now: () => clock.now };
    const state = newDiskWatchState();
    return { state, deps, lines, calls: ic.calls, clock, answers, round: async (): Promise<number> => await diskRound(state, deps) };
};

const READ = diskReadArgs().join(" ");
const RELIEVE_AND_TELL = diskActArgs({ relieve: true, tell: true }).join(" ");
const RELIEVE = diskActArgs({ relieve: true, tell: false }).join(" ");
const TELL = diskActArgs({ relieve: false, tell: true }).join(" ");
const MEASURE = diskMeasureArgs().join(" ");

test("the command lines: the cheap read, relief and the kept measurement in one, and the background measurement", () => {
    expect(diskReadArgs()).toEqual(["engine", "disk", "--json"]);
    expect(diskActArgs({ relieve: true, tell: true })).toEqual(["engine", "disk", "--json", "--relieve", "--consumers", "--kept"]);
    expect(diskActArgs({ relieve: false, tell: true })).toEqual(["engine", "disk", "--json", "--consumers", "--kept"]);
    expect(diskActArgs({ relieve: true, tell: false })).toEqual(["engine", "disk", "--json", "--relieve"]);
    expect(diskMeasureArgs()).toEqual(["engine", "disk", "--json", "--consumers", "--max-age", "360"]);
});

test("ic's answer is its last line that reads as one, and a level this agent does not know reads as none", () => {
    expect(diskAnswer(`progress\n${measured("low", 80).output}\n`)).toMatchObject({ state: "measured", level: "low", availableBytes: 80 * GIB, relieved: [], failed: [] });
    expect(diskAnswer(JSON.stringify({ state: "measured", level: "dire" }))).toBeUndefined();
    expect(diskAnswer("error: unrecognized subcommand 'disk'")).toBeUndefined();
});

test("a level crossed is cleared and told once, with what takes the space and whose it is, then left alone while it stands", async () => {
    const at = 10 * HOUR;
    const disk = watch({
        [READ]: measured("low", 80),
        [RELIEVE_AND_TELL]: measured("low", 95, {
            relieved: [
                { what: "dangling build cache", bytes: 14 * GIB },
                { what: "dangling images", bytes: GIB },
            ],
            failed: [],
            before: { level: "low", availableBytes: 80 * GIB },
            consumers: CONSUMERS,
            consumersAt: at - 2 * HOUR,
        }),
    });
    expect(await disk.round()).toBe(60_000);
    expect(disk.lines).toEqual([
        "engine disk: low — 80.0 GB of 1000.0 GB left to write (8%). Cleared dangling build cache 14.0 GB, dangling images 1.0 GB: 95.0 GB left. Biggest: sandbox a4ba63bf2aa5's history volume 430.0 GB, the build cache 82.0 GB, sandbox 82789f4106b4's images 50.0 GB (measured 2 h ago).",
    ]);
    disk.clock.now += 60_000;
    await disk.round();
    expect(disk.calls).toEqual([READ, RELIEVE_AND_TELL, READ]);
    expect(disk.lines).toHaveLength(1);
});

test("a worse level is told again, critical is cleared again every quarter hour, and back to ok re-arms the word", async () => {
    const disk = watch({ [READ]: measured("critical", 40), [RELIEVE_AND_TELL]: measured("critical", 45, { consumers: CONSUMERS, consumersAt: 10 * HOUR }) });
    disk.state.told = "low";
    disk.state.relieved = "low";
    disk.state.consumersAt = 10 * HOUR;
    await disk.round();
    expect(disk.lines).toEqual([
        "engine disk: critical — 40.0 GB of 1000.0 GB left to write (4%). Biggest: sandbox a4ba63bf2aa5's history volume 430.0 GB, the build cache 82.0 GB, sandbox 82789f4106b4's images 50.0 GB (measured 1 min ago).",
    ]);
    // A quarter of an hour on, still critical: cleared again, said only because it cleared something.
    disk.clock.now += RELIEVE_AGAIN_MS;
    disk.answers[RELIEVE] = measured("critical", 43, { relieved: [{ what: "build cache", bytes: 3 * GIB }], before: { level: "critical", availableBytes: 40 * GIB } });
    await disk.round();
    disk.clock.now += 60_000;
    disk.answers[RELIEVE] = measured("critical", 43, { relieved: [{ what: "build cache", bytes: 0 }] });
    disk.clock.now += RELIEVE_AGAIN_MS;
    await disk.round();
    disk.answers[READ] = measured("ok", 150);
    await disk.round();
    disk.answers[READ] = measured("low", 90);
    disk.answers[RELIEVE_AND_TELL] = measured("low", 90, { consumers: CONSUMERS, consumersAt: disk.clock.now });
    await disk.round();
    expect(disk.lines.slice(1)).toEqual([
        "engine disk: still critical — Cleared build cache 3.0 GB: 43.0 GB left.",
        "engine disk: back to ok — 150.0 GB of 1000.0 GB left to write (15%).",
        "engine disk: low — 90.0 GB of 1000.0 GB left to write (9%). Biggest: sandbox a4ba63bf2aa5's history volume 430.0 GB, the build cache 82.0 GB, sandbox 82789f4106b4's images 50.0 GB (measured 1 min ago).",
    ]);
    expect(disk.calls).toEqual([READ, RELIEVE_AND_TELL, READ, RELIEVE, READ, RELIEVE, READ, READ, RELIEVE_AND_TELL]);
});

test("with the switch off nothing is cleared, and the word says so", async () => {
    const disk = watch({ [READ]: measured("full", 5), [TELL]: measured("full", 5, { consumers: CONSUMERS.slice(0, 1), consumersAt: 10 * HOUR }) }, { reliefOn: false });
    await disk.round();
    expect(disk.calls).toEqual([READ, TELL]);
    expect(disk.lines).toEqual([
        "engine disk: full — 5.0 GB of 1000.0 GB left to write (0%). Clearing is off here (intentic-machine updates --disk on). Biggest: sandbox a4ba63bf2aa5's history volume 430.0 GB (measured 1 min ago).",
    ]);
    expect(disk.state.relieved).toBe("ok");
});

test("a line with nothing measured yet is followed by the measurement when it lands, and a failed one is said once", async () => {
    const disk = watch({
        [READ]: measured("critical", 40),
        [RELIEVE_AND_TELL]: measured("critical", 41, { consumersUnread: "nothing has measured it on this PC yet" }),
        [MEASURE]: measured("critical", 41, { consumers: CONSUMERS, consumersAt: 10 * HOUR + 5 * 60_000 }),
    });
    await disk.round();
    await disk.state.measuring;
    expect(disk.lines).toEqual([
        "engine disk: critical — 40.0 GB of 1000.0 GB left to write (4%). What takes the space is being measured.",
        "engine disk: what takes the space: sandbox a4ba63bf2aa5's history volume 430.0 GB, the build cache 82.0 GB, sandbox 82789f4106b4's images 50.0 GB.",
    ]);
    expect(disk.state.consumersAt).toBe(10 * HOUR + 5 * 60_000);

    const failing = watch({
        [READ]: measured("low", 90),
        [RELIEVE_AND_TELL]: measured("low", 90),
        [MEASURE]: measured("low", 90, { consumersUnread: "Docker did not finish sizing the disk within 30 minutes" }),
    });
    await failing.round();
    await failing.state.measuring;
    failing.clock.now += 60_000;
    await failing.round();
    expect(failing.lines.slice(1)).toEqual(["engine disk: what takes the space could not be measured — Docker did not finish sizing the disk within 30 minutes"]);
    // Not measured again within the retry.
    expect(failing.calls.filter((line) => line === MEASURE)).toHaveLength(1);
});

test("an engine that is not this PC's, not running, or an ic that cannot read it is said once and asked again later", async () => {
    const elsewhere = watch({
        [READ]: said({ engine: "dockerDesktop", state: "notOurs", reason: "this PC's sandboxes run on Docker Desktop, whose disk ic does not watch." }),
    });
    expect(await elsewhere.round()).toBe(10 * 60_000);
    await elsewhere.round();
    expect(elsewhere.lines).toEqual(["engine disk: not watched — this PC's sandboxes run on Docker Desktop, whose disk ic does not watch."]);

    const old = watch({ [READ]: { code: 2, output: "error: unrecognized subcommand 'disk'" } });
    await old.round();
    await old.round();
    expect(old.lines).toEqual(["engine disk: ic could not read the engine's disk — error: unrecognized subcommand 'disk'"]);
});

describe("the clocks", () => {
    const state = (over: Partial<DiskWatchState>): DiskWatchState => ({ ...newDiskWatchState(), ...over });

    test("a clearing is due on a worse level, and again at critical or worse once the last is a quarter hour old", () => {
        expect(reliefDue(state({}), "low", 0)).toBe(true);
        expect(reliefDue(state({ relieved: "low", relievedAt: 0 }), "low", 10 * HOUR)).toBe(false);
        expect(reliefDue(state({ relieved: "critical", relievedAt: 0 }), "critical", RELIEVE_AGAIN_MS - 1)).toBe(false);
        expect(reliefDue(state({ relieved: "critical", relievedAt: 0 }), "critical", RELIEVE_AGAIN_MS)).toBe(true);
        expect(reliefDue(state({}), "ok", 0)).toBe(false);
    });

    test("a measurement is due once the kept one is old, never while one runs, and not again within the retry", () => {
        expect(measureDue(state({}), 0)).toBe(true);
        expect(measureDue(state({ consumersAt: 0 }), CONSUMERS_STALE_MS)).toBe(false);
        expect(measureDue(state({ consumersAt: 0 }), CONSUMERS_STALE_MS + 1)).toBe(true);
        expect(measureDue(state({ measuring: Promise.resolve() }), 0)).toBe(false);
        expect(measureDue(state({ measureTriedAt: 0 }), MEASURE_RETRY_MS - 1)).toBe(false);
    });
});
