import type { IcRun } from "./ic-rounds.js";
import { newWatchState, runWatchRound, sweepDue, watchAnswers, watchArgs, watchNews, watchTargets } from "./probation-watch.js";

/* The watch's DECISIONS, without timers or an ic: which sandboxes each minute asks about, when the sweep runs, and
   which of ic's answers are worth a line. */

const NOW = 1_800_000_000_000;

test("the watch asks ic in JSON, about one sandbox or, for the sweep, about all of them", () => {
    expect(watchArgs("work")).toEqual(["sandbox", "watch", "work", "--json"]);
    expect(watchArgs()).toEqual(["sandbox", "watch", "--json"]);
});

test("a minute's watch covers every record naming a phase, except a sandbox this process's own flow is touching", () => {
    const records = [
        { slug: "cut", phase: "cutover", at: NOW },
        { slug: "proving", phase: "probation", at: NOW },
        { slug: "mine", phase: "cutover", at: NOW },
        { slug: "idle" },
    ];
    expect(watchTargets(records, new Set(["mine"]))).toEqual(["cut", "proving"]);
});

test("ic's answers are its JSON lines, whatever prose surrounds them", () => {
    const output = 'checking…\n{"slug":"a","action":"none"}\n{"slug":"b","action":"rolled-back","reason":"it kept crashing"}\nnot json {\n';
    expect(watchAnswers(output)).toEqual([
        { slug: "a", action: "none" },
        { slug: "b", action: "rolled-back", reason: "it kept crashing" },
    ]);
});

// Something the watch DID is always said; a state it is IN (watching, busy) is said when it begins, not every minute.
test("only news is logged: never 'none', and a standing answer once per stretch", () => {
    const last = new Map<string, string>();
    expect(watchNews([{ slug: "work", action: "watching" }], last)).toEqual(["probation watch work: watching"]);
    expect(watchNews([{ slug: "work", action: "watching" }], last)).toEqual([]);
    expect(watchNews([{ slug: "work", action: "busy" }], last)).toEqual(["probation watch work: busy"]);
    expect(watchNews([{ slug: "work", action: "kept" }, { slug: "other", action: "none" }], last)).toEqual(["probation watch work: kept"]);
    expect(watchNews([{ slug: "work", action: "restored", reason: "the new version never came up" }], last)).toEqual([
        "probation watch work: restored — the new version never came up",
    ]);
});

test("the sweep runs once it is due and no flow of this process holds a sandbox", () => {
    expect(sweepDue(NOW, NOW, new Set())).toBe(true);
    expect(sweepDue(NOW + 1, NOW, new Set())).toBe(false);
    expect(sweepDue(NOW, NOW, new Set(["work"]))).toBe(false);
});

// A fake `ic sandbox watch` that records what it was asked and answers one line per sandbox it was asked about.
const recording = (asked: (string | undefined)[], action = "none") => async (slug: string | undefined): Promise<IcRun> => {
    asked.push(slug);
    return await Promise.resolve({ code: 0, output: `${JSON.stringify({ slug: slug ?? "work", action })}\n` });
};

test("the first round after start is the sweep, and the rounds after it ask only about the records", async () => {
    const state = newWatchState(NOW - 30_000);
    const asked: (string | undefined)[] = [];
    const records = [{ slug: "work", phase: "probation", at: NOW }];
    await runWatchRound(state, records, recording(asked), () => undefined, { now: NOW, sweeps: true, busy: new Set() });
    await runWatchRound(state, records, recording(asked), () => undefined, { now: NOW + 60_000, sweeps: true, busy: new Set() });
    expect(asked).toEqual([undefined, "work"]);
    // Ten minutes after the first, the sweep is due again.
    await runWatchRound(state, records, recording(asked), () => undefined, { now: NOW + 10 * 60_000, sweeps: true, busy: new Set() });
    expect(asked).toEqual([undefined, "work", undefined]);
});

// A WSL distro sharing the PC's docker engine leaves the sweep to the root; it still watches the swaps it recorded.
test("an environment that does not sweep still watches its own records", async () => {
    const asked: (string | undefined)[] = [];
    await runWatchRound(newWatchState(NOW - 30_000), [{ slug: "work", phase: "cutover", at: NOW }], recording(asked), () => undefined, {
        now: NOW,
        sweeps: false,
        busy: new Set(),
    });
    expect(asked).toEqual(["work"]);
});

// An ic that cannot sweep (one from before `watch`, a docker that is down) is asked again less and less often.
test("a failing sweep says why and waits longer each time, and one that answers resets the wait", async () => {
    const state = newWatchState(NOW - 30_000);
    const lines: string[] = [];
    const failing = async (): Promise<IcRun> => await Promise.resolve({ code: 2, output: "error: unrecognized subcommand 'watch'" });
    const options = (now: number) => ({ now, sweeps: true, busy: new Set<string>() });
    await runWatchRound(state, [], failing, (line) => lines.push(line), options(NOW));
    await runWatchRound(state, [], failing, (line) => lines.push(line), options(NOW + 19 * 60_000));
    await runWatchRound(state, [], failing, (line) => lines.push(line), options(NOW + 20 * 60_000));
    expect(lines).toEqual([
        "probation watch: the sweep over every sandbox failed (attempt 1, next in 20 minutes) — error: unrecognized subcommand 'watch'",
        "probation watch: the sweep over every sandbox failed (attempt 2, next in 30 minutes) — error: unrecognized subcommand 'watch'",
    ]);
    await runWatchRound(state, [], recording([]), () => undefined, options(NOW + 50 * 60_000));
    expect(sweepDue(state.sweepDueAt, NOW + 60 * 60_000, new Set())).toBe(true);
});

test("what the watch did is logged in ic's words, and a failing watch backs off like every round", async () => {
    const state = newWatchState(NOW + 60 * 60_000);
    const lines: string[] = [];
    const records = [{ slug: "work", phase: "cutover", at: NOW }];
    await runWatchRound(state, records, recording([], "restored"), (line) => lines.push(line), { now: NOW, sweeps: true, busy: new Set() });
    await runWatchRound(state, records, async () => await Promise.resolve({ code: 1, output: "docker is not running" }), (line) => lines.push(line), {
        now: NOW,
        sweeps: true,
        busy: new Set(),
    });
    expect(lines).toEqual(["probation watch work: restored", "probation watch work: failed (attempt 1, retrying after 1 tick) — docker is not running"]);
});
