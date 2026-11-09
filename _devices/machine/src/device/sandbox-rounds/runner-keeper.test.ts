import type { RunnerLinkReading } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { IcRun } from "./ic-rounds.js";
import {
    judgeRunner,
    keptRunners,
    newRunnerKeeperState,
    RUNNER_DOWN_RESTART_MS,
    RUNNER_LOOK_EVERY_MS,
    RUNNER_READING_STALE_MS,
    RUNNER_WATCH_GAP_MS,
    type RunnerKeeperSeams,
    runnerRetryMs,
    runRunnerRound,
} from "./runner-keeper.js";

/* A runner on this machine is kept by its link to its parent (runner-keeper.ts). The two outages it answers, both on
   omen: runner-omen put to sleep by this keeper's own idle sweep and never woken (2026-10-31), and a runner whose
   container ran and whose daemon answered while it never dialled its parent again (2026-11-05). */

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const PARENT = "https://sandbox-a4ba63bf2aa5.sbx.intentic.dev";
const FRESH = { tries: 0, retryAt: 0 };

const reading = (at: number, fields: Partial<RunnerLinkReading> = {}): RunnerLinkReading => ({ at, parent: PARENT, state: "open", working: 0, ...fields });
const down = (at: number, fields: Partial<RunnerLinkReading> = {}): RunnerLinkReading => reading(at, { state: "connecting", since: at - MIN, failures: 3, ...fields });

test("a runner that is not running is started at once, then not again before its ladder allows", () => {
    const first = judgeRunner(false, undefined, FRESH, NOW);
    expect(first.verdict).toEqual({ kind: "start" });
    const held = judgeRunner(false, undefined, { ...first.watch, tries: 1, retryAt: NOW + runnerRetryMs(1) }, NOW + MIN);
    expect(held.verdict).toEqual({ kind: "wait" });
});

test("an open link is up and clears whatever the keeper had counted against the runner", () => {
    const { verdict, watch } = judgeRunner(true, reading(NOW), { tries: 3, retryAt: NOW + MIN, downSince: NOW - 20 * MIN, lastLook: NOW - MIN }, NOW);
    expect(verdict).toEqual({ kind: "up" });
    expect(watch).toEqual({ lastLook: NOW, tries: 0, retryAt: 0 });
});

test("a runner from before the reading is kept running but its link is not judged", () => {
    expect(judgeRunner(true, undefined, FRESH, NOW).verdict).toEqual({ kind: "unknown" });
});

test("a down link is watched for ten minutes, then the parent is asked from this machine before the runner is blamed", () => {
    let watch = judgeRunner(true, down(NOW), FRESH, NOW).watch;
    expect(watch.downSince).toBe(NOW);
    for (let at = NOW + MIN; at < NOW + RUNNER_DOWN_RESTART_MS; at += MIN) {
        const look = judgeRunner(true, down(at), watch, at);
        expect(look.verdict).toEqual({ kind: "wait" });
        watch = look.watch;
    }
    const due = NOW + RUNNER_DOWN_RESTART_MS;
    expect(judgeRunner(true, down(due), watch, due).verdict).toEqual({ kind: "ask-parent", parent: PARENT, downForMs: RUNNER_DOWN_RESTART_MS });
});

test("a gap in the watching is this machine having slept, and the runner gets the whole window again after the wake", () => {
    const before = { tries: 0, retryAt: 0, downSince: NOW - 9 * MIN, lastLook: NOW - RUNNER_WATCH_GAP_MS - 1 };
    const { verdict, watch } = judgeRunner(true, down(NOW), before, NOW);
    expect(verdict).toEqual({ kind: "wait" });
    expect(watch.downSince).toBe(NOW);
});

test("a daemon that stopped writing its reading is restarted without asking the parent", () => {
    const watch = { tries: 0, retryAt: 0, downSince: NOW - RUNNER_DOWN_RESTART_MS, lastLook: NOW - MIN };
    const stale = reading(NOW - RUNNER_READING_STALE_MS - 1);
    expect(judgeRunner(true, stale, watch, NOW).verdict).toMatchObject({ kind: "restart" });
});

test("a refused runner and one still running work are said, not restarted", () => {
    const watch = { tries: 0, retryAt: 0, downSince: NOW - RUNNER_DOWN_RESTART_MS, lastLook: NOW - MIN };
    expect(judgeRunner(true, reading(NOW, { state: "closed", revoked: true }), watch, NOW).verdict).toMatchObject({ kind: "wait", why: expect.stringContaining("refused") });
    expect(judgeRunner(true, down(NOW, { working: 1 }), watch, NOW).verdict).toMatchObject({ kind: "wait", why: expect.stringContaining("work") });
});

test("the ladder after a try that did not bring a runner back: ten minutes, doubling, never past four hours", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(runnerRetryMs)).toEqual([10, 20, 40, 80, 160, 240, 240].map((m) => m * MIN));
});

test("only this side's runners are kept, by their container", () => {
    const listed = [{ slug: "work" }, { slug: "runner-omen", container: "intentic-sandbox-runner-omen" }, { slug: "runner-theirs", keptElsewhere: "linux" }, { slug: "runner-old" }];
    expect(keptRunners(listed)).toEqual([
        { slug: "runner-omen", container: "intentic-sandbox-runner-omen" },
        { slug: "runner-old", container: "intentic-sandbox-runner-old" },
    ]);
    expect(keptRunners(undefined)).toEqual([]);
});

/* THE ROUND, over seams the test plays. */

interface Fake {
    running: boolean | undefined;
    reading: RunnerLinkReading | undefined;
    parentAnswers: boolean;
    powered: string[];
    result: IcRun;
    clock: number;
    busy: Set<string>;
}

const setup = () => {
    const fake: Fake = { running: true, reading: undefined, parentAnswers: true, powered: [], result: { code: 0, output: "" }, clock: NOW, busy: new Set() };
    const seams: RunnerKeeperSeams = {
        running: async () => await Promise.resolve(fake.running),
        reading: async () => await Promise.resolve(fake.reading),
        parentAnswers: async () => await Promise.resolve(fake.parentAnswers),
        power: async (op, slug) => {
            fake.powered.push(`${op} ${slug}`);
            return await Promise.resolve(fake.result);
        },
        busy: fake.busy,
        hold: () => () => undefined,
        now: () => fake.clock,
    };
    const state = newRunnerKeeperState(NOW);
    const lines: string[] = [];
    const rows = [{ slug: "runner-omen", container: "intentic-sandbox-runner-omen" }];
    const look = async (at: number): Promise<void> => {
        fake.clock = at;
        await runRunnerRound(state, seams, rows, (line) => void lines.push(line));
    };
    return { fake, state, lines, look };
};

test("a runner the idle sweep put to sleep is started on the next look", async () => {
    const { fake, lines, look } = setup();
    fake.running = false;
    await look(NOW);
    expect(fake.powered).toEqual(["start runner-omen"]);
    expect(lines.at(-1)).toContain("started");
});

test("a runner whose link stays down while its parent answers this machine is restarted, once per ladder rung", async () => {
    const { fake, lines, look } = setup();
    for (let at = NOW; at <= NOW + RUNNER_DOWN_RESTART_MS; at += RUNNER_LOOK_EVERY_MS) {
        fake.reading = down(at);
        await look(at);
    }
    expect(fake.powered).toEqual(["restart runner-omen"]);
    expect(lines.some((line) => line.includes("while that sandbox answers this machine"))).toBe(true);
    // Still down after the restart: nothing more until the ladder's first rung has passed.
    for (let at = NOW + RUNNER_DOWN_RESTART_MS + MIN; at < NOW + RUNNER_DOWN_RESTART_MS + runnerRetryMs(1); at += RUNNER_LOOK_EVERY_MS) {
        fake.reading = down(at);
        await look(at);
    }
    expect(fake.powered).toEqual(["restart runner-omen"]);
});

test("a runner whose parent does not answer this machine either is left dialling, and that is said once", async () => {
    const { fake, lines, look } = setup();
    fake.parentAnswers = false;
    for (let at = NOW; at <= NOW + 2 * RUNNER_DOWN_RESTART_MS; at += RUNNER_LOOK_EVERY_MS) {
        fake.reading = down(at);
        await look(at);
    }
    expect(fake.powered).toEqual([]);
    expect(lines.filter((line) => line.includes("does not answer this machine either"))).toHaveLength(1);
});

test("a runner a flow of this agent is touching is left alone, and a link that comes back is said", async () => {
    const { fake, lines, look } = setup();
    fake.running = false;
    fake.busy.add("runner-omen");
    await look(NOW);
    expect(fake.powered).toEqual([]);
    fake.busy.clear();
    await look(NOW + RUNNER_LOOK_EVERY_MS);
    expect(fake.powered).toEqual(["start runner-omen"]);
    fake.running = true;
    fake.reading = reading(NOW + 2 * RUNNER_LOOK_EVERY_MS);
    await look(NOW + 2 * RUNNER_LOOK_EVERY_MS);
    expect(lines.at(-1)).toBe("keeper runner-omen: the runner is linked to its parent again");
});

test("the round looks once a minute however often the keeper ticks", async () => {
    const { fake, look } = setup();
    fake.running = false;
    fake.result = { code: 1, output: "docker: not running" };
    await look(NOW);
    await look(NOW + 10_000);
    expect(fake.powered).toEqual(["start runner-omen"]);
});
